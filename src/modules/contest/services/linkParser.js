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
async function validateSubmissionLink(client, url, submitterId, expectedGuildId, contestChannelId) {
    try {
        // 解析链接
        const parseResult = parseDiscordUrl(url);
        if (!parseResult.success) {
            return {
                success: false,
                error: parseResult.error
            };
        }
        
        // 检查是否为外部服务器链接
        const isExternalServer = parseResult.guildId !== expectedGuildId;
        
        if (isExternalServer) {
            // 检查比赛是否允许外部服务器投稿
            const { getContestChannel, getContestSettings } = require('../utils/contestDatabase');
            const contestChannelData = await getContestChannel(contestChannelId);
            
            if (!contestChannelData || !contestChannelData.allowExternalServers) {
                return {
                    success: false,
                    error: '此比赛不允许外部服务器投稿，只能投稿本服务器的作品。'
                };
            }
            
            // 检查外部服务器是否在允许列表中
            const settings = await getContestSettings(expectedGuildId);
            const allowedExternalServers = settings?.allowedExternalServers || [];
            
            if (!allowedExternalServers.includes(parseResult.guildId)) {
                return {
                    success: false,
                    error: '该外部服务器不在允许投稿的服务器列表中。'
                };
            }
            
            // 外部服务器投稿，无法验证内容，返回特殊标记
            return {
                success: true,
                parsedInfo: parseResult,
                isExternal: true,
                preview: {
                    title: '外部服务器作品',
                    content: '机器人无法验证外部服务器内容',
                    imageUrl: null,
                    timestamp: Date.now(),
                    authorName: '外部用户',
                    authorAvatar: null
                }
            };
        }
        
        // 本服务器投稿，进行正常验证
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
            preview: preview,
            isExternal: false
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
        
        // 优先检查是否为论坛帖子，如果是则使用帖子标题
        if (message.channel.isThread() && message.channel.parent && message.channel.parent.type === 15) {
            // 这是论坛帖子，使用帖子标题
            title = message.channel.name;
        } else {
            // 不是论坛帖子，尝试从内容中提取标题
            const lines = content.split('\n').filter(line => line.trim().length > 0);
            if (lines.length > 1 && lines[0].length <= 100) {
                title = lines[0].trim();
                content = lines.slice(1).join('\n');
            }
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
            content: content || '无内容',
            imageUrl: imageUrl,
            timestamp: message.createdTimestamp,
            authorName: message.author.displayName || message.author.username,
            authorAvatar: message.author.displayAvatarURL()
        };
        
    } catch (error) {
        console.error('提取消息预览时出错:', error);
        return {
            title: '预览提取失败',
            content: '无法获取消息内容',
            imageUrl: null,
            timestamp: Date.now(),
            authorName: '未知用户',
            authorAvatar: null
        };
    }
}

/**
 * 检查重复投稿
 */
async function checkDuplicateSubmission(contestChannelId, messageId, submitterId, guildId, channelId) {
    try {
        const { getSubmissionsByChannel } = require('../utils/contestDatabase');
        const submissions = await getSubmissionsByChannel(contestChannelId);
        
        // 检查是否已经投稿过相同的消息（需要完整匹配 guildId + channelId + messageId）
        const duplicateMessage = submissions.find(sub => 
            sub.isValid && 
            sub.parsedInfo.messageId === messageId &&
            sub.parsedInfo.guildId === guildId && 
            sub.parsedInfo.channelId === channelId
        );
        
        if (duplicateMessage) {
            return {
                isDuplicate: true,
                error: '该作品已经投稿过了，不能重复投稿。'
            };
        }
        
        // 检查用户是否已经投稿过（每人只能投稿一次）
        // const userSubmission = submissions.find(sub => 
        //     sub.isValid && 
        //     sub.submitterId === submitterId
        // );
        
        // if (userSubmission) {
        //     return {
        //         isDuplicate: true,
        //         error: '您已经投稿过了，每人只能投稿一次。如需修改请联系主办人。'
        //     };
        // }
        
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