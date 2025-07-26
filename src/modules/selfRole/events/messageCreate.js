// src/modules/selfRole/events/messageCreate.js

const { handleMessage } = require('../services/activityTracker');

/**
 * 处理消息创建事件，用于活动追踪
 * @param {import('discord.js').Message} message
 */
async function selfRoleMessageCreateHandler(message) {
    try {
        // 直接调用 activityTracker 的主处理函数
        // 所有逻辑判断（包括是否为机器人、是否在服务器、频道是否被监控等）都由 handleMessage 内部完成
        await handleMessage(message);
    } catch (error) {
        console.error('[SelfRole] ❌ 在 messageCreate 事件中调用活动追踪器时出错:', error);
    }
}

module.exports = {
    selfRoleMessageCreateHandler,
};