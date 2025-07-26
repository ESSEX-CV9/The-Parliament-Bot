// src/modules/selfRole/events/messageCreate.js

const { getSelfRoleSettings } = require('../../../core/utils/database');
const { recordActivity } = require('../services/activityTracker');

/**
 * 处理消息创建事件，用于活动追踪
 * @param {import('discord.js').Message} message
 */
async function selfRoleMessageCreateHandler(message) {
    if (message.author.bot || !message.guild) return;

    try {
        const settings = await getSelfRoleSettings(message.guild.id);
        if (!settings || !settings.roles || settings.roles.length === 0) {
            return;
        }

        // 检查此频道是否被任何身份组的活跃度条件所监控
        const isMonitored = settings.roles.some(role => role.conditions?.activity?.channelId === message.channel.id);

        if (isMonitored) {
            await recordActivity(message);
        }
    } catch (error) {
        console.error('[SelfRole] ❌ 在 messageCreate 事件中处理活动追踪时出错:', error);
    }
}

module.exports = {
    selfRoleMessageCreateHandler,
};