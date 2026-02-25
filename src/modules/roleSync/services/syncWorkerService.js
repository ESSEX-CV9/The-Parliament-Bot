const {
    getDueSyncJobs,
    getDueSyncJobsByLane,
    claimSyncJob,
    completeSyncJob,
    rescheduleSyncJob,
    addOperationMark,
    logRoleChange,
    pruneExpiredOperationMarks,
    pruneOldChangeLogs,
    getSyncJobCountByStatus,
    getSyncJobCountByLane,
} = require('../utils/roleSyncDatabase');
const { ensureMemberExistsInGuild } = require('./eligibilityService');
const { withRetry, isNetworkError } = require('../utils/networkRetry');

let workerTimer = null;
let maintenanceTimer = null;
let isWorking = false;

const WORKER_INTERVAL_MS = Number(process.env.ROLE_SYNC_WORKER_INTERVAL_MS || 3000);
const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;
const WORKER_BATCH_SIZE = Number(process.env.ROLE_SYNC_WORKER_BATCH_SIZE || 20);
const WORKER_FAST_BATCH_SIZE = Number(process.env.ROLE_SYNC_WORKER_FAST_BATCH_SIZE || Math.max(5, Math.floor(WORKER_BATCH_SIZE * 0.7)));
const WORKER_NORMAL_BATCH_SIZE = Number(process.env.ROLE_SYNC_WORKER_NORMAL_BATCH_SIZE || Math.max(5, WORKER_BATCH_SIZE));

async function executeJob(client, job) {
    const reasonPrefix = '[RoleSync]';

    const memberExists = await ensureMemberExistsInGuild(client, job.target_guild_id, job.user_id);
    if (!memberExists) {
        completeSyncJob(job.job_id, 'cancelled', 'target_member_not_found');
        logRoleChange({
            operationId: job.operation_id,
            jobId: job.job_id,
            linkId: job.link_id,
            sourceEvent: job.source_event,
            sourceGuildId: job.source_guild_id,
            targetGuildId: job.target_guild_id,
            userId: job.user_id,
            sourceRoleId: job.source_role_id,
            targetRoleId: job.target_role_id,
            action: job.action,
            result: 'skipped',
            errorMessage: '目标服务器不存在该成员（不在交集范围）',
        });
        return;
    }

    const guild = await withRetry(
        () => client.guilds.fetch(job.target_guild_id),
        { retries: 2, baseDelayMs: 350, label: `worker_fetch_guild_${job.target_guild_id}` }
    ).catch(() => null);
    if (!guild) {
        throw new Error('target_guild_unreachable');
    }

    const member = await withRetry(
        () => guild.members.fetch(job.user_id),
        { retries: 2, baseDelayMs: 300, label: `worker_fetch_member_${job.user_id}` }
    ).catch(() => null);
    if (!member) {
        throw new Error('target_member_fetch_failed');
    }

    const role = await withRetry(
        () => guild.roles.fetch(job.target_role_id),
        { retries: 2, baseDelayMs: 300, label: `worker_fetch_role_${job.target_role_id}` }
    ).catch(() => null);
    if (!role) {
        completeSyncJob(job.job_id, 'failed', 'target_role_not_found');
        logRoleChange({
            operationId: job.operation_id,
            jobId: job.job_id,
            linkId: job.link_id,
            sourceEvent: job.source_event,
            sourceGuildId: job.source_guild_id,
            targetGuildId: job.target_guild_id,
            userId: job.user_id,
            sourceRoleId: job.source_role_id,
            targetRoleId: job.target_role_id,
            action: job.action,
            result: 'failed',
            errorMessage: '目标服务器缺少映射身份组（需先创建或重新映射）',
        });
        return;
    }

    const hasRole = member.roles.cache.has(job.target_role_id);

    if (job.action === 'add') {
        if (hasRole) {
            completeSyncJob(job.job_id, 'completed', null);
            logRoleChange({
                operationId: job.operation_id,
                jobId: job.job_id,
                linkId: job.link_id,
                sourceEvent: job.source_event,
                sourceGuildId: job.source_guild_id,
                targetGuildId: job.target_guild_id,
                userId: job.user_id,
                sourceRoleId: job.source_role_id,
                targetRoleId: job.target_role_id,
                action: job.action,
                result: 'noop',
                errorMessage: '目标成员已具备该身份组',
            });
            return;
        }

        await withRetry(
            () => member.roles.add(job.target_role_id, `${reasonPrefix} link=${job.link_id}`),
            { retries: 2, baseDelayMs: 450, label: `worker_add_role_${job.target_role_id}` }
        );
    } else {
        if (!hasRole) {
            completeSyncJob(job.job_id, 'completed', null);
            logRoleChange({
                operationId: job.operation_id,
                jobId: job.job_id,
                linkId: job.link_id,
                sourceEvent: job.source_event,
                sourceGuildId: job.source_guild_id,
                targetGuildId: job.target_guild_id,
                userId: job.user_id,
                sourceRoleId: job.source_role_id,
                targetRoleId: job.target_role_id,
                action: job.action,
                result: 'noop',
                errorMessage: '目标成员未具备该身份组',
            });
            return;
        }

        await withRetry(
            () => member.roles.remove(job.target_role_id, `${reasonPrefix} link=${job.link_id}`),
            { retries: 2, baseDelayMs: 450, label: `worker_remove_role_${job.target_role_id}` }
        );
    }

    addOperationMark({
        guildId: job.target_guild_id,
        userId: job.user_id,
        roleId: job.target_role_id,
        action: job.action,
        ttlMs: 30000,
    });

    completeSyncJob(job.job_id, 'completed', null);

    logRoleChange({
        operationId: job.operation_id,
        jobId: job.job_id,
        linkId: job.link_id,
        sourceEvent: job.source_event,
        sourceGuildId: job.source_guild_id,
        targetGuildId: job.target_guild_id,
        userId: job.user_id,
        sourceRoleId: job.source_role_id,
        targetRoleId: job.target_role_id,
        action: job.action,
        result: 'success',
    });
}

function getBackoffMs(attemptCount) {
    const base = 5000;
    const value = base * Math.pow(2, Math.max(0, attemptCount - 1));
    return Math.min(value, 5 * 60 * 1000);
}

async function processSyncQueueOnce(client) {
    if (isWorking) {
        return;
    }

    isWorking = true;
    try {
        let jobs = [];
        const fastJobs = getDueSyncJobsByLane('fast', WORKER_FAST_BATCH_SIZE);

        if (fastJobs.length > 0) {
            jobs.push(...fastJobs);
        }

        if (jobs.length < WORKER_BATCH_SIZE) {
            const normalNeed = Math.min(WORKER_NORMAL_BATCH_SIZE, WORKER_BATCH_SIZE - jobs.length);
            const normalJobs = getDueSyncJobsByLane('normal', normalNeed);
            jobs.push(...normalJobs);
        }

        if (jobs.length < WORKER_BATCH_SIZE) {
            const fallback = getDueSyncJobs(WORKER_BATCH_SIZE - jobs.length);
            const existing = new Set(jobs.map((it) => it.job_id));
            for (const item of fallback) {
                if (!existing.has(item.job_id)) {
                    jobs.push(item);
                }
            }
        }

        if (jobs.length === 0) {
            return;
        }

        for (const job of jobs) {
            const claimed = claimSyncJob(job.job_id);
            if (!claimed) {
                continue;
            }

            try {
                await executeJob(client, job);
            } catch (err) {
                const attempt = (job.attempt_count || 0) + 1;
                const maxAttempts = job.max_attempts || 3;
                const message = err?.message || String(err);

                const maxAttemptsForError = isNetworkError(err)
                    ? Math.max(maxAttempts, 5)
                    : maxAttempts;

                if (attempt >= maxAttemptsForError) {
                    completeSyncJob(job.job_id, 'failed', message);

                    logRoleChange({
                        operationId: job.operation_id,
                        jobId: job.job_id,
                        linkId: job.link_id,
                        sourceEvent: job.source_event,
                        sourceGuildId: job.source_guild_id,
                        targetGuildId: job.target_guild_id,
                        userId: job.user_id,
                        sourceRoleId: job.source_role_id,
                        targetRoleId: job.target_role_id,
                        action: job.action,
                        result: 'failed',
                        errorMessage: message,
                    });
                } else {
                    const retryAttempt = Math.max(1, attempt);
                    const networkPenalty = isNetworkError(err) ? 3000 : 0;
                    rescheduleSyncJob(
                        job.job_id,
                        message,
                        getBackoffMs(retryAttempt) + networkPenalty
                    );
                }
            }
        }
    } finally {
        isWorking = false;
    }
}

function runMaintenance() {
    const removedMarks = pruneExpiredOperationMarks();
    const removedLogs = pruneOldChangeLogs(90);
    const stats = getSyncJobCountByStatus();
    const laneStats = getSyncJobCountByLane();

    console.log(`[RoleSync] 🧹 维护任务: 清理mark=${removedMarks}, 清理日志=${removedLogs}, 队列状态=${JSON.stringify(stats)}, 分通道=${JSON.stringify(laneStats)}`);
}

function startRoleSyncWorker(client) {
    if (workerTimer) {
        return;
    }

    workerTimer = setInterval(() => {
        processSyncQueueOnce(client).catch((err) => {
            console.error('[RoleSync] ❌ 队列处理异常:', err);
        });
    }, WORKER_INTERVAL_MS);

    maintenanceTimer = setInterval(() => {
        try {
            runMaintenance();
        } catch (err) {
            console.error('[RoleSync] ❌ 维护任务异常:', err);
        }
    }, MAINTENANCE_INTERVAL_MS);

    console.log(`[RoleSync] ✅ 同步 worker 已启动，间隔 ${WORKER_INTERVAL_MS}ms，总批次 ${WORKER_BATCH_SIZE}，fast=${WORKER_FAST_BATCH_SIZE}，normal=${WORKER_NORMAL_BATCH_SIZE}。`);
}

function stopRoleSyncWorker() {
    if (workerTimer) {
        clearInterval(workerTimer);
        workerTimer = null;
    }

    if (maintenanceTimer) {
        clearInterval(maintenanceTimer);
        maintenanceTimer = null;
    }

    console.log('[RoleSync] 🛑 同步 worker 已停止。');
}

module.exports = {
    startRoleSyncWorker,
    stopRoleSyncWorker,
    processSyncQueueOnce,
};
