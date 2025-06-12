// src/modules/channelSummary/services/messageCollector.js

const { Collection } = require('discord.js');

/**
 * 收集指定时间范围内的消息
 */
async function collectMessages(channel, startTime, endTime, maxMessages = 1000) {
    const messages = [];
    let lastMessageId = null;
    let collected = 0;
    
    try {
        while (collected < maxMessages) {
            const fetchOptions = { 
                limit: Math.min(100, maxMessages - collected),
                before: lastMessageId 
            };
            
            const fetchedMessages = await channel.messages.fetch(fetchOptions);
            if (fetchedMessages.size === 0) break;
            
            for (const message of fetchedMessages.values()) {
                const messageTime = message.createdAt;
                
                // 检查时间范围
                if (messageTime < startTime) {
                    return messages; // 已经超出时间范围，停止收集
                }
                
                if (messageTime <= endTime) {
                    messages.push(formatMessage(message));
                    collected++;
                }
                
                lastMessageId = message.id;
            }
        }
        
        return messages;
    } catch (error) {
        throw new Error(`收集消息时出错: ${error.message}`);
    }
}

/**
 * 格式化消息数据
 */
function formatMessage(message) {
    return {
        message_id: message.id,
        author: {
            display_name: message.member?.displayName || message.author.displayName || message.author.username,
            user_id: message.author.id,
            username: message.author.username
        },
        content: message.content || '[无文本内容]',
        timestamp: message.createdAt.toISOString(),
        has_attachments: message.attachments.size > 0,
        attachment_count: message.attachments.size,
        reply_to: message.reference?.messageId || null
    };
}

module.exports = {
    collectMessages,
    formatMessage
};