const {
    initializeRoleSyncDatabase,
    bootstrapSyncLinksFromEnv,
    upsertGuild,
    getMappingsByRoleId,
    disableRoleSyncMapByIds,
    cancelPendingJobsBySourceRoleId,
    getRoleSnapshot,
    markRoleSnapshotDeleted,
} = require('./utils/roleSyncDatabase');
const { startRoleSyncWorker, stopRoleSyncWorker } = require('./services/syncWorkerService');
const { startAutoReconcileScheduler, stopAutoReconcileScheduler } = require('./services/reconcileService');
const { startDashboard, stopDashboard } = require('./dashboard/server');
const { roleSyncGuildMemberAddHandler } = require('./events/guildMemberAdd');
const { roleSyncGuildMemberRemoveHandler } = require('./events/guildMemberRemove');
const { roleSyncGuildMemberUpdateHandler } = require('./events/guildMemberUpdate');
const { roleSyncGuildRoleDeleteHandler, initGuildRoleDeleteHandler } = require('./events/guildRoleDelete');
const { setCircuitBreakerAlertCallback } = require('./services/syncPlannerService');
const { sendRoleSyncAlert } = require('./services/alertService');

async function warmupGuildRegistry(client) {
    const guilds = Array.from(client.guilds.cache.values());
    for (const guild of guilds) {
        upsertGuild(guild.id, guild.name, 0);
    }
}

async function startRoleSyncSystem(client) {
    initializeRoleSyncDatabase();
    await warmupGuildRegistry(client);
    bootstrapSyncLinksFromEnv();
    startRoleSyncWorker(client);
    startAutoReconcileScheduler(client);
    startDashboard(client);

    // 角色删除防护：注入 client 引用 + 熔断器告警回调
    initGuildRoleDeleteHandler(client);
    setCircuitBreakerAlertCallback(async ({ targetRoleId, sourceGuildId, sourceRoleId, targetGuildId, linkId, windowMs, threshold }) => {
        // 1. 先发熔断告警（保持原有行为）
        await sendRoleSyncAlert(client, {
            type: 'circuit_breaker_tripped',
            roleId: targetRoleId,
            roleName: targetRoleId,
            guildId: sourceGuildId || 'unknown',
            guildName: 'unknown',
            mappingsAffected: null,
            disabledCount: 0,
            cancelledJobCount: 0,
        });

        // 2. 自动检测：源角色是否已被删除？
        if (sourceGuildId && sourceRoleId) {
            try {
                const guild = await client.guilds.fetch(sourceGuildId).catch(() => null);
                if (!guild) return;
                const role = await guild.roles.fetch(sourceRoleId).catch(() => null);
                if (role) return; // 角色还在，不是删除导致的，只是正常熔断

                // 角色已不存在 → 执行与 guildRoleDelete 相同的保护逻辑
                console.warn(`[RoleSync] ⚡ 熔断器检测到源角色已删除: guild=${sourceGuildId} role=${sourceRoleId}`);

                const snapshot = getRoleSnapshot(sourceGuildId, sourceRoleId);
                const roleName = snapshot?.role_name || sourceRoleId;

                markRoleSnapshotDeleted(sourceGuildId, sourceRoleId);

                const mappings = getMappingsByRoleId(sourceGuildId, sourceRoleId);
                if (mappings.length > 0) {
                    const mapIds = mappings.map(m => m.map_id);
                    const disabledCount = disableRoleSyncMapByIds(mapIds);
                    const cancelledJobs = cancelPendingJobsBySourceRoleId(sourceRoleId);

                    await sendRoleSyncAlert(client, {
                        type: 'source_role_deleted',
                        guildId: sourceGuildId,
                        guildName: guild.name,
                        roleId: sourceRoleId,
                        roleName,
                        mappingsAffected: mappings,
                        disabledCount,
                        cancelledJobCount: cancelledJobs,
                    });
                }
            } catch (err) {
                console.error('[RoleSync] ❌ 熔断器角色检测异常:', err);
            }
        }
    });

    console.log('[RoleSync] ✅ 角色同步系统已启动（M0~M7），角色删除防护已激活。');
}

async function stopRoleSyncSystem() {
    stopRoleSyncWorker();
    stopAutoReconcileScheduler();
    stopDashboard();
}

module.exports = {
    startRoleSyncSystem,
    stopRoleSyncSystem,
    roleSyncGuildMemberAddHandler,
    roleSyncGuildMemberRemoveHandler,
    roleSyncGuildMemberUpdateHandler,
    roleSyncGuildRoleDeleteHandler,
};
