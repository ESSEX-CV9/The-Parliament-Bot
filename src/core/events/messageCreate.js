// 已停用（2026-10-01）：按要求保留源码，取消旧 Bot 接入。
// const { autoCleanupHandler } = require('../../modules/autoCleanup/events/messageCreate');

const { selfRoleMessageCreateHandler } = require('../../modules/selfRole/events/messageCreate');

async function messageCreateHandler(message) {
    // 已停用（2026-10-01）：按要求保留源码，取消旧 Bot 接入。
    // try {
        // // 处理自动清理
        // await autoCleanupHandler.handleMessage(message);
    // } catch (error) {
        // console.error('处理 autoCleanup 模块的 messageCreate 事件时出错:', error);
    // }


    try {
        // 处理自助身份组活跃度统计
        await selfRoleMessageCreateHandler(message);
    } catch (error) {
        console.error('处理 selfRole 模块的 messageCreate 事件时出错:', error);
    }
}

module.exports = { messageCreateHandler }; 