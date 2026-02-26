const { handleGuildMemberUpdateForSync } = require('../services/syncPlannerService');

async function roleSyncGuildMemberUpdateHandler(oldMember, newMember) {
    try {
        await handleGuildMemberUpdateForSync(oldMember, newMember);
    } catch (error) {
        console.error('[RoleSync] ❌ 处理 GuildMemberUpdate 事件失败:', error);
    }
}

module.exports = {
    roleSyncGuildMemberUpdateHandler,
};
