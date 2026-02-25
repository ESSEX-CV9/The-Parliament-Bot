const {
    initializeRoleSyncDatabase,
    bootstrapSyncLinksFromEnv,
    upsertGuild,
} = require('./utils/roleSyncDatabase');
const { startRoleSyncWorker, stopRoleSyncWorker } = require('./services/syncWorkerService');
const { startAutoReconcileScheduler, stopAutoReconcileScheduler } = require('./services/reconcileService');
const { roleSyncGuildMemberAddHandler } = require('./events/guildMemberAdd');
const { roleSyncGuildMemberRemoveHandler } = require('./events/guildMemberRemove');
const { roleSyncGuildMemberUpdateHandler } = require('./events/guildMemberUpdate');

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

    console.log('[RoleSync] ✅ 角色同步系统已启动（M0~M7）。');
}

async function stopRoleSyncSystem() {
    stopRoleSyncWorker();
    stopAutoReconcileScheduler();
}

module.exports = {
    startRoleSyncSystem,
    stopRoleSyncSystem,
    roleSyncGuildMemberAddHandler,
    roleSyncGuildMemberRemoveHandler,
    roleSyncGuildMemberUpdateHandler,
};
