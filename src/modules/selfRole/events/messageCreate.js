// src/modules/selfRole/events/messageCreate.js

const { handleMessage } = require('../services/activityTracker');

/**
 * selfRole 模块的消息创建事件处理器
 * @param {import('discord.js').Message} message
 */
async function selfRoleMessageCreateHandler(message) {
    try {
        await handleMessage(message);
    } catch (error) {
        console.error('[SelfRole] 处理消息创建事件时出错:', error);
    }
}

module.exports = {
    selfRoleMessageCreateHandler,
};