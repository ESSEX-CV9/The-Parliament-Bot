const crypto = require('crypto');

const {
    getApplicableRoleMappings,
    enqueueSyncJob,
    consumeOperationMark,
    logRoleChange,
    upsertGuildMemberPresence,
    extractRolesJson,
    getRoleSyncSetting,
} = require('../utils/roleSyncDatabase');

// ─── 熔断器：检测异常 remove 操作量 ───
const ENV_CB_WINDOW_MS = Number(process.env.ROLE_SYNC_CB_WINDOW_MS) || 10000;
const ENV_CB_THRESHOLD = Number(process.env.ROLE_SYNC_CB_THRESHOLD) || 10;
const ENV_CB_BLOCK_MS  = Number(process.env.ROLE_SYNC_CB_BLOCK_MS) || 5 * 60 * 1000;

function getCbWindowMs() { return Number(getRoleSyncSetting('cb_window_ms', ENV_CB_WINDOW_MS)); }
function getCbThreshold() { return Number(getRoleSyncSetting('cb_threshold', ENV_CB_THRESHOLD)); }
function getCbBlockMs() { return Number(getRoleSyncSetting('cb_block_ms', ENV_CB_BLOCK_MS)); }

// Map<targetRoleId, { timestamps: number[], trippedAt: number|null }>
const circuitBreakerState = new Map();
let _circuitBreakerAlertCallback = null;

function setCircuitBreakerAlertCallback(fn) {
    _circuitBreakerAlertCallback = fn;
}

function isCircuitBreakerTripped(targetRoleId) {
    const state = circuitBreakerState.get(targetRoleId);
    if (!state || state.trippedAt === null) return false;
    if (Date.now() - state.trippedAt > getCbBlockMs()) {
        circuitBreakerState.delete(targetRoleId);
        return false;
    }
    return true;
}

function recordCircuitBreakerRemove(targetRoleId) {
    const now = Date.now();
    let state = circuitBreakerState.get(targetRoleId);
    if (!state) {
        state = { timestamps: [], trippedAt: null };
        circuitBreakerState.set(targetRoleId, state);
    }
    state.timestamps = state.timestamps.filter(t => now - t < getCbWindowMs());
    state.timestamps.push(now);

    if (state.timestamps.length >= getCbThreshold() && state.trippedAt === null) {
        state.trippedAt = now;
        return true; // just tripped
    }
    return false;
}

function resetCircuitBreaker(targetRoleId) {
    circuitBreakerState.delete(targetRoleId);
}

function getLaneByDelay(maxDelaySeconds) {
    return maxDelaySeconds <= 20 ? 'fast' : 'normal';
}

function getPriorityByDelay(maxDelaySeconds) {
    return maxDelaySeconds <= 20 ? 100 : 20;
}

function getDebounceByDelay(maxDelaySeconds) {
    if (maxDelaySeconds <= 20) return 1500;
    const debounce = 2000 + ((maxDelaySeconds - 21) / (60 - 21)) * (25000 - 2000);
    return Math.min(25000, Math.round(debounce));
}

function normalizeDelay(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) {
        return 120;
    }
    return Math.max(3, Math.min(3600, Math.floor(num)));
}

function shouldPropagateBySyncMode({ eventFromSource, syncMode }) {
    if (syncMode === 'disabled') return false;

    if (eventFromSource) {
        return syncMode === 'source_to_target' || syncMode === 'bidirectional';
    }

    return syncMode === 'target_to_source' || syncMode === 'bidirectional';
}

function buildOperationId() {
    return `rs_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

function getRoleDiff(oldMember, newMember) {
    const oldSet = new Set(oldMember.roles.cache.keys());
    const newSet = new Set(newMember.roles.cache.keys());

    // 过滤 @everyone
    oldSet.delete(oldMember.guild.id);
    newSet.delete(newMember.guild.id);

    const added = [];
    const removed = [];

    for (const roleId of newSet) {
        if (!oldSet.has(roleId)) {
            added.push(roleId);
        }
    }

    for (const roleId of oldSet) {
        if (!newSet.has(roleId)) {
            removed.push(roleId);
        }
    }

    return { added, removed };
}

async function planRoleChangeForMappings({ guildId, userId, roleId, action }) {
    const consumed = consumeOperationMark({ guildId, userId, roleId, action });
    if (consumed) {
        return { skippedByMark: 1, enqueued: 0 };
    }

    const mappings = getApplicableRoleMappings(guildId, roleId);
    if (!mappings || mappings.length === 0) {
        return { skippedByMark: 0, enqueued: 0 };
    }

    let enqueuedCount = 0;

    for (const map of mappings) {
        const eventFromSource = map.source_guild_id === guildId && map.source_role_id === roleId;
        const eventFromTarget = map.target_guild_id === guildId && map.target_role_id === roleId;

        if (!eventFromSource && !eventFromTarget) {
            continue;
        }

        const syncMode = map.sync_mode || 'source_to_target';
        if (!shouldPropagateBySyncMode({ eventFromSource, syncMode })) {
            continue;
        }

        const sourceGuildId = guildId;
        const targetGuildId = eventFromSource ? map.target_guild_id : map.source_guild_id;
        const sourceRoleId = roleId;
        const targetRoleId = eventFromSource ? map.target_role_id : map.source_role_id;

        const maxDelaySeconds = normalizeDelay(map.max_delay_seconds);

        // 熔断器：检测异常 remove 操作量
        if (action === 'remove') {
            if (isCircuitBreakerTripped(targetRoleId)) {
                logRoleChange({
                    linkId: map.link_id,
                    sourceEvent: 'circuit_breaker_blocked',
                    sourceGuildId,
                    targetGuildId,
                    userId,
                    sourceRoleId,
                    targetRoleId,
                    action,
                    result: 'skipped',
                    errorMessage: 'circuit_breaker_tripped',
                });
                continue;
            }
            const justTripped = recordCircuitBreakerRemove(targetRoleId);
            if (justTripped) {
                console.warn(`[RoleSync] ⚡ 熔断器触发: targetRoleId=${targetRoleId}, ${getCbThreshold()} 次 remove 在 ${getCbWindowMs()}ms 内`);
                _circuitBreakerAlertCallback?.({
                    targetRoleId,
                    sourceGuildId,
                    sourceRoleId,
                    targetGuildId,
                    linkId: map.link_id,
                    windowMs: getCbWindowMs(),
                    threshold: getCbThreshold(),
                });
            }
        }

        const result = enqueueSyncJob({
            linkId: map.link_id,
            operationId: buildOperationId(),
            sourceGuildId,
            targetGuildId,
            userId,
            sourceRoleId,
            targetRoleId,
            action,
            lane: getLaneByDelay(maxDelaySeconds),
            priority: getPriorityByDelay(maxDelaySeconds),
            maxAttempts: 3,
            notBeforeMs: Date.now() + getDebounceByDelay(maxDelaySeconds),
            conflictPolicy: map.conflict_policy || null,
            maxDelaySeconds,
            sourceEvent: 'guildMemberUpdate',
        });

        if (result.enqueued) {
            enqueuedCount += 1;
            logRoleChange({
                linkId: map.link_id,
                sourceEvent: 'guildMemberUpdate',
                sourceGuildId,
                targetGuildId,
                userId,
                sourceRoleId,
                targetRoleId,
                action,
                result: 'planned',
            });
        }
    }

    return { skippedByMark: 0, enqueued: enqueuedCount };
}

async function handleGuildMemberUpdateForSync(oldMember, newMember) {
    if (!newMember || !newMember.guild || !newMember.user) {
        return;
    }

    // 刷新成员存在状态 + 身份组快照
    const rolesJson = extractRolesJson(newMember.roles.cache, newMember.guild.id);
    upsertGuildMemberPresence(newMember.guild.id, newMember.user.id, {
        isActive: true,
        joinedAt: newMember.joinedAt ? newMember.joinedAt.toISOString() : null,
        leftAt: null,
        rolesJson,
    });

    // 一般不处理机器人身份组同步，避免跨服 bot 权限副作用
    if (newMember.user.bot) {
        return;
    }

    const { added, removed } = getRoleDiff(oldMember, newMember);
    if (added.length === 0 && removed.length === 0) {
        return;
    }

    let totalEnqueued = 0;

    for (const roleId of added) {
        const result = await planRoleChangeForMappings({
            guildId: newMember.guild.id,
            userId: newMember.user.id,
            roleId,
            action: 'add',
        });
        totalEnqueued += result.enqueued;
    }

    for (const roleId of removed) {
        const result = await planRoleChangeForMappings({
            guildId: newMember.guild.id,
            userId: newMember.user.id,
            roleId,
            action: 'remove',
        });
        totalEnqueued += result.enqueued;
    }

    // Individual planned log entries are now recorded per-job in planRoleChangeForMappings
}

module.exports = {
    handleGuildMemberUpdateForSync,
    setCircuitBreakerAlertCallback,
    resetCircuitBreaker,
};
