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
        console.log(`🚀 开始并行扫描 ${threads.length} 个帖子`);

        // 智能分组：小帖子用超高并发，大帖子用适中并发
        const { smallThreads, largeThreads } = await this.categorizeThreads(threads);
        
        console.log(`📊 帖子分类：${smallThreads.length} 个小帖子，${largeThreads.length} 个大帖子`);

        // 小帖子：使用极高并发（50个同时）
        if (smallThreads.length > 0) {
            await this.scanSmallThreadsRapidly(smallThreads, bannedKeywords);
        }

        // 大帖子：使用适中并发（5个同时）
        if (largeThreads.length > 0) {
            await this.scanLargeThreadsNormally(largeThreads, bannedKeywords);
        }
    }

    async categorizeThreads(threads) {
        const smallThreads = [];
        const largeThreads = [];
        
        // 预估每个帖子的大小
        for (const thread of threads) {
            try {
                // 快速获取帖子的最新消息来估算大小
                const estimate = await this.estimateThreadSize(thread);
                
                if (estimate <= 50) { // 50条消息以下算小帖子
                    smallThreads.push({ ...thread, estimatedSize: estimate });
                } else {
                    largeThreads.push({ ...thread, estimatedSize: estimate });
                }
            } catch (error) {
                // 估算失败的归为小帖子
                smallThreads.push({ ...thread, estimatedSize: 1 });
            }
        }
        
        return { smallThreads, largeThreads };
    }

    async estimateThreadSize(thread) {
        try {
            // 快速获取最新的几条消息来估算
            const recentMessages = await this.rateLimiter.execute(async () => {
                return await thread.channel.messages.fetch({ limit: 10 });
            }, 'scan');
            
            if (recentMessages.size === 0) return 0;
            if (recentMessages.size < 10) return recentMessages.size;
            
            // 基于最新和最旧消息的时间差估算
            const newest = recentMessages.first();
            const oldest = recentMessages.last();
            const timeDiff = newest.createdTimestamp - oldest.createdTimestamp;
            const avgInterval = timeDiff / (recentMessages.size - 1);
            
            // 估算总消息数（粗略）
            const threadAge = Date.now() - thread.channel.createdTimestamp;
            const estimate = Math.min(Math.max(Math.round(threadAge / avgInterval), recentMessages.size), 1000);
            
            return estimate;
        } catch (error) {
            return 1; // 默认为1
        }
    }

    async scanSmallThreadsRapidly(smallThreads, bannedKeywords) {
        console.log(`⚡ 快速扫描 ${smallThreads.length} 个小帖子，超高并发模式`);
        
        // 超高并发：50个小帖子同时处理
        const maxConcurrency = Math.min(50, smallThreads.length);
        
        for (let i = 0; i < smallThreads.length; i += maxConcurrency) {
            if (this.shouldStop) break;

            const batch = smallThreads.slice(i, i + maxConcurrency);
            const batchPromises = batch.map(thread => this.scanSmallThreadOptimized(thread, bannedKeywords));
            
            await Promise.all(batchPromises);
            
            console.log(`⚡ 快速批次完成：${Math.min(i + maxConcurrency, smallThreads.length)}/${smallThreads.length} 个小帖子`);
        }
    }

    async scanSmallThreadOptimized(target, bannedKeywords) {
        try {
            // 小帖子优化：一次性获取所有消息
            const allMessages = await this.rateLimiter.execute(async () => {
                return await target.channel.messages.fetch({ limit: 100 });
            }, 'scan');

            const messageArray = Array.from(allMessages.values());
            let violatingCount = 0;

            // 快速处理所有消息
            for (const message of messageArray) {
                if (this.shouldStop) break;

                try {
                    const checkResult = await this.keywordDetector.checkMessageAdvanced(message, bannedKeywords);
                    
                    if (checkResult.shouldDelete) {
                        violatingCount++;
                        await this.messageCache.addViolatingMessage(message, checkResult.matchedKeywords, target);
                    }
                } catch (error) {
                    console.error(`检查消息时出错:`, error);
                }
            }

            this.totalScanned += messageArray.length;
            this.completedTargets++;

            console.log(`⚡ ${target.type} ${target.name} 快速完成 - 扫描: ${messageArray.length}, 违规: ${violatingCount}`);

            return { scanned: messageArray.length, violating: violatingCount };

        } catch (error) {
            console.error(`❌ 快速扫描 ${target.type} ${target.name} 时出错:`, error);
            this.completedTargets++;
            return { scanned: 0, violating: 0 };
        }
    }

    async scanLargeThreadsNormally(largeThreads, bannedKeywords) {
        console.log(`📚 常规扫描 ${largeThreads.length} 个大帖子`);
        
        const maxConcurrency = Math.min(5, largeThreads.length);
        
        for (let i = 0; i < largeThreads.length; i += maxConcurrency) {
            if (this.shouldStop) break;

            const batch = largeThreads.slice(i, i + maxConcurrency);
            const batchPromises = batch.map(thread => this.scanSingleTarget(thread, bannedKeywords));
            
            await Promise.all(batchPromises);
            
            console.log(`📚 常规批次完成：${Math.min(i + maxConcurrency, largeThreads.length)}/${largeThreads.length} 个大帖子`);
        }
    }

    async scanSingleTarget(target, bannedKeywords) {
        try {
            console.log(`🔍 扫描 ${target.type}: ${target.name}`);
            
            // 检查频道权限
            const permissionCheck = await this.checkChannelPermissions(target.channel);
            if (!permissionCheck.canAccess) {
                console.error(`❌ 权限不足，无法访问 ${target.type}: ${target.name}`);
                console.error(`   缺少权限: ${permissionCheck.missingPermissions.join(', ')}`);
                this.completedTargets++;
                return;
            }
            
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
        let batchNumber = 0;

        console.log(`🔍 开始扫描 ${target.type}: ${target.name}`);

        while (hasMoreMessages && !this.shouldStop) {
            try {
                batchNumber++;
                console.log(`📥 获取第 ${batchNumber} 批消息 - ${target.name}`);
                
                // 简化：使用单次批量获取，避免复杂的并发逻辑
                const collectionResult = await this.collectSingleBatch(target.channel, lastMessageId);
                
                console.log(`📦 获得 ${collectionResult.messages.length} 条消息 - ${target.name}`);
                
                if (collectionResult.messages.length === 0) {
                    console.log(`📭 没有更多消息 - ${target.name}`);
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

                // 每处理一批消息就输出进度
                console.log(`📊 批次 ${batchNumber} 完成 - ${target.name}: 本批 ${batchStats.scanned} 条，累计 ${scannedCount} 条，违规 ${violatingCount} 条`);

                // 更新总计数器
                this.totalScanned += batchStats.scanned;

                // 定期更新进度
                if (batchNumber % 5 === 0 || Date.now() - this.lastStatsUpdate > 3000) {
                    await this.updateProgress();
                    this.lastStatsUpdate = Date.now();
                }

            } catch (error) {
                console.error(`❌ 处理第 ${batchNumber} 批消息时出错 - ${target.name}:`, error);
                if (this.isFatalError(error)) {
                    console.error(`💀 遇到致命错误，停止扫描 - ${target.name}`);
                    break;
                }
                // 非致命错误，等待后继续
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        console.log(`✅ 扫描完成 - ${target.name}: 总计 ${scannedCount} 条消息，${violatingCount} 条违规`);
        return { scanned: scannedCount, violating: violatingCount };
    }

    async collectSingleBatch(channel, lastMessageId) {
        try {
            console.log(`🔄 正在获取消息 - 频道: ${channel.name}${lastMessageId ? `, 从消息ID: ${lastMessageId}` : ' (最新消息)'}`);
            
            const result = await this.rateLimiter.execute(async () => {
                const options = { limit: 100 };
                if (lastMessageId) {
                    options.before = lastMessageId;
                }
                return await channel.messages.fetch(options);
            }, 'scan');

            const messageArray = Array.from(result.values());
            console.log(`📥 成功获取 ${messageArray.length} 条消息 - 频道: ${channel.name}`);
            
            return {
                messages: messageArray,
                lastMessageId: result.size > 0 ? result.last().id : lastMessageId,
                hasMore: result.size === 100
            };
        } catch (error) {
            console.error(`❌ 获取消息失败 - 频道: ${channel.name}:`, error.message);
            
            // 详细的错误代码处理
            switch (error.code) {
                case 50001:
                    console.error(`   → 缺少访问权限 (Missing Access)`);
                    break;
                case 50013:
                    console.error(`   → 权限不足 (Missing Permissions)`);
                    break;
                case 10003:
                    console.error(`   → 频道不存在 (Unknown Channel)`);
                    break;
                case 50034:
                    console.error(`   → 无法在此频道执行操作`);
                    break;
                default:
                    console.error(`   → 未知错误: ${error.code || 'N/A'}`);
            }
            
            return { messages: [], lastMessageId, hasMore: false };
        }
    }

    async processMessagesForCache(messages, bannedKeywords, target) {
        let scannedCount = 0;
        let violatingCount = 0;

        console.log(`🔍 开始检查 ${messages.length} 条消息 - ${target.name}`);

        // 快速批量检查，不执行删除
        for (const message of messages) {
            if (this.shouldStop) {
                console.log(`⏹️ 收到停止信号，中断消息检查 - ${target.name}`);
                break;
            }

            scannedCount++;

            try {
                const checkResult = await this.keywordDetector.checkMessageAdvanced(message, bannedKeywords);
                
                if (checkResult.shouldDelete) {
                    violatingCount++;
                    // 添加到删除缓存，而不是立即删除
                    await this.messageCache.addViolatingMessage(message, checkResult.matchedKeywords, target);
                }
            } catch (error) {
                console.error(`检查消息时出错 (${message.id}):`, error);
            }

            // 每检查100条消息输出一次进度
            if (scannedCount % 100 === 0) {
                console.log(`🔍 已检查 ${scannedCount}/${messages.length} 条消息 - ${target.name}, 发现 ${violatingCount} 条违规`);
            }
        }

        console.log(`✅ 消息检查完成 - ${target.name}: ${scannedCount} 条已检查，${violatingCount} 条违规`);
        return { scanned: scannedCount, violating: violatingCount };
    }

    async updateProgress() {
        // 降低更新频率到5秒
        if (Date.now() - this.lastStatsUpdate < 5000) {
            return;
        }
        
        const cacheStats = this.messageCache.getStats();
        
        await this.taskManager.updateTaskProgress(this.guild.id, this.taskId, {
            completedChannels: this.completedTargets,
            totalMessages: this.totalScanned,
            scannedMessages: this.totalScanned,
            deletedMessages: cacheStats.totalDeleted,
            pendingDeletions: cacheStats.pendingDeletions
        });

        // 减少Discord消息更新频率
        if (this.progressTracker && Date.now() - this.lastStatsUpdate > 8000) {
            await this.progressTracker.updateProgressWithCache(this.totalScanned, cacheStats);
        }
        
        this.lastStatsUpdate = Date.now();
    }

    isFatalError(error) {
        const fatalErrorCodes = [50013, 50001, 10003];
        return fatalErrorCodes.includes(error.code);
    }

    async getAllScanTargets() {
        const targets = [];
        let exemptCount = 0;
        let accessDeniedCount = 0;
        
        try {
            // 获取所有频道
            const channels = await this.guild.channels.fetch();
            
            for (const [channelId, channel] of channels) {
                // 基础权限检查
                if (!channel.viewable) {
                    console.log(`⚠️ 频道不可见: ${channel.name}`);
                    accessDeniedCount++;
                    continue;
                }

                // 详细权限检查
                const permissionCheck = await this.checkChannelPermissions(channel);
                if (!permissionCheck.canAccess) {
                    console.error(`❌ 权限不足，跳过频道: ${channel.name}`);
                    console.error(`   缺少权限: ${permissionCheck.missingPermissions.join(', ')}`);
                    accessDeniedCount++;
                    continue;
                }

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
            console.log(`❌ 权限不足频道: ${accessDeniedCount} 个`);
            
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

    // 更精细的帖子分类

    async categorizeThreadsAdvanced(threads) {
        const tinyThreads = [];   // ≤10条消息
        const smallThreads = [];  // 11-50条消息
        const mediumThreads = []; // 51-200条消息
        const largeThreads = [];  // >200条消息
        
        for (const thread of threads) {
            const messageCount = thread.channel.messageCount || thread.channel.totalMessagesSent || 0;
            const threadData = { 
                ...thread, 
                actualMessageCount: messageCount 
            };
            
            if (messageCount <= 10) {
                tinyThreads.push(threadData);
            } else if (messageCount <= 50) {
                smallThreads.push(threadData);
            } else if (messageCount <= 200) {
                mediumThreads.push(threadData);
            } else {
                largeThreads.push(threadData);
            }
        }
        
        console.log(`📊 精细分类完成：`);
        console.log(`  🔹 微型帖子 (≤10条): ${tinyThreads.length} 个`);
        console.log(`  🔸 小帖子 (11-50条): ${smallThreads.length} 个`);
        console.log(`  🔶 中型帖子 (51-200条): ${mediumThreads.length} 个`);
        console.log(`  🔺 大型帖子 (>200条): ${largeThreads.length} 个`);
        
        return { tinyThreads, smallThreads, mediumThreads, largeThreads };
    }

    async scanThreadsInParallelAdvanced(threads, bannedKeywords) {
        console.log(`🚀 开始智能并行扫描 ${threads.length} 个帖子`);

        const { tinyThreads, smallThreads, mediumThreads, largeThreads } = 
            await this.categorizeThreadsAdvanced(threads);

        // 微型帖子：超高并发（100个同时）
        if (tinyThreads.length > 0) {
            await this.scanTinyThreadsUltraRapid(tinyThreads, bannedKeywords);
        }

        // 小帖子：高并发（50个同时）
        if (smallThreads.length > 0) {
            await this.scanSmallThreadsRapidly(smallThreads, bannedKeywords);
        }

        // 中型帖子：中等并发（20个同时）
        if (mediumThreads.length > 0) {
            await this.scanMediumThreadsModerately(mediumThreads, bannedKeywords);
        }

        // 大型帖子：低并发（5个同时）
        if (largeThreads.length > 0) {
            await this.scanLargeThreadsNormally(largeThreads, bannedKeywords);
        }
    }

    async scanTinyThreadsUltraRapid(tinyThreads, bannedKeywords) {
        console.log(`⚡⚡ 超高速扫描 ${tinyThreads.length} 个微型帖子 (≤10条消息)`);
        
        // 超超高并发：100个微型帖子同时处理
        const maxConcurrency = Math.min(100, tinyThreads.length);
        
        for (let i = 0; i < tinyThreads.length; i += maxConcurrency) {
            if (this.shouldStop) break;

            const batch = tinyThreads.slice(i, i + maxConcurrency);
            const batchPromises = batch.map(thread => this.scanTinyThreadOptimized(thread, bannedKeywords));
            
            await Promise.all(batchPromises);
            
            console.log(`⚡⚡ 超高速批次完成：${Math.min(i + maxConcurrency, tinyThreads.length)}/${tinyThreads.length} 个微型帖子`);
        }
    }

    async scanTinyThreadOptimized(target, bannedKeywords) {
        try {
            // 微型帖子：期望消息很少，一次性获取所有
            const allMessages = await this.rateLimiter.execute(async () => {
                return await target.channel.messages.fetch({ limit: Math.min(100, target.actualMessageCount + 10) });
            }, 'scan');

            const messageArray = Array.from(allMessages.values());
            let violatingCount = 0;

            // 极快处理
            for (const message of messageArray) {
                if (this.shouldStop) break;

                const checkResult = await this.keywordDetector.checkMessageAdvanced(message, bannedKeywords);
                
                if (checkResult.shouldDelete) {
                    violatingCount++;
                    await this.messageCache.addViolatingMessage(message, checkResult.matchedKeywords, target);
                }
            }

            this.totalScanned += messageArray.length;
            this.completedTargets++;

            // 只有在扫描数量与预期差异较大时才输出日志
            if (Math.abs(messageArray.length - target.actualMessageCount) > 2) {
                console.log(`⚡ ${target.name}: 预期${target.actualMessageCount}条，实际${messageArray.length}条，违规${violatingCount}条`);
            }

            return { scanned: messageArray.length, violating: violatingCount };

        } catch (error) {
            console.error(`❌ 超高速扫描 ${target.name} 失败:`, error);
            this.completedTargets++;
            return { scanned: 0, violating: 0 };
        }
    }

    async startSelectedChannels(taskData, selectedChannels) {
        if (this.isRunning) {
            throw new Error('扫描器已在运行中');
        }

        this.isRunning = true;
        this.shouldStop = false;
        this.taskId = taskData.taskId;

        try {
            console.log(`🔍 开始指定频道扫描 - Guild: ${this.guild.id}, 频道数: ${selectedChannels.length}`);
            
            // 获取违禁关键字
            const bannedKeywords = await getBannedKeywords(this.guild.id);
            if (bannedKeywords.length === 0) {
                throw new Error('没有设置违禁关键字，无法进行清理');
            }

            // 从选择的频道生成扫描目标
            const scanTargets = await this.getSelectedChannelTargets(selectedChannels);

            console.log(`📋 从 ${selectedChannels.length} 个选择频道生成 ${scanTargets.length} 个扫描目标`);
            
            // 更新任务进度
            await this.taskManager.updateTaskProgress(this.guild.id, this.taskId, {
                totalChannels: scanTargets.length
            });

            // 通知开始扫描
            if (this.progressTracker) {
                await this.progressTracker.setTotalChannels(scanTargets.length);
            }

            let totalDeleted = 0;
            let totalScanned = 0;
            let completedTargets = 0;

            // 分组处理：普通频道 vs 帖子
            const regularChannels = scanTargets.filter(target => 
                !target.type.includes('帖子') && !target.type.includes('论坛帖子')
            );
            const threads = scanTargets.filter(target => 
                target.type.includes('帖子') || target.type.includes('论坛帖子')
            );

            console.log(`📊 分组统计：${regularChannels.length} 个普通频道，${threads.length} 个帖子`);

            // 先扫描普通频道
            for (const target of regularChannels) {
                if (this.shouldStop) break;
                await this.scanSingleTarget(target, bannedKeywords);
            }

            // 并行扫描帖子
            if (threads.length > 0) {
                await this.scanThreadsInParallelAdvanced(threads, bannedKeywords);
            }

            // 扫描完成，执行最终删除
            console.log(`🔄 指定频道扫描完成，开始最终删除批次...`);
            await this.messageCache.finalFlush();

            // 完成任务
            const cacheStats = this.messageCache.getStats();
            const finalStats = {
                totalChannelsScanned: this.completedTargets,
                totalMessagesScanned: this.totalScanned,
                totalMessagesDeleted: cacheStats.totalDeleted,
                totalUnlockOperations: cacheStats.unlockOperations,
                completedNormally: !this.shouldStop,
                taskType: 'selectedChannels',
                selectedChannelsCount: selectedChannels.length
            };

            if (this.shouldStop) {
                await this.taskManager.stopTask(this.guild.id, this.taskId, 'user_requested');
            } else {
                await this.taskManager.completeTask(this.guild.id, this.taskId, finalStats);
            }

            if (this.progressTracker) {
                await this.progressTracker.complete(finalStats);
            }

            console.log(`🎉 指定频道扫描完成 - 扫描 ${this.totalScanned} 条消息，删除 ${cacheStats.totalDeleted} 条违规消息`);
            
            return finalStats;

        } catch (error) {
            console.error('❌ 指定频道扫描时出错:', error);
            
            await this.taskManager.stopTask(this.guild.id, this.taskId, 'error');
            
            if (this.progressTracker) {
                await this.progressTracker.error(error);
            }
            
            throw error;
        } finally {
            this.isRunning = false;
        }
    }

    async getSelectedChannelTargets(selectedChannels) {
        const targets = [];
        let exemptCount = 0;
        let accessDeniedCount = 0;
        
        try {
            for (const channelInput of selectedChannels) {
                let channel;
                let channelId;
                
                // 处理不同的输入格式
                if (typeof channelInput === 'string') {
                    // 如果是字符串，可能包含提及格式 <#123456789>
                    channelId = channelInput.replace(/[<#>]/g, ''); // 移除 <# > 字符
                    channel = await this.guild.channels.fetch(channelId);
                } else if (channelInput && channelInput.id) {
                    // 如果是Discord.js Channel对象
                    channel = channelInput;
                    channelId = channel.id;
                } else {
                    console.error(`❌ 无效的频道输入:`, channelInput);
                    continue;
                }
                
                if (!channel) {
                    console.error(`❌ 找不到频道: ${channelId}`);
                    continue;
                }

                console.log(`🔍 检查选定频道: ${channel.name} (${channel.type})`);

                // 详细权限检查
                const permissionCheck = await this.checkChannelPermissions(channel);
                if (!permissionCheck.canAccess) {
                    console.error(`❌ 权限不足，跳过选定频道: ${channel.name}`);
                    console.error(`   缺少权限: ${permissionCheck.missingPermissions.join(', ')}`);
                    accessDeniedCount++;
                    continue;
                }

                // 检查频道是否被豁免  
                const isExempt = await isChannelExempt(this.guild.id, channelId);
                if (isExempt) {
                    exemptCount++;
                    console.log(`⏭️ 跳过豁免的选定频道: ${channel.name}`);
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
                        console.log(`📋 正在获取选定论坛频道 ${channel.name} 的子帖子...`);
                        const forumThreads = await this.getForumThreads(channel);
                        targets.push(...forumThreads);
                        break;

                    case ChannelType.PublicThread:
                    case ChannelType.PrivateThread:
                        // 子帖子
                        const isLocked = channel.locked || channel.archived;
                        targets.push({
                            id: channelId,
                            name: channel.name,
                            type: isLocked ? '已锁定子帖子' : '子帖子',
                            channel: channel,
                            isLocked: isLocked,
                            parentForum: channel.parent ? channel.parent.name : null
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

                    default:
                        console.log(`⚠️ 不支持的频道类型: ${channel.name} (${channel.type})`);
                }
            }

            console.log(`📊 选定频道扫描目标统计:`);
            if (exemptCount > 0) {
                console.log(`⏭️ 豁免频道: ${exemptCount} 个`);
            }
            if (accessDeniedCount > 0) {
                console.log(`❌ 权限不足频道: ${accessDeniedCount} 个`);
            }

            const typeStats = {};
            targets.forEach(target => {
                typeStats[target.type] = (typeStats[target.type] || 0) + 1;
            });
            
            for (const [type, count] of Object.entries(typeStats)) {
                console.log(`  - ${type}: ${count} 个`);
            }

        } catch (error) {
            console.error('获取选定频道扫描目标时出错:', error);
        }

        return targets;
    }

    // 新增权限检查方法
    async checkChannelPermissions(channel) {
        try {
            const botMember = await channel.guild.members.fetch(channel.guild.members.me.id);
            const permissions = channel.permissionsFor(botMember);
            
            const requiredPermissions = [
                'ViewChannel',
                'ReadMessageHistory',
                'ManageMessages'
            ];
            
            const missingPermissions = [];
            let canAccess = true;
            
            for (const permission of requiredPermissions) {
                if (!permissions.has(permission)) {
                    missingPermissions.push(permission);
                    canAccess = false;
                }
            }
            
            // 额外检查：尝试获取一条消息来验证实际访问能力
            if (canAccess) {
                try {
                    await channel.messages.fetch({ limit: 1 });
                    console.log(`✅ 权限验证通过: ${channel.name}`);
                } catch (error) {
                    console.error(`⚠️ 权限验证失败: ${channel.name} - ${error.message}`);
                    if (error.code === 50001) { // Missing Access
                        missingPermissions.push('实际访问权限');
                        canAccess = false;
                    } else if (error.code === 50013) { // Missing Permissions
                        missingPermissions.push('缺少必要权限');
                        canAccess = false;
                    }
                }
            }
            
            return {
                canAccess,
                missingPermissions
            };
            
        } catch (error) {
            console.error(`权限检查失败:`, error);
            return {
                canAccess: false,
                missingPermissions: ['权限检查失败']
            };
        }
    }
}

module.exports = { FullServerScanner }; 