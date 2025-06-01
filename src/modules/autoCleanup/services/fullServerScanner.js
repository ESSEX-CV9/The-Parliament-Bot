const { KeywordDetector } = require('./keywordDetector');
const { MessageCache } = require('./messageCache');
const { getBannedKeywords, isChannelExempt, isForumThreadExempt } = require('../../../core/utils/database');
const { ChannelType } = require('discord.js');

class FullServerScanner {
    constructor(guild, rateLimiter, taskManager, progressTracker) {
        this.guild = guild;
        this.rateLimiter = rateLimiter;
        this.taskManager = taskManager;
        this.progressTracker = progressTracker;
        this.keywordDetector = new KeywordDetector();
        this.messageCache = new MessageCache(rateLimiter, 3000); // 3000条消息批量删除
        this.isRunning = false;
        this.shouldStop = false;
        this.taskId = null;
        
        // 并行处理相关
        this.maxConcurrentThreads = 10; // 最大并行帖子数
        this.scanningThreads = new Set(); // 正在扫描的帖子
        this.completedTargets = 0;
        this.totalScanned = 0;
        this.lastStatsUpdate = 0;
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
            
            const bannedKeywords = await getBannedKeywords(this.guild.id);
            if (bannedKeywords.length === 0) {
                throw new Error('没有设置违禁关键字，无法进行清理');
            }

            const scanTargets = await this.getAllScanTargets();
            console.log(`📋 找到 ${scanTargets.length} 个可扫描的目标`);
            
            await this.taskManager.updateTaskProgress(this.guild.id, this.taskId, {
                totalChannels: scanTargets.length
            });

            if (this.progressTracker) {
                await this.progressTracker.setTotalChannels(scanTargets.length);
            }

            // 分组处理：普通频道 vs 帖子
            const regularChannels = scanTargets.filter(target => 
                !target.type.includes('帖子') && !target.type.includes('论坛帖子')
            );
            const threads = scanTargets.filter(target => 
                target.type.includes('帖子') || target.type.includes('论坛帖子')
            );

            console.log(`📊 分组统计：${regularChannels.length} 个普通频道，${threads.length} 个帖子`);

            // 先扫描普通频道（单线程，但快速）
            for (const target of regularChannels) {
                if (this.shouldStop) break;
                await this.scanSingleTarget(target, bannedKeywords);
            }

            // 并行扫描帖子
            await this.scanThreadsInParallel(threads, bannedKeywords);

            // 扫描完成，执行最终删除
            console.log(`🔄 扫描完成，开始最终删除批次...`);
            await this.messageCache.finalFlush();

            // 完成任务
            const cacheStats = this.messageCache.getStats();
            const finalStats = {
                totalChannelsScanned: this.completedTargets,
                totalMessagesScanned: this.totalScanned,
                totalMessagesDeleted: cacheStats.totalDeleted,
                totalUnlockOperations: cacheStats.unlockOperations,
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

            console.log(`🎉 全服务器扫描完成 - 扫描 ${this.totalScanned} 条消息，删除 ${cacheStats.totalDeleted} 条违规消息`);
            
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

    async scanThreadsInParallel(threads, bannedKeywords) {
        console.log(`🚀 开始并行扫描 ${threads.length} 个帖子，最大并发数：${this.maxConcurrentThreads}`);

        const threadPromises = [];
        
        for (let i = 0; i < threads.length; i += this.maxConcurrentThreads) {
            if (this.shouldStop) break;

            const batch = threads.slice(i, i + this.maxConcurrentThreads);
            const batchPromises = batch.map(thread => this.scanSingleTarget(thread, bannedKeywords));
            
            // 并行处理当前批次
            await Promise.all(batchPromises);
            
            console.log(`📈 并行批次完成：${Math.min(i + this.maxConcurrentThreads, threads.length)}/${threads.length} 个帖子`);
        }
    }

    async scanSingleTarget(target, bannedKeywords) {
        try {
            console.log(`🔍 扫描 ${target.type}: ${target.name}`);
            
            await this.taskManager.updateTaskProgress(this.guild.id, this.taskId, {
                currentChannel: {
                    id: target.id,
                    name: target.name,
                    type: target.type
                }
            });

            if (this.progressTracker) {
                await this.progressTracker.updateCurrentChannel(`${target.type}: ${target.name}`);
            }

            const targetStats = await this.scanTargetOptimized(target, bannedKeywords);
            
            this.totalScanned += targetStats.scanned;
            this.completedTargets++;

            // 定期更新进度
            if (Date.now() - this.lastStatsUpdate > 2000) {
                await this.updateProgress();
                this.lastStatsUpdate = Date.now();
            }

            console.log(`✅ ${target.type} ${target.name} 扫描完成 - 扫描: ${targetStats.scanned}, 发现违规: ${targetStats.violating}`);

        } catch (error) {
            console.error(`❌ 扫描 ${target.type} ${target.name} 时出错:`, error);
            this.completedTargets++;
        }
    }

    async scanTargetOptimized(target, bannedKeywords) {
        let lastMessageId = null;
        let hasMoreMessages = true;
        let scannedCount = 0;
        let violatingCount = 0;

        while (hasMoreMessages && !this.shouldStop) {
            try {
                // 激进的消息收集：对于帖子，尝试收集更多批次
                const isThread = target.type.includes('帖子');
                const batchCount = isThread ? 5 : 3; // 帖子使用更多批次
                
                const collectionResult = await this.collectMessageBatchesAggressive(
                    target.channel, 
                    lastMessageId, 
                    batchCount
                );
                
                if (collectionResult.messages.length === 0) {
                    hasMoreMessages = false;
                    break;
                }

                // 快速处理消息（只检测，不删除）
                const batchStats = await this.processMessagesForCache(
                    collectionResult.messages, 
                    bannedKeywords, 
                    target
                );
                
                scannedCount += batchStats.scanned;
                violatingCount += batchStats.violating;
                lastMessageId = collectionResult.lastMessageId;
                hasMoreMessages = collectionResult.hasMore;

            } catch (error) {
                console.error(`处理消息时出错:`, error);
                if (this.isFatalError(error)) {
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        return { scanned: scannedCount, violating: violatingCount };
    }

    async collectMessageBatchesAggressive(channel, lastMessageId, batchCount) {
        const allMessages = [];
        let currentLastMessageId = lastMessageId;
        
        // 创建多个并发请求
        const promises = [];
        
        for (let i = 0; i < batchCount; i++) {
            const promise = this.rateLimiter.execute(async () => {
                const options = { limit: 100 };
                if (currentLastMessageId) {
                    options.before = currentLastMessageId;
                }
                
                try {
                    const messages = await channel.messages.fetch(options);
                    
                    if (messages.size > 0) {
                        // 更新下一批次的起始ID
                        currentLastMessageId = messages.last().id;
                        return Array.from(messages.values());
                    } else {
                        return [];
                    }
                } catch (error) {
                    if (error.code === 50013 || error.code === 50001) {
                        return []; // 权限错误，返回空数组
                    }
                    throw error;
                }
            }, 'scan');

            promises.push(promise);
            
            // 为下一个请求准备不同的起始ID
            if (i === 0) {
                await promise.then(messages => {
                    if (messages.length > 0) {
                        currentLastMessageId = messages[messages.length - 1].id;
                    }
                }).catch(() => {});
            }
        }

        try {
            const results = await Promise.all(promises);
            
            let finalLastMessageId = lastMessageId;
            let hasMore = false;

            for (const messageArray of results) {
                if (messageArray.length > 0) {
                    allMessages.push(...messageArray);
                    finalLastMessageId = messageArray[messageArray.length - 1].id;
                    hasMore = messageArray.length === 100;
                }
                
                if (messageArray.length < 100) {
                    hasMore = false;
                    break;
                }
            }

            return {
                messages: allMessages,
                lastMessageId: finalLastMessageId,
                hasMore: hasMore && allMessages.length > 0
            };

        } catch (error) {
            console.error('激进批量收集失败，回退到单批次:', error);
            return this.collectSingleBatch(channel, lastMessageId);
        }
    }

    async collectSingleBatch(channel, lastMessageId) {
        try {
            const result = await this.rateLimiter.execute(async () => {
                const options = { limit: 100 };
                if (lastMessageId) {
                    options.before = lastMessageId;
                }
                return await channel.messages.fetch(options);
            }, 'scan');

            const messageArray = Array.from(result.values());
            return {
                messages: messageArray,
                lastMessageId: result.size > 0 ? result.last().id : lastMessageId,
                hasMore: result.size === 100
            };
        } catch (error) {
            return { messages: [], lastMessageId, hasMore: false };
        }
    }

    async processMessagesForCache(messages, bannedKeywords, target) {
        let scannedCount = 0;
        let violatingCount = 0;

        // 快速批量检查，不执行删除
        for (const message of messages) {
            if (this.shouldStop) break;

            scannedCount++;

            try {
                const checkResult = await this.keywordDetector.checkMessageAdvanced(message, bannedKeywords);
                
                if (checkResult.shouldDelete) {
                    violatingCount++;
                    // 添加到删除缓存，而不是立即删除
                    await this.messageCache.addViolatingMessage(message, checkResult.matchedKeywords, target);
                }
            } catch (error) {
                console.error(`检查消息时出错:`, error);
            }
        }

        return { scanned: scannedCount, violating: violatingCount };
    }

    async updateProgress() {
        const cacheStats = this.messageCache.getStats();
        
        await this.taskManager.updateTaskProgress(this.guild.id, this.taskId, {
            completedChannels: this.completedTargets,
            totalMessages: this.totalScanned,
            scannedMessages: this.totalScanned,
            deletedMessages: cacheStats.totalDeleted,
            pendingDeletions: cacheStats.pendingDeletions
        });

        if (this.progressTracker) {
            await this.progressTracker.updateProgressWithCache(this.totalScanned, cacheStats);
        }
    }

    isFatalError(error) {
        const fatalErrorCodes = [50013, 50001, 10003];
        return fatalErrorCodes.includes(error.code);
    }

    async getAllScanTargets() {
        const targets = [];
        let exemptCount = 0;
        
        try {
            // 获取所有频道
            const channels = await this.guild.channels.fetch();
            
            for (const [channelId, channel] of channels) {
                if (!channel.viewable) continue;

                // 检查频道是否被豁免
                const isExempt = await isChannelExempt(this.guild.id, channelId);
                if (isExempt) {
                    exemptCount++;
                    console.log(`⏭️ 跳过豁免频道: ${channel.name} (${channel.type === 15 ? '论坛' : '频道'})`);
                    continue;
                }

                // 处理不同类型的频道
                switch (channel.type) {
                    case ChannelType.GuildText:
                        // 普通文字频道
                        targets.push({
                            id: channelId,
                            name: channel.name,
                            type: '文字频道',
                            channel: channel,
                            isLocked: false
                        });
                        break;

                    case ChannelType.GuildForum:
                        // 论坛频道 - 需要获取其子帖子
                        console.log(`📋 正在获取论坛频道 ${channel.name} 的子帖子...`);
                        const forumThreads = await this.getForumThreads(channel);
                        targets.push(...forumThreads);
                        break;

                    case ChannelType.PublicThread:
                    case ChannelType.PrivateThread:
                        // 独立的子帖子（不在论坛中的）
                        // 检查是否通过父论坛被豁免
                        const isThreadExempt = await isForumThreadExempt(this.guild.id, channel);
                        if (isThreadExempt) {
                            exemptCount++;
                            console.log(`⏭️ 跳过豁免论坛的子帖子: ${channel.name}`);
                            continue;
                        }

                        const isLocked = channel.locked || channel.archived;
                        targets.push({
                            id: channelId,
                            name: channel.name,
                            type: isLocked ? '已锁定子帖子' : '子帖子',
                            channel: channel,
                            isLocked: isLocked
                        });
                        break;

                    case ChannelType.GuildVoice:
                        // 语音频道中的消息（如果有的话）
                        if (channel.isTextBased()) {
                            targets.push({
                                id: channelId,
                                name: channel.name,
                                type: '语音频道文字',
                                channel: channel,
                                isLocked: false
                            });
                        }
                        break;

                    case ChannelType.GuildNews:
                        // 公告频道
                        targets.push({
                            id: channelId,
                            name: channel.name,
                            type: '公告频道',
                            channel: channel,
                            isLocked: false
                        });
                        break;

                    case ChannelType.GuildStageVoice:
                        // 舞台频道中的消息（如果有的话）
                        if (channel.isTextBased()) {
                            targets.push({
                                id: channelId,
                                name: channel.name,
                                type: '舞台频道文字',
                                channel: channel,
                                isLocked: false
                            });
                        }
                        break;
                }
            }

            console.log(`📊 扫描目标统计:`);
            console.log(`⏭️ 豁免频道: ${exemptCount} 个`);
            
            const typeStats = {};
            targets.forEach(target => {
                typeStats[target.type] = (typeStats[target.type] || 0) + 1;
            });
            
            for (const [type, count] of Object.entries(typeStats)) {
                console.log(`  - ${type}: ${count} 个`);
            }

        } catch (error) {
            console.error('获取扫描目标时出错:', error);
        }

        return targets;
    }

    async getForumThreads(forumChannel) {
        const threads = [];
        
        try {
            // 检查论坛是否被豁免
            const isForumExempt = await isChannelExempt(this.guild.id, forumChannel.id);
            if (isForumExempt) {
                console.log(`⏭️ 跳过豁免论坛: ${forumChannel.name}`);
                return threads;
            }

            // 获取活跃的子帖子
            const activeThreads = await forumChannel.threads.fetchActive();
            for (const [threadId, thread] of activeThreads.threads) {
                const isLocked = thread.locked;
                const isArchived = thread.archived;
                const lockStatus = isLocked && isArchived ? '已锁定且归档' : 
                                 isLocked ? '已锁定' : 
                                 isArchived ? '已归档' : '活跃';
                
                threads.push({
                    id: threadId,
                    name: thread.name,
                    type: `${lockStatus}论坛帖子`,
                    channel: thread,
                    isLocked: isLocked || isArchived,
                    originalLocked: isLocked,
                    originalArchived: isArchived,
                    parentForum: forumChannel.name
                });
            }

            // 获取已归档的子帖子
            const archivedThreads = await forumChannel.threads.fetchArchived();
            for (const [threadId, thread] of archivedThreads.threads) {
                const isLocked = thread.locked;
                
                threads.push({
                    id: threadId,
                    name: thread.name,
                    type: isLocked ? '已锁定且归档论坛帖子' : '已归档论坛帖子',
                    channel: thread,
                    isLocked: true, // 归档的帖子需要解锁操作
                    originalLocked: isLocked,
                    originalArchived: true,
                    parentForum: forumChannel.name
                });
            }

            const totalActive = activeThreads.threads.size;
            const totalArchived = archivedThreads.threads.size;
            const lockedCount = threads.filter(t => t.originalLocked).length;
            const archivedCount = threads.filter(t => t.originalArchived).length;
            
            console.log(`  📌 论坛 ${forumChannel.name}: ${totalActive} 个活跃帖子，${totalArchived} 个归档帖子 (${lockedCount} 个锁定，${archivedCount} 个归档)`);

        } catch (error) {
            console.error(`获取论坛 ${forumChannel.name} 的子帖子时出错:`, error);
        }

        return threads;
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