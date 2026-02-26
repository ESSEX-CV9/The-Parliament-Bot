const {
    getSyncLinkById,
    listSyncLinks,
    listRoleSyncMapByLink,
    listEligibleMemberIdsForLink,
    countEligibleMembersForLink,
    enqueueSyncJob,
    logRoleChange,
} = require('../utils/roleSyncDatabase');
const { withRetry } = require('../utils/networkRetry');

const AUTO_RECONCILE_ENABLED = String(process.env.ROLE_SYNC_AUTO_RECONCILE_ENABLED || 'false').toLowerCase() === 'true';
const AUTO_RECONCILE_INTERVAL_MS = Number(process.env.ROLE_SYNC_AUTO_RECONCILE_INTERVAL_MS || 15 * 60 * 1000);
const AUTO_RECONCILE_MAX_MEMBERS_PER_LINK = Number(process.env.ROLE_SYNC_AUTO_RECONCILE_MAX_MEMBERS_PER_LINK || 20);

let autoTimer = null;
let autoRunning = false;
const reconcileCursorMap = new Map();

// 全量对账中断信号（仿照 bootstrap 的 activeBootstraps 模式）
const activeReconciles = new Map(); // key: linkId, value: { shouldStop: false }

function stopReconcile(linkId) {
    const signal = activeReconciles.get(linkId);
    if (signal) {
        signal.shouldStop = true;
        return true;
    }
    return false;
}

function isReconcileRunning(linkId) {
    return activeReconciles.has(linkId);
}

function normalizeDelay(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) {
        return 120;
    }
    return Math.max(3, Math.min(3600, Math.floor(num)));
}

function resolveLane(maxDelaySeconds) {
    return maxDelaySeconds <= 20 ? 'fast' : 'normal';
}

function resolvePriority(maxDelaySeconds) {
    return maxDelaySeconds <= 20 ? 100 : 20;
}

function resolveReconcileDirection(syncMode, conflictPolicy) {
    if (syncMode === 'disabled') {
        return 'skip';
    }

    if (syncMode === 'source_to_target') {
        return 'source_to_target';
    }

    if (syncMode === 'target_to_source') {
        return 'target_to_source';
    }

    if (syncMode === 'bidirectional') {
        if (conflictPolicy === 'source_of_truth_main' || conflictPolicy === 'bidirectional_main_priority') {
            return 'source_to_target';
        }

        if (conflictPolicy === 'manual_only' || conflictPolicy === 'bidirectional_latest') {
            return 'skip';
        }

        // 未知策略默认以 source 为准，避免震荡。
        return 'source_to_target';
    }

    return 'skip';
}

function buildJobPayload({ link, map, userId, action, direction, reason }) {
    const maxDelaySeconds = normalizeDelay(map.max_delay_seconds);

    if (direction === 'source_to_target') {
        return {
            linkId: link.link_id,
            sourceGuildId: link.source_guild_id,
            targetGuildId: link.target_guild_id,
            userId,
            sourceRoleId: map.source_role_id,
            targetRoleId: map.target_role_id,
            action,
            lane: resolveLane(maxDelaySeconds),
            priority: resolvePriority(maxDelaySeconds),
            maxAttempts: 3,
            notBeforeMs: Date.now() + 500,
            conflictPolicy: map.conflict_policy || link.default_conflict_policy || null,
            maxDelaySeconds,
            sourceEvent: reason,
        };
    }

    return {
        linkId: link.link_id,
        sourceGuildId: link.target_guild_id,
        targetGuildId: link.source_guild_id,
        userId,
        sourceRoleId: map.target_role_id,
        targetRoleId: map.source_role_id,
        action,
        lane: resolveLane(maxDelaySeconds),
        priority: resolvePriority(maxDelaySeconds),
        maxAttempts: 3,
        notBeforeMs: Date.now() + 500,
        conflictPolicy: map.conflict_policy || link.default_conflict_policy || null,
        maxDelaySeconds,
        sourceEvent: reason,
    };
}

async function reconcileLinkMember(client, linkId, userId, options = {}) {
    const reason = options.reason || 'manual_reconcile';
    const link = getSyncLinkById(linkId);
 if (!link) {
        throw new Error('link_id 不存在');
    }

    if (!link.enabled) {
        return { userId, skipped: true, reason: '链路已禁用', planned: 0 };
    }

    const sourceGuild = await withRetry(
        () => client.guilds.fetch(link.source_guild_id),
        { retries: 2, baseDelayMs: 350, label: `reconcile_source_guild_${link.source_guild_id}` }
    ).catch(() => null);
    const targetGuild = await withRetry(
        () => client.guilds.fetch(link.target_guild_id),
        { retries: 2, baseDelayMs: 350, label: `reconcile_target_guild_${link.target_guild_id}` }
    ).catch(() => null);
    if (!sourceGuild || !targetGuild) {
        throw new Error('无法访问 source/target guild');
    }

    const sourceMember = await withRetry(() => sourceGuild.members.fetch(userId), { retries: 2, baseDelayMs: 300, label: `reconcile_source_member_${userId}` }).catch(() => null);
    const targetMember = await withRetry(() => targetGuild.members.fetch(userId), { retries: 2, baseDelayMs: 300, label: `reconcile_target_member_${userId}` }).catch(() => null);
    if (!sourceMember || !targetMember) {
        return { userId, skipped: true, reason: '不在交集成员范围', planned: 0 };
    }

    const mappings = listRoleSyncMapByLink(linkId).filter((m) => m.enabled === 1);
    let planned = 0;

    for (const map of mappings) {
        const syncMode = map.sync_mode || 'source_to_target';
        const conflictPolicy = map.conflict_policy || link.default_conflict_policy || 'source_of_truth_main';
        const direction = resolveReconcileDirection(syncMode, conflictPolicy);
        if (direction === 'skip') {
            continue;
        }

        const sourceHas = sourceMember.roles.cache.has(map.source_role_id);
        const targetHas = targetMember.roles.cache.has(map.target_role_id);

        let action = null;

        if (direction === 'source_to_target') {
            if (sourceHas && !targetHas) action = 'add';
            else if (!sourceHas && targetHas) action = 'remove';
        } else if (direction === 'target_to_source') {
            if (targetHas && !sourceHas) action = 'add';
            else if (!targetHas && sourceHas) action = 'remove';
        }

        if (!action) {
            continue;
        }

        const payload = buildJobPayload({
            link,
            map,
            userId,
            action,
            direction,
            reason,
        });

        const enqueueResult = enqueueSyncJob(payload);
        if (enqueueResult.enqueued) {
            planned += 1;
        }
    }

    if (planned > 0) {
        logRoleChange({
            linkId: link.link_id,
            sourceEvent: reason,
            sourceGuildId: link.source_guild_id,
            targetGuildId: link.target_guild_id,
            userId,
            result: 'planned',
            errorMessage: `reconcile planned=${planned}`,
        });
    }

    return {
        userId,
        skipped: false,
        planned,
    };
}

async function reconcileLinkMemberWithGuilds(client, link, sourceGuild, targetGuild, userId, options = {}) {
    const reason = options.reason || 'manual_reconcile';

    if (!link.enabled) {
        return { userId, skipped: true, reason: '链路已禁用', planned: 0 };
    }

    const sourceMember = await withRetry(
        () => sourceGuild.members.fetch(userId),
        { retries: 2, baseDelayMs: 300, label: `reconcile_source_member_${userId}` }
    ).catch(() => null);
    const targetMember = await withRetry(
        () => targetGuild.members.fetch(userId),
        { retries: 2, baseDelayMs: 300, label: `reconcile_target_member_${userId}` }
    ).catch(() => null);

    if (!sourceMember || !targetMember) {
        return { userId, skipped: true, reason: '不在交集成员范围', planned: 0 };
    }

    const mappings = listRoleSyncMapByLink(link.link_id).filter((m) => m.enabled === 1);
    let planned = 0;

    for (const map of mappings) {
        const syncMode = map.sync_mode || 'source_to_target';
        const conflictPolicy = map.conflict_policy || link.default_conflict_policy || 'source_of_truth_main';
        const direction = resolveReconcileDirection(syncMode, conflictPolicy);
        if (direction === 'skip') {
            continue;
        }

        const sourceHas = sourceMember.roles.cache.has(map.source_role_id);
        const targetHas = targetMember.roles.cache.has(map.target_role_id);

        let action = null;

        if (direction === 'source_to_target') {
            if (sourceHas && !targetHas) action = 'add';
            else if (!sourceHas && targetHas) action = 'remove';
        } else if (direction === 'target_to_source') {
            if (targetHas && !sourceHas) action = 'add';
            else if (!targetHas && sourceHas) action = 'remove';
        }

        if (!action) {
            continue;
        }

        const payload = buildJobPayload({ link, map, userId, action, direction, reason });
        const enqueueResult = enqueueSyncJob(payload);
        if (enqueueResult.enqueued) {
            planned += 1;
        }
    }

    if (planned > 0) {
        logRoleChange({
            linkId: link.link_id,
            sourceEvent: reason,
            sourceGuildId: link.source_guild_id,
            targetGuildId: link.target_guild_id,
            userId,
            result: 'planned',
            errorMessage: `reconcile planned=${planned}`,
        });
    }

    return { userId, skipped: false, planned };
}

async function reconcileLinkMembersFull(client, linkId, options = {}) {
    const link = getSyncLinkById(linkId);
    if (!link) {
        throw new Error('link_id 不存在');
    }
    if (!link.enabled) {
        throw new Error('链路已禁用');
    }
    if (activeReconciles.has(linkId)) {
        throw new Error('该链路已有全量对账正在运行');
    }

    const batchSize = Math.max(1, Number(options.batchSize || 50));
    const memberDelayMs = Math.max(0, Number(options.memberDelayMs ?? 200));
    const batchDelayMs = Math.max(0, Number(options.batchDelayMs ?? 2000));
    const reason = options.reason || 'manual_reconcile_full';
    const onProgress = options.onProgress || (() => {});

    const signal = { shouldStop: false };
    activeReconciles.set(linkId, signal);

    let sourceGuild, targetGuild;
    try {
        sourceGuild = await withRetry(
            () => client.guilds.fetch(link.source_guild_id),
            { retries: 2, baseDelayMs: 350, label: 'reconcile_full_source_guild' }
        );
        targetGuild = await withRetry(
            () => client.guilds.fetch(link.target_guild_id),
            { retries: 2, baseDelayMs: 350, label: 'reconcile_full_target_guild' }
        );
    } catch (err) {
        activeReconciles.delete(linkId);
        throw new Error(`无法访问 source/target guild: ${err.message}`);
    }

    const totalEligible = countEligibleMembersForLink(link.source_guild_id, link.target_guild_id);
    let offset = Math.max(0, Number(options.offset || 0));
    let processed = 0;
    let skipped = 0;
    let planned = 0;
    let failed = 0;
    const failures = [];
    let aborted = false;

    try {
        while (true) {
            if (signal.shouldStop) {
                aborted = true;
                break;
            }

            const userIds = listEligibleMemberIdsForLink(
                link.source_guild_id, link.target_guild_id,
                batchSize, offset
            );
            if (userIds.length === 0) break;

            for (const userId of userIds) {
                if (signal.shouldStop) {
                    aborted = true;
                    break;
                }

                try {
                    const row = await reconcileLinkMemberWithGuilds(
                        client, link, sourceGuild, targetGuild,
                        userId, { reason }
                    );
                    processed += 1;
                    if (row.skipped) {
                        skipped += 1;
                    } else {
                        planned += row.planned;
                    }
                } catch (err) {
                    failed += 1;
                    if (failures.length < 50) {
                        failures.push({ userId, error: err.message || String(err) });
                    }
                }

                onProgress({
                    totalEligible,
                    processed,
                    skipped,
                    planned,
                    failed,
                    currentOffset: offset,
                    aborted: false,
                });

                if (memberDelayMs > 0) {
                    await new Promise((r) => setTimeout(r, memberDelayMs));
                }
            }

            offset += userIds.length;

            if (!signal.shouldStop && userIds.length === batchSize && batchDelayMs > 0) {
                await new Promise((r) => setTimeout(r, batchDelayMs));
            }
        }
    } finally {
        activeReconciles.delete(linkId);
    }

    return {
        linkId,
        totalEligible,
        processed,
        skipped,
        planned,
        failed,
        failures,
        aborted,
    };
}

async function reconcileLinkMembersBatch(client, linkId, options = {}) {
    const link = getSyncLinkById(linkId);
    if (!link) {
        throw new Error('link_id 不存在');
    }

    const maxMembers = Math.max(1, Number(options.maxMembers || 50));
    const offset = Math.max(0, Number(options.offset || 0));
    const reason = options.reason || 'manual_reconcile_batch';
    const onProgress = options.onProgress || (() => {});

    const totalEligible = countEligibleMembersForLink(link.source_guild_id, link.target_guild_id);
    const userIds = listEligibleMemberIdsForLink(link.source_guild_id, link.target_guild_id, maxMembers, offset);

    let processed = 0;
    let skipped = 0;
    let planned = 0;
    let failed = 0;
    const failures = [];

    for (const userId of userIds) {
        try {
            const row = await reconcileLinkMember(client, linkId, userId, { reason });
            processed += 1;
            if (row.skipped) {
                skipped += 1;
            } else {
                planned += row.planned;
            }
        } catch (err) {
            failed += 1;
            failures.push({ userId, error: err.message || String(err) });
        }

        onProgress({ totalEligible, scanned: userIds.length, processed, skipped, planned, failed });
    }

    return {
        linkId,
        totalEligible,
        offset,
        scanned: userIds.length,
        processed,
        skipped,
        planned,
        failed,
        failures,
        nextOffset: userIds.length > 0 ? offset + userIds.length : offset,
    };
}

async function runAutoReconcileOnce(client) {
    if (autoRunning) {
        return { skipped: true, reason: 'auto_reconcile_running' };
    }

    autoRunning = true;
    try {
        const links = listSyncLinks().filter((link) => Number(link.enabled) === 1);
        const summary = [];

        for (const link of links) {
            const totalEligible = countEligibleMembersForLink(link.source_guild_id, link.target_guild_id);
            if (totalEligible <= 0) {
                summary.push({ linkId: link.link_id, scanned: 0, planned: 0, skipped: true, reason: 'no_eligible_members' });
                continue;
            }

            let offset = reconcileCursorMap.get(link.link_id) || 0;
            if (offset >= totalEligible) {
                offset = 0;
            }

            const result = await reconcileLinkMembersBatch(client, link.link_id, {
                maxMembers: AUTO_RECONCILE_MAX_MEMBERS_PER_LINK,
                offset,
                reason: 'auto_reconcile',
            });

            const next = result.nextOffset >= totalEligible ? 0 : result.nextOffset;
            reconcileCursorMap.set(link.link_id, next);

            summary.push({
                linkId: link.link_id,
                scanned: result.scanned,
                planned: result.planned,
                failed: result.failed,
                totalEligible,
                cursor: next,
            });
        }

        return {
            skipped: false,
            summary,
        };
    } finally {
        autoRunning = false;
    }
}

function startAutoReconcileScheduler(client) {
    if (!AUTO_RECONCILE_ENABLED) {
        console.log('[RoleSync] ℹ️ 自动对账未启用（ROLE_SYNC_AUTO_RECONCILE_ENABLED=false）。');
        return;
    }

    if (autoTimer) {
        return;
    }

    autoTimer = setInterval(() => {
        runAutoReconcileOnce(client)
            .then((res) => {
                if (res?.skipped) {
                    return;
                }
                console.log(`[RoleSync] ♻️ 自动对账完成: ${JSON.stringify(res.summary)}`);
            })
            .catch((err) => {
                console.error('[RoleSync] ❌ 自动对账异常:', err);
            });
    }, AUTO_RECONCILE_INTERVAL_MS);

    console.log(`[RoleSync] ✅ 自动对账已启动，间隔=${AUTO_RECONCILE_INTERVAL_MS}ms，每链路每轮最多=${AUTO_RECONCILE_MAX_MEMBERS_PER_LINK}成员。`);
}

function stopAutoReconcileScheduler() {
    if (autoTimer) {
        clearInterval(autoTimer);
        autoTimer = null;
    }
}

function getAutoReconcileStatus() {
    return {
        enabled: AUTO_RECONCILE_ENABLED,
        running: !!autoTimer,
        intervalMs: AUTO_RECONCILE_INTERVAL_MS,
        maxMembersPerLink: AUTO_RECONCILE_MAX_MEMBERS_PER_LINK,
        cursors: Object.fromEntries(reconcileCursorMap.entries()),
    };
}

module.exports = {
    reconcileLinkMember,
    reconcileLinkMembersBatch,
    reconcileLinkMembersFull,
    stopReconcile,
    isReconcileRunning,
    runAutoReconcileOnce,
    startAutoReconcileScheduler,
    stopAutoReconcileScheduler,
    getAutoReconcileStatus,
};
