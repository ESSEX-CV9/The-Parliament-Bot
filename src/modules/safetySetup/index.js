const safetyDatabase = require('./utils/safetyDatabase');
const { startSafetyScheduler } = require('./services/safetyScheduler');

async function startSafetySetupSystem(client) {
    safetyDatabase.initializeSafetyDatabase();
    startSafetyScheduler(client, safetyDatabase);
    console.log('[SafetySetup] ✅ 邀请暂停托管系统已启动');
}

module.exports = { startSafetySetupSystem };
