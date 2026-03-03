const {
    getMappingsByRoleId,
    disableRoleSyncMapByIds,
    cancelPendingJobsByTargetRoleId,
    cancelPendingJobsBySourceRoleId,
    upsertRoleSnapshot,
    markRoleSnapshotDeleted,
    logRoleChange,
} = require('../utils/roleSyncDatabase');
const { sendRoleSyncAlert } = require('../services/alertService');

let _storedClient = null;

function initGuildRoleDeleteHandler(client) {
    _storedClient = client;
}

async function handleGuildRoleDeleteForSync(role) {
    if (!role || !role.guild) return;

    const guildId = role.guild.id;
    const roleId = role.id;
    const roleName = role.name || roleId;
    const roleColor = role.color || 0;

    // 先保存身份组快照（名称+颜色），再标记为已删除
    upsertRoleSnapshot(guildId, roleId, roleName, roleColor);
    markRoleSnapshotDeleted(guildId, roleId);

    // 查找所有受影响映射
    const mappings = getMappingsByRoleId(guildId, roleId);
    if (mappings.length === 0) {
        return;
    }

    const isSourceRole = mappings.some(m => m.source_guild_id === guildId && m.source_role_id === roleId);
    const isTargetRole = mappings.some(m => m.target_guild_id === guildId && m.target_role_id === roleId);

    // 禁用受影响映射
    const mapIds = mappings.map(m => m.map_id);
    const disabledCount = disableRoleSyncMapByIds(mapIds);

    // 取消待执行任务
    let cancelledJobCount = 0;
    if (isSourceRole) {
        cancelledJobCount += cancelPendingJobsBySourceRoleId(roleId);
    }
    if (isTargetRole) {
        cancelledJobCount += cancelPendingJobsByTargetRoleId(roleId);
    }

    // 审计日志
    logRoleChange({
        sourceEvent: 'guildRoleDelete',
        sourceGuildId: guildId,
        targetGuildId: null,
        userId: null,
        sourceRoleId: isSourceRole ? roleId : null,
        targetRoleId: isTargetRole ? roleId : null,
        action: 'role_deleted',
        result: 'protection_triggered',
        errorMessage: `role=${roleName}, mappings_disabled=${disabledCount}, jobs_cancelled=${cancelledJobCount}`,
    });

    console.warn(
        `[RoleSync] 🛡️ 身份组删除防护: guild=${guildId} role=${roleName}(${roleId}) ` +
        `isSource=${isSourceRole} isTarget=${isTargetRole} ` +
        `mappings_disabled=${disabledCount} jobs_cancelled=${cancelledJobCount}`
    );

    // 发送告警
    await sendRoleSyncAlert(_storedClient, {
        type: isSourceRole ? 'source_role_deleted' : 'target_role_deleted',
        guildId,
        guildName: role.guild.name,
        roleId,
        roleName,
        mappingsAffected: mappings,
        disabledCount,
        cancelledJobCount,
    });
}

async function roleSyncGuildRoleDeleteHandler(role) {
    try {
        await handleGuildRoleDeleteForSync(role);
    } catch (err) {
        console.error('[RoleSync] ❌ GuildRoleDelete handler 异常:', err);
    }
}

module.exports = {
    roleSyncGuildRoleDeleteHandler,
    initGuildRoleDeleteHandler,
};
