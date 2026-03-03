const { initializePunishmentDatabase } = require('./services/punishmentDatabase');
const { startWarningRoleChecker } = require('./services/warningRoleChecker');

async function startPunishmentSystem(client) {
    initializePunishmentDatabase();
    startWarningRoleChecker(client);
    console.log('[Punishment] ✅ 处罚系统已启动');
}

module.exports = { startPunishmentSystem };
