const { autoCleanupHandler } = require('../../modules/autoCleanup/events/messageCreate');
const { selfRoleMessageCreateHandler } = require('../../modules/selfRole/events/messageCreate');

async function messageCreateHandler(message) {
    try {
        // 处理自动清理
        await autoCleanupHandler.handleMessage(message);
    } catch (error) {
        console.error('处理 autoCleanup 模块的 messageCreate 事件时出错:', error);
    }

    try {
        // 处理自助身份组活跃度统计
        await selfRoleMessageCreateHandler(message);
    } catch (error) {
        console.error('处理 selfRole 模块的 messageCreate 事件时出错:', error);
    }
}

module.exports = { messageCreateHandler }; 