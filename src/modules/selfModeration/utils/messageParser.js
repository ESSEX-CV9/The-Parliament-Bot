// src\modules\selfModeration\utils\messageParser.js

/**
 * 解析Discord消息链接
 * @param {string} messageUrl - Discord消息链接
 * @returns {object|null} 解析结果 {guildId, channelId, messageId} 或 null
 */
function parseMessageUrl(messageUrl) {
    try {
        // Discord消息链接格式: https://discord.com/channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID
        // 或者: https://discordapp.com/channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID
        
        const urlPattern = /https:\/\/(discord|discordapp)\.com\/channels\/(\d+)\/(\d+)\/(\d+)/;
        const match = messageUrl.match(urlPattern);
        
        if (!match) {
            console.log('消息链接格式无效:', messageUrl);
            return null;
        }
        
        const [, , guildId, channelId, messageId] = match;
        
        const result = {
            guildId,
            channelId,
            messageId
        };
        
        console.log('成功解析消息链接:', result);
        return result;
        
    } catch (error) {
        console.error('解析消息链接时出错:', error);
        return null;
    }
}

/**
 * 验证消息链接是否来自同一服务器
 * @param {string} messageUrl - Discord消息链接
 * @param {string} currentGuildId - 当前服务器ID
 * @returns {boolean} 是否来自同一服务器
 */
function isMessageFromSameGuild(messageUrl, currentGuildId) {
    const parsed = parseMessageUrl(messageUrl);
    if (!parsed) return false;
    
    return parsed.guildId === currentGuildId;
}

/**
 * 从消息链接创建跳转链接文本
 * @param {string} messageUrl - Discord消息链接
 * @returns {string} 格式化的链接文本
 */
function formatMessageLink(messageUrl) {
    const parsed = parseMessageUrl(messageUrl);
    if (!parsed) return messageUrl;
    
    return `[消息链接](${messageUrl})`;
}

module.exports = {
    parseMessageUrl,
    isMessageFromSameGuild,
    formatMessageLink
};