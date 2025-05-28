// src/modules/contest/services/linkParser.js

/**
 * 解析Discord链接
 */
function parseDiscordUrl(url) {
    try {
        // 消息链接模式
        const messagePattern = /https:\/\/discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/;
        const messageMatch = url.match(messagePattern);
        
        if (messageMatch) {
            return {
                success: true,
                linkType: 'message',
                guildId: messageMatch[1],
                channelId: messageMatch[2],
                messageId: messageMatch[3],
                originalUrl: url
            };
        }
        
        // 频道链接模式
        const channelPattern = /https:\/\/discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/?$/;
        const channelMatch = url.match(channelPattern);
        
        if (channelMatch) {
            return {
                success: true,
                linkType: 'channel',
                guildId: channelMatch[1],
                channelId: channelMatch[2],
                messageId: null,
                originalUrl: url
            };
        }
        
        return {
            success: false,
            error: '不支持的链接格式。请提供有效的Discord消息链接或频道链接。'
        };
        
    } catch (error) {
        console.error('解析链接时出错:', error);
        return {
            success: false,
            error: '链接解析失败，请检查链接格式。'
        };
    }
}

/**
 * 验证和处理投稿链接
 */
async function validateSubmissionLink(client, url, submitterId, expectedGuildId) {
    try {
        // 解析链接
        const parseResult = parseDiscordUrl(url);
        if (!parseResult.success) {
            return {
                success: false,
                error: parseResult.error
            };
        }
        
        // 验证是否为本服务器
        if (parseResult.guildId !== expectedGuildId) {
            return {
                success: false,
                error: '只能投稿本服务器的作品。'
            };
        }
        
        // 获取频道
        const channel = await client.channels.fetch(parseResult.channelId).catch(() => null);
        if (!channel) {
            return {
                success: false,
                error: '无法访问指定的频道，请检查链接或确保机器人有访问权限。'
            };
        }
        
        // 验证是否为许可论坛（如果设置了许可论坛列表）
        const { getContestSettings } = require('../utils/contestDatabase');
        const settings = await getContestSettings(expectedGuildId);
        
        if (settings && settings.allowedForumIds && settings.allowedForumIds.length > 0) {
            // 检查频道是否为论坛帖子
            if (channel.isThread() && channel.parent) {
                // 检查父论坛是否在许可列表中
                if (!settings.allowedForumIds.includes(channel.parent.id)) {
                    return {
                        success: false,
                        error: '只能投稿指定论坛中的作品。请确保您的作品发布在允许投稿的论坛中。'
                    };
                }
            } else {
                // 如果不是论坛帖子，检查频道本身是否为许可论坛
                if (!settings.allowedForumIds.includes(channel.id)) {
                    return {
                        success: false,
                        error: '只能投稿指定论坛中的作品。请确保您的作品发布在允许投稿的论坛中。'
                    };
                }
            }
        }
        
        let targetMessage = null;
        
        if (parseResult.linkType === 'message') {
            // 直接获取消息
            targetMessage = await channel.messages.fetch(parseResult.messageId).catch(() => null);
            if (!targetMessage) {
                return {
                    success: false,
                    error: '无法找到指定的消息，请检查链接。'
                };
            }
        } else {
            // 频道链接，需要找到用户的最新消息
            const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
            if (!messages) {
                return {
                    success: false,
                    error: '无法获取频道消息，请检查机器人权限。'
                };
            }
            
            targetMessage = messages.find(msg => msg.author.id === submitterId);
            if (!targetMessage) {
                return {
                    success: false,
                    error: '在该频道中找不到您的消息。'
                };
            }
            
            // 更新解析结果中的消息ID
            parseResult.messageId = targetMessage.id;
        }
        
        // 验证消息作者
        if (targetMessage.author.id !== submitterId) {
            return {
                success: false,
                error: '只能投稿自己的作品。'
            };
        }
        
        // 提取预览信息
        const preview = extractMessagePreview(targetMessage);
        
        return {
            success: true,
            parsedInfo: parseResult,
            message: targetMessage,
            preview: preview
        };
        
    } catch (error) {
        console.error('验证投稿链接时出错:', error);
        return {
            success: false,
            error: '处理链接时出现错误，请稍后重试。'
        };
    }
}

/**
 * 提取消息预览信息
 */
function extractMessagePreview(message) {
    try {
        let title = '';
        let content = message.content;
        
        // 尝试从内容中提取标题
        const lines = content.split('\n').filter(line => line.trim().length > 0);
        if (lines.length > 1 && lines[0].length <= 100) {
            title = lines[0].trim();
            content = lines.slice(1).join('\n');
        }
        
        // 获取首个图片
        let imageUrl = null;
        if (message.attachments.size > 0) {
            const firstAttachment = message.attachments.first();
            if (firstAttachment.contentType && firstAttachment.contentType.startsWith('image/')) {
                imageUrl = firstAttachment.url;
            }
        } else if (message.embeds.length > 0) {
            const firstEmbed = message.embeds[0];
            imageUrl = firstEmbed.image?.url || firstEmbed.thumbnail?.url;
        }
        
        return {
            title: title || '无标题',
            content: content.substring(0, 400) + (content.length > 400 ? '...' : ''),
            imageUrl: imageUrl,
            authorName: message.author.displayName || message.author.username,
            timestamp: message.createdTimestamp,
            lastUpdated: new Date().toISOString()
        };
        
    } catch (error) {
        console.error('提取消息预览时出错:', error);
        return {
            title: '无标题',
            content: '无法获取预览内容',
            imageUrl: null,
            authorName: '未知用户',
            timestamp: Date.now(),
            lastUpdated: new Date().toISOString()
        };
    }
}

/**
 * 检查投稿是否重复
 */
async function checkDuplicateSubmission(contestChannelId, messageId, submitterId) {
    try {
        const { getSubmissionsByChannel } = require('../utils/contestDatabase');
        const submissions = await getSubmissionsByChannel(contestChannelId);
        
        // 检查是否已投稿相同消息
        const duplicateMessage = submissions.find(sub => 
            sub.parsedInfo.messageId === messageId && sub.isValid
        );
        
        if (duplicateMessage) {
            return {
                isDuplicate: true,
                error: '此作品已经投稿过了。'
            };
        }
        
        return {
            isDuplicate: false
        };
        
    } catch (error) {
        console.error('检查重复投稿时出错:', error);
        return {
            isDuplicate: false
        };
    }
}

module.exports = {
    parseDiscordUrl,
    validateSubmissionLink,
    extractMessagePreview,
    checkDuplicateSubmission
};