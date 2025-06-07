const { MessageType } = require('discord.js');

/**
 * 消息删除服务
 * 处理重建消息的删除请求
 */
class MessageDeleteService {
    constructor() {
        this.metadataPattern = /> -# user_id:(\d+) time_stamp:(.+)/;
    }

    /**
     * 处理消息删除请求
     * @param {string} userId - 请求用户的ID
     * @param {string} messageLink - 消息链接
     * @param {Client} client - Discord客户端
     * @returns {Object} 操作结果
     */
    async processMessageDelete(userId, messageLink, client) {
        try {
            // 1. 解析消息链接
            const linkInfo = this.parseMessageLink(messageLink);
            if (!linkInfo.success) {
                return { success: false, message: linkInfo.message };
            }

            // 2. 获取消息
            const messageResult = await this.fetchMessage(linkInfo.guildId, linkInfo.channelId, linkInfo.messageId, client);
            if (!messageResult.success) {
                return { success: false, message: messageResult.message };
            }

            const { message, thread } = messageResult.data;

            // 3. 验证权限
            const permissionResult = await this.verifyPermission(userId, message, thread, client);
            if (!permissionResult.success) {
                return { success: false, message: permissionResult.message };
            }

            // 4. 执行删除
            return await this.deleteMessage(message, thread.name);

        } catch (error) {
            console.error('处理消息删除请求失败:', error);
            return { 
                success: false, 
                message: '处理请求时发生错误，请联系管理员。' 
            };
        }
    }

    /**
     * 解析消息链接
     * @param {string} messageLink - Discord消息链接
     * @returns {Object} 解析结果
     */
    parseMessageLink(messageLink) {
        // Discord消息链接格式: https://discord.com/channels/guildId/channelId/messageId
        const linkPattern = /https:\/\/(?:discord\.com|discordapp\.com)\/channels\/(\d+)\/(\d+)\/(\d+)/;
        const match = messageLink.match(linkPattern);

        if (!match) {
            return {
                success: false,
                message: '❌ 无效的消息链接格式！请提供正确的Discord消息链接。'
            };
        }

        return {
            success: true,
            guildId: match[1],
            channelId: match[2],
            messageId: match[3]
        };
    }

    /**
     * 获取消息对象
     * @param {string} guildId - 服务器ID
     * @param {string} channelId - 频道ID
     * @param {string} messageId - 消息ID
     * @param {Client} client - Discord客户端
     * @returns {Object} 获取结果
     */
    async fetchMessage(guildId, channelId, messageId, client) {
        try {
            // 获取服务器
            const guild = await client.guilds.fetch(guildId);
            if (!guild) {
                return {
                    success: false,
                    message: '❌ 无法访问该服务器！'
                };
            }

            // 获取频道/线程
            let channel;
            try {
                channel = await guild.channels.fetch(channelId);
            } catch (error) {
                // 可能是线程，尝试从所有频道中查找
                const allChannels = await guild.channels.fetch();
                for (const [, ch] of allChannels) {
                    if (ch.threads) {
                        try {
                            const thread = await ch.threads.fetch(channelId);
                            if (thread) {
                                channel = thread;
                                break;
                            }
                        } catch (threadError) {
                            // 继续查找
                        }
                    }
                }
            }

            if (!channel) {
                return {
                    success: false,
                    message: '❌ 无法找到指定的频道或帖子！'
                };
            }

            // 获取消息
            const message = await channel.messages.fetch(messageId);
            if (!message) {
                return {
                    success: false,
                    message: '❌ 无法找到指定的消息！'
                };
            }

            return {
                success: true,
                data: { message, thread: channel }
            };

        } catch (error) {
            console.error('获取消息失败:', error);
            return {
                success: false,
                message: '❌ 获取消息时发生错误，请检查链接是否正确。'
            };
        }
    }

    /**
     * 验证用户权限
     * @param {string} userId - 请求用户ID
     * @param {Message} message - 目标消息
     * @param {ThreadChannel} thread - 消息所在线程
     * @param {Client} client - Discord客户端
     * @returns {Object} 验证结果
     */
    async verifyPermission(userId, message, thread, client) {
        try {
            // 1. 检查消息是否为重建消息（机器人或其webhook发送）
            const isRebuiltMessage = await this.isRebuiltMessage(message, thread, client);
            if (!isRebuiltMessage.success) {
                return { success: false, message: isRebuiltMessage.message };
            }

            // 2. 查找相关的元数据消息
            const metadataResult = await this.findRelatedMetadata(message, thread);
            if (!metadataResult.success) {
                return { success: false, message: metadataResult.message };
            }

            const originalAuthorId = metadataResult.originalAuthorId;

            // 3. 检查用户权限
            if (userId !== originalAuthorId) {
                return {
                    success: false,
                    message: '❌ 你只能删除自己发布的消息！'
                };
            }

            return {
                success: true,
                originalAuthor: originalAuthorId
            };

        } catch (error) {
            console.error('验证权限失败:', error);
            return {
                success: false,
                message: '❌ 验证权限时发生错误。'
            };
        }
    }

    /**
     * 检查消息是否为重建消息
     * @param {Message} message - 目标消息
     * @param {ThreadChannel} thread - 线程
     * @param {Client} client - Discord客户端
     * @returns {Object} 检查结果
     */
    async isRebuiltMessage(message, thread, client) {
        // 1. 检查是否为机器人直接发送
        if (message.author.id === client.user.id) {
            return { success: true };
        }

        // 2. 检查是否为webhook消息
        if (message.webhookId) {
            try {
                const webhook = await message.fetchWebhook();
                if (webhook && webhook.owner && webhook.owner.id === client.user.id) {
                    return { success: true };
                }
            } catch (error) {
                console.warn('获取webhook信息失败:', error);
            }
        }

        // 3. 额外检查：通过内容格式判断
        const hasMetadataFormat = this.metadataPattern.test(message.content);
        const hasRebuiltFormat = message.content.includes('**') && message.content.includes('(') && message.content.includes(')');
        
        if (hasMetadataFormat || hasRebuiltFormat) {
            return { success: true };
        }

        // 4. 最后检查：查看消息周围是否有元数据消息
        try {
            const nearbyMessages = await thread.messages.fetch({ 
                limit: 10,
                around: message.id 
            });

            for (const [, msg] of nearbyMessages) {
                if (this.metadataPattern.test(msg.content)) {
                    return { success: true };
                }
            }
        } catch (error) {
            console.warn('检查周围消息失败:', error);
        }

        return {
            success: false,
            message: '❌ 只能删除机器人重建的消息！该消息不是通过重建系统创建的。'
        };
    }

    /**
     * 查找相关的元数据消息
     * @param {Message} targetMessage - 目标消息
     * @param {ThreadChannel} thread - 线程
     * @returns {Object} 查找结果
     */
    async findRelatedMetadata(targetMessage, thread) {
        try {
            // 获取消息前后的消息来查找元数据
            const messages = await thread.messages.fetch({ 
                limit: 50,
                around: targetMessage.id 
            });

            const messagesArray = Array.from(messages.values())
                .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

            const targetIndex = messagesArray.findIndex(msg => msg.id === targetMessage.id);
            
            if (targetIndex === -1) {
                return {
                    success: false,
                    message: '❌ 无法找到消息在线程中的位置。'
                };
            }

            // 向后查找元数据消息（元数据通常在消息组的最后）
            for (let i = targetIndex; i < messagesArray.length; i++) {
                const msg = messagesArray[i];
                const metadataMatch = msg.content.match(this.metadataPattern);
                
                if (metadataMatch) {
                    const originalAuthorId = metadataMatch[1];
                    return {
                        success: true,
                        originalAuthorId
                    };
                }

                // 如果遇到另一个非元数据消息且不是同一组，停止查找
                const isGroupBreak = msg.author.id !== targetMessage.author.id && 
                                   !msg.content.includes('> -#') && 
                                   i > targetIndex + 5; // 最多向后查找5条消息
                
                if (isGroupBreak) {
                    break;
                }
            }

            return {
                success: false,
                message: '❌ 无法找到该消息的元数据信息，可能不是重建的消息。'
            };

        } catch (error) {
            console.error('查找元数据失败:', error);
            return {
                success: false,
                message: '❌ 查找消息信息时发生错误。'
            };
        }
    }

    /**
     * 删除消息
     * @param {Message} message - 要删除的消息
     * @param {string} threadName - 线程名称
     * @returns {Object} 删除结果
     */
    async deleteMessage(message, threadName) {
        try {
            await message.delete();

            return {
                success: true,
                message: '✅ 消息已成功删除！',
                threadName: threadName
            };

        } catch (error) {
            console.error('删除消息失败:', error);
            
            // 检查具体错误类型
            if (error.code === 50013) {
                return {
                    success: false,
                    message: '❌ 权限不足，无法删除该消息。'
                };
            } else if (error.code === 10008) {
                return {
                    success: false,
                    message: '❌ 消息已被删除或不存在。'
                };
            } else {
                return {
                    success: false,
                    message: '❌ 删除消息时发生错误，请稍后再试。'
                };
            }
        }
    }
}

module.exports = MessageDeleteService; 