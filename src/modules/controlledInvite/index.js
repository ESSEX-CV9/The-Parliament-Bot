const { initializeControlledInviteDatabase } = require('./utils/controlledInviteDatabase');
const { startCleanupScheduler } = require('./services/cleanupScheduler');
const { startCodeHealthChecker } = require('./services/codeHealthChecker');
const { controlledInviteGuildMemberAddHandler } = require('./events/guildMemberAdd');
const { handleInviteRequest } = require('./services/inviteService');

async function startControlledInviteSystem(client) {
    initializeControlledInviteDatabase();
    startCleanupScheduler(client);
    startCodeHealthChecker(client);
    console.log('[ControlledInvite] ✅ 分服受控邀请系统已启动');
}

module.exports = {
    startControlledInviteSystem,
    controlledInviteGuildMemberAddHandler,
    handleInviteRequest,
};
