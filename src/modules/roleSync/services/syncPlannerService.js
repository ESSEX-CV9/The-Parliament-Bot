const crypto = require('crypto');

const {
    getApplicableRoleMappings,
    enqueueSyncJob,
    consumeOperationMark,
    logRoleChange,
    upsertGuildMemberPresence,
    extractRolesJson,
} = require('../utils/roleSyncDatabase');

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

    if (totalEnqueued > 0) {
        logRoleChange({
            sourceEvent: 'guildMemberUpdate',
            sourceGuildId: newMember.guild.id,
            userId: newMember.user.id,
            result: 'planned',
            errorMessage: `已入队任务数: ${totalEnqueued}`,
        });
    }
}

module.exports = {
    handleGuildMemberUpdateForSync,
};
