const { initializeControlledInviteDatabase } = require('./utils/controlledInviteDatabase');
const runtimeConfig = require('./utils/runtimeConfig');
const { startCleanupScheduler } = require('./services/cleanupScheduler');
const { startCodeHealthChecker } = require('./services/codeHealthChecker');
const { controlledInviteGuildMemberAddHandler } = require('./events/guildMemberAdd');
const { startControlledInviteMetricsReporter } = require('./services/metricsService');
const { handleInviteRequest } = require('./services/inviteService');

async function startControlledInviteSystem(client) {
    initializeControlledInviteDatabase();
    runtimeConfig.loadAll();
    startCleanupScheduler(client);
    startCodeHealthChecker(client);
    startControlledInviteMetricsReporter(client);
    console.log('[ControlledInvite] ✅ 分服受控邀请系统已启动');
}

module.exports = {
    startControlledInviteSystem,
    controlledInviteGuildMemberAddHandler,
    handleInviteRequest,
};
