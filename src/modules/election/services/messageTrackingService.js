const { ElectionData, RegistrationData } = require('../data/electionDatabase');

/**
 * 消息追踪服务 - 用于向后兼容处理
 */
class MessageTrackingService {
    constructor(client) {
        this.client = client;
    }

    /**
     * 扫描并记录现有的候选人简介消息
     * @param {string} electionId - 募选ID
     * @returns {object} 扫描结果
     */
    async scanAndRecordExistingMessages(electionId) {
        try {
            console.log(`开始扫描募选 ${electionId} 的候选人简介消息...`);

            // 获取募选信息
            const election = await ElectionData.getById(electionId);
            if (!election) {
                throw new Error('募选不存在');
            }

            // 获取投票频道
            const channelId = election.channels?.votingChannelId;
            if (!channelId) {
                throw new Error('未设置投票频道');
            }

            const channel = this.client.channels.cache.get(channelId);
            if (!channel) {
                throw new Error(`找不到频道: ${channelId}`);
            }

            // 获取所有报名记录
            const registrations = await RegistrationData.getByElection(electionId);
            if (registrations.length === 0) {
                return {
                    success: true,
                    found: 0,
                    recorded: 0,
                    message: '没有找到报名记录'
                };
            }

            let foundCount = 0;
            let recordedCount = 0;
            const results = [];

            // 搜索频道中的消息
            const messages = await this.fetchChannelMessages(channel, 200); // 最多搜索200条消息
            
            for (const registration of registrations) {
                // 如果已经有记录的消息ID，跳过
                if (registration.introductionMessageId) {
                    continue;
                }

                // 查找匹配的候选人简介消息
                const matchedMessage = this.findCandidateMessage(messages, registration);
                
                if (matchedMessage) {
                    foundCount++;
                    
                    try {
                        // 记录消息ID
                        await RegistrationData.setIntroductionMessage(
                            registration.registrationId,
                            matchedMessage.id,
                            channel.id
                        );
                        recordedCount++;
                        
                        results.push({
                            userId: registration.userId,
                            messageId: matchedMessage.id,
                            status: 'recorded'
                        });
                        
                        console.log(`已记录候选人 ${registration.userId} 的简介消息: ${matchedMessage.id}`);
                    } catch (error) {
                        console.error(`记录候选人 ${registration.userId} 消息ID失败:`, error);
                        results.push({
                            userId: registration.userId,
                            messageId: matchedMessage.id,
                            status: 'error',
                            error: error.message
                        });
                    }
                } else {
                    results.push({
                        userId: registration.userId,
                        messageId: null,
                        status: 'not_found'
                    });
                }
            }

            console.log(`扫描完成: 找到 ${foundCount} 条消息，成功记录 ${recordedCount} 条`);

            return {
                success: true,
                found: foundCount,
                recorded: recordedCount,
                total: registrations.length,
                results,
                message: `成功扫描并记录 ${recordedCount}/${foundCount} 条候选人简介消息`
            };

        } catch (error) {
            console.error('扫描候选人简介消息时出错:', error);
            return {
                success: false,
                error: error.message,
                found: 0,
                recorded: 0
            };
        }
    }

    /**
     * 获取频道中的消息
     * @param {Channel} channel - Discord频道
     * @param {number} limit - 消息数量限制
     * @returns {Array} 消息数组
     */
    async fetchChannelMessages(channel, limit = 100) {
        try {
            const messages = [];
            let lastMessageId = null;
            let remainingLimit = limit;

            while (remainingLimit > 0) {
                const fetchOptions = {
                    limit: Math.min(remainingLimit, 100)
                };

                if (lastMessageId) {
                    fetchOptions.before = lastMessageId;
                }

                const fetchedMessages = await channel.messages.fetch(fetchOptions);
                
                if (fetchedMessages.size === 0) {
                    break; // 没有更多消息
                }

                messages.push(...fetchedMessages.values());
                lastMessageId = fetchedMessages.last().id;
                remainingLimit -= fetchedMessages.size;
            }

            return messages;
        } catch (error) {
            console.error('获取频道消息失败:', error);
            return [];
        }
    }

    /**
     * 查找匹配的候选人简介消息
     * @param {Array} messages - 消息数组
     * @param {object} registration - 报名记录
     * @returns {Message|null} 匹配的消息
     */
    findCandidateMessage(messages, registration) {
        for (const message of messages) {
            // 检查消息是否包含候选人信息
            if (this.isCandidateIntroductionMessage(message, registration)) {
                return message;
            }
        }
        return null;
    }

    /**
     * 判断消息是否为指定候选人的简介消息
     * @param {Message} message - Discord消息
     * @param {object} registration - 报名记录
     * @returns {boolean} 是否匹配
     */
    isCandidateIntroductionMessage(message, registration) {
        try {
            // 检查消息是否有嵌入内容
            if (!message.embeds || message.embeds.length === 0) {
                return false;
            }

            const embed = message.embeds[0];
            
            // 检查标题是否包含"候选人介绍"
            if (!embed.title || !embed.title.includes('候选人介绍')) {
                return false;
            }

            // 检查是否提及了指定用户
            if (message.mentions && message.mentions.users.has(registration.userId)) {
                return true;
            }

            // 检查嵌入内容中是否包含用户ID
            const embedContent = JSON.stringify(embed);
            if (embedContent.includes(registration.userId)) {
                return true;
            }

            // 检查嵌入字段中是否有候选人信息
            if (embed.fields) {
                for (const field of embed.fields) {
                    if (field.value && field.value.includes(`<@${registration.userId}>`)) {
                        return true;
                    }
                }
            }

            return false;
        } catch (error) {
            console.error('判断候选人简介消息时出错:', error);
            return false;
        }
    }

    /**
     * 验证消息ID记录的准确性
     * @param {string} electionId - 募选ID
     * @returns {object} 验证结果
     */
    async verifyMessageRecords(electionId) {
        try {
            console.log(`开始验证募选 ${electionId} 的消息记录...`);

            const registrations = await RegistrationData.getByElection(electionId);
            const results = {
                valid: 0,
                invalid: 0,
                missing: 0,
                details: []
            };

            for (const registration of registrations) {
                if (!registration.introductionMessageId) {
                    results.missing++;
                    results.details.push({
                        userId: registration.userId,
                        status: 'missing',
                        message: '未记录消息ID'
                    });
                    continue;
                }

                try {
                    const channel = this.client.channels.cache.get(registration.introductionChannelId);
                    if (!channel) {
                        results.invalid++;
                        results.details.push({
                            userId: registration.userId,
                            status: 'invalid',
                            message: '频道不存在'
                        });
                        continue;
                    }

                    const message = await channel.messages.fetch(registration.introductionMessageId).catch(() => null);
                    if (!message) {
                        results.invalid++;
                        results.details.push({
                            userId: registration.userId,
                            status: 'invalid',
                            message: '消息不存在'
                        });
                        continue;
                    }

                    // 验证消息是否确实为该候选人的简介
                    if (this.isCandidateIntroductionMessage(message, registration)) {
                        results.valid++;
                        results.details.push({
                            userId: registration.userId,
                            status: 'valid',
                            messageId: message.id
                        });
                    } else {
                        results.invalid++;
                        results.details.push({
                            userId: registration.userId,
                            status: 'invalid',
                            message: '消息内容不匹配'
                        });
                    }

                } catch (error) {
                    results.invalid++;
                    results.details.push({
                        userId: registration.userId,
                        status: 'error',
                        message: error.message
                    });
                }
            }

            console.log(`验证完成: 有效 ${results.valid}, 无效 ${results.invalid}, 缺失 ${results.missing}`);
            return results;

        } catch (error) {
            console.error('验证消息记录时出错:', error);
            throw error;
        }
    }
}

module.exports = { MessageTrackingService }; 