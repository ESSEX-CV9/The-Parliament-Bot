const { KeywordDetector } = require('./keywordDetector');
const { getBannedKeywords } = require('../../../core/utils/database');

class FullServerScanner {
    constructor(guild, rateLimiter, taskManager, progressTracker) {
        this.guild = guild;
        this.rateLimiter = rateLimiter;
        this.taskManager = taskManager;
        this.progressTracker = progressTracker;
        this.keywordDetector = new KeywordDetector();
        this.isRunning = false;
        this.shouldStop = false;
        this.taskId = null;
    }

    async start(taskData) {
        if (this.isRunning) {
            throw new Error('扫描器已在运行中');
        }

        this.isRunning = true;
        this.shouldStop = false;
        this.taskId = taskData.taskId;

        try {
            console.log(`🔍 开始全服务器扫描 - Guild: ${this.guild.id}`);
            
            // 获取违禁关键字
            const bannedKeywords = await getBannedKeywords(this.guild.id);
            if (bannedKeywords.length === 0) {
                throw new Error('没有设置违禁关键字，无法进行清理');
            }

            // 获取所有文字频道
            const channels = await this.guild.channels.fetch();
            const textChannels = channels.filter(channel => 
                channel.isTextBased() && 
                !channel.isThread() && 
                channel.viewable
            );

            console.log(`📋 找到 ${textChannels.size} 个可扫描的频道`);
            
            // 更新任务进度
            await this.taskManager.updateTaskProgress(this.guild.id, this.taskId, {
                totalChannels: textChannels.size
            });

            // 通知开始扫描
            if (this.progressTracker) {
                await this.progressTracker.setTotalChannels(textChannels.size);
            }

            let totalDeleted = 0;
            let totalScanned = 0;
            let completedChannels = 0;

            // 扫描每个频道
            for (const [channelId, channel] of textChannels) {
                if (this.shouldStop) {
                    console.log('⏹️ 扫描被用户停止');
                    break;
                }

                try {
                    console.log(`🔍 扫描频道: ${channel.name} (${channelId})`);
                    
                    // 更新当前扫描的频道
                    await this.taskManager.updateTaskProgress(this.guild.id, this.taskId, {
                        currentChannel: {
                            id: channelId,
                            name: channel.name
                        }
                    });

                    if (this.progressTracker) {
                        await this.progressTracker.updateCurrentChannel(channel.name);
                    }

                    const channelStats = await this.scanChannel(channel, bannedKeywords);
                    
                    totalDeleted += channelStats.deleted;
                    totalScanned += channelStats.scanned;
                    completedChannels++;

                    // 更新进度
                    await this.taskManager.updateTaskProgress(this.guild.id, this.taskId, {
                        completedChannels,
                        totalMessages: totalScanned,
                        scannedMessages: totalScanned,
                        deletedMessages: totalDeleted
                    });

                    if (this.progressTracker) {
                        await this.progressTracker.completeChannel(channelId, channelStats);
                    }

                    console.log(`✅ 频道 ${channel.name} 扫描完成 - 扫描: ${channelStats.scanned}, 删除: ${channelStats.deleted}`);

                } catch (error) {
                    console.error(`❌ 扫描频道 ${channel.name} 时出错:`, error);
                    // 继续扫描其他频道
                }
            }

            // 完成任务
            const finalStats = {
                totalChannelsScanned: completedChannels,
                totalMessagesScanned: totalScanned,
                totalMessagesDeleted: totalDeleted,
                completedNormally: !this.shouldStop
            };

            if (this.shouldStop) {
                await this.taskManager.stopTask(this.guild.id, this.taskId, 'user_requested');
            } else {
                await this.taskManager.completeTask(this.guild.id, this.taskId, finalStats);
            }

            if (this.progressTracker) {
                await this.progressTracker.complete(finalStats);
            }

            console.log(`🎉 全服务器扫描完成 - 扫描 ${totalScanned} 条消息，删除 ${totalDeleted} 条违规消息`);
            
            return finalStats;

        } catch (error) {
            console.error('❌ 全服务器扫描时出错:', error);
            
            await this.taskManager.stopTask(this.guild.id, this.taskId, 'error');
            
            if (this.progressTracker) {
                await this.progressTracker.error(error);
            }
            
            throw error;
        } finally {
            this.isRunning = false;
        }
    }

    async scanChannel(channel, bannedKeywords) {
        let lastMessageId = null;
        let hasMoreMessages = true;
        let scannedCount = 0;
        let deletedCount = 0;

        while (hasMoreMessages && !this.shouldStop) {
            try {
                // 获取消息，遵守API限制
                const messages = await this.rateLimiter.execute(async () => {
                    const options = { limit: 100 };
                    if (lastMessageId) {
                        options.before = lastMessageId;
                    }
                    return await channel.messages.fetch(options);
                });

                if (messages.size === 0) {
                    hasMoreMessages = false;
                    break;
                }

                // 处理这批消息
                const batchStats = await this.processMessageBatch(messages, bannedKeywords);
                scannedCount += batchStats.scanned;
                deletedCount += batchStats.deleted;

                // 更新lastMessageId为最后一条消息的ID
                lastMessageId = messages.last().id;

                // 更新进度
                if (this.progressTracker) {
                    await this.progressTracker.updateProgress(channel.id, batchStats.scanned);
                }

                // 小延迟避免过快请求
                await new Promise(resolve => setTimeout(resolve, 200));

            } catch (error) {
                console.error(`处理频道 ${channel.name} 中的消息时出错:`, error);
                // 如果是权限错误，跳过这个频道
                if (error.code === 50013) {
                    console.log(`⚠️ 没有权限访问频道 ${channel.name}，跳过`);
                    break;
                }
                // 其他错误也跳过这个频道
                break;
            }
        }

        return { scanned: scannedCount, deleted: deletedCount };
    }

    async processMessageBatch(messages, bannedKeywords) {
        let scannedCount = 0;
        let deletedCount = 0;

        for (const [messageId, message] of messages) {
            if (this.shouldStop) break;

            scannedCount++;

            try {
                // 检查消息是否包含违禁关键字
                const checkResult = await this.keywordDetector.checkMessageAdvanced(message, bannedKeywords);
                
                if (checkResult.shouldDelete) {
                    // 删除消息
                    await this.rateLimiter.execute(async () => {
                        await message.delete();
                    });
                    
                    deletedCount++;
                    
                    console.log(`🗑️ 删除违规消息 - 频道: ${message.channel.name}, 作者: ${message.author.tag}, 关键字: ${checkResult.matchedKeywords.join(', ')}`);
                }
            } catch (error) {
                console.error(`处理消息 ${messageId} 时出错:`, error);
                // 继续处理其他消息
            }
        }

        return { scanned: scannedCount, deleted: deletedCount };
    }

    stop() {
        this.shouldStop = true;
        console.log('🛑 请求停止全服务器扫描');
    }

    isScanning() {
        return this.isRunning;
    }
}

module.exports = { FullServerScanner }; 