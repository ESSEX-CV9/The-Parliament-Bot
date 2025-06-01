const { KeywordDetector } = require('./keywordDetector');
const { getBannedKeywords, isChannelExempt, isForumThreadExempt } = require('../../../core/utils/database');
const { ChannelType } = require('discord.js');

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

            // 获取所有可扫描的频道和子帖子
            const scanTargets = await this.getAllScanTargets();

            console.log(`📋 找到 ${scanTargets.length} 个可扫描的目标（包括频道、论坛帖子等）`);
            
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

            // 扫描每个目标
            for (const target of scanTargets) {
                if (this.shouldStop) {
                    console.log('⏹️ 扫描被用户停止');
                    break;
                }

                try {
                    console.log(`🔍 扫描 ${target.type}: ${target.name} (${target.id})`);
                    
                    // 更新当前扫描的目标
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

                    const targetStats = await this.scanTarget(target, bannedKeywords);
                    
                    totalDeleted += targetStats.deleted;
                    totalScanned += targetStats.scanned;
                    completedTargets++;

                    // 更新进度
                    await this.taskManager.updateTaskProgress(this.guild.id, this.taskId, {
                        completedChannels: completedTargets,
                        totalMessages: totalScanned,
                        scannedMessages: totalScanned,
                        deletedMessages: totalDeleted
                    });

                    if (this.progressTracker) {
                        await this.progressTracker.completeChannel(target.id, targetStats);
                    }

                    console.log(`✅ ${target.type} ${target.name} 扫描完成 - 扫描: ${targetStats.scanned}, 删除: ${targetStats.deleted}`);

                } catch (error) {
                    console.error(`❌ 扫描 ${target.type} ${target.name} 时出错:`, error);
                    completedTargets++; // 仍然计入完成数，避免进度卡住
                }
            }

            // 完成任务
            const finalStats = {
                totalChannelsScanned: completedTargets,
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

    async scanTarget(target, bannedKeywords) {
        let lastMessageId = null;
        let hasMoreMessages = true;
        let scannedCount = 0;
        let deletedCount = 0;
        let permissionErrors = 0;

        while (hasMoreMessages && !this.shouldStop) {
            try {
                // 获取消息，遵守API限制
                const messages = await this.rateLimiter.execute(async () => {
                    const options = { limit: 100 };
                    if (lastMessageId) {
                        options.before = lastMessageId;
                    }
                    return await target.channel.messages.fetch(options);
                });

                if (messages.size === 0) {
                    hasMoreMessages = false;
                    break;
                }

                // 处理这批消息
                const batchStats = await this.processMessageBatch(messages, bannedKeywords, target);
                scannedCount += batchStats.scanned;
                deletedCount += batchStats.deleted;
                permissionErrors += batchStats.permissionErrors;

                // 更新lastMessageId为最后一条消息的ID
                lastMessageId = messages.last().id;

                // 更新进度
                if (this.progressTracker) {
                    await this.progressTracker.updateProgress(target.id, batchStats.scanned);
                }

                // 小延迟避免过快请求
                await new Promise(resolve => setTimeout(resolve, 200));

            } catch (error) {
                console.error(`处理 ${target.type} ${target.name} 中的消息时出错:`, error);
                
                // 如果是权限错误，记录并跳过
                if (error.code === 50013) {
                    console.log(`⚠️ 没有权限访问 ${target.type} ${target.name}，跳过`);
                    break;
                } else if (error.code === 50001) {
                    console.log(`⚠️ 缺少访问权限 ${target.type} ${target.name}，跳过`);
                    break;
                } else if (error.code === 10003) {
                    console.log(`⚠️ ${target.type} ${target.name} 不存在或已被删除，跳过`);
                    break;
                }
                
                // 其他错误也跳过这个目标
                break;
            }
        }

        // 如果有权限错误，在日志中说明
        if (permissionErrors > 0) {
            console.log(`⚠️ ${target.type} ${target.name}: ${permissionErrors} 条消息因权限不足无法删除`);
        }

        return { scanned: scannedCount, deleted: deletedCount, permissionErrors };
    }

    async processMessageBatch(messages, bannedKeywords, target) {
        let scannedCount = 0;
        let deletedCount = 0;
        let permissionErrors = 0;
        let unlockOperations = 0;

        for (const [messageId, message] of messages) {
            if (this.shouldStop) break;

            scannedCount++;

            try {
                // 检查消息是否包含违禁关键字
                const checkResult = await this.keywordDetector.checkMessageAdvanced(message, bannedKeywords);
                
                if (checkResult.shouldDelete) {
                    try {
                        // 检查帖子是否锁定，如果是则先解锁
                        const wasLocked = await this.handleLockedThreadDeletion(message, target);
                        if (wasLocked) unlockOperations++;
                        
                        deletedCount++;
                        
                        const channelInfo = target.parentForum ? `${target.parentForum}/${target.name}` : target.name;
                        const lockStatus = wasLocked ? ' (解锁后删除)' : '';
                        console.log(`🗑️ 删除违规消息${lockStatus} - ${target.type}: ${channelInfo}, 作者: ${message.author.tag}, 关键字: ${checkResult.matchedKeywords.join(', ')}`);
                        
                    } catch (deleteError) {
                        // 记录删除失败的原因
                        if (deleteError.code === 50013) {
                            permissionErrors++;
                            console.log(`⚠️ 权限不足，无法删除消息 - ${target.type}: ${target.name}, 作者: ${message.author.tag}`);
                        } else if (deleteError.code === 10008) {
                            console.log(`⚠️ 消息已不存在 - ${target.type}: ${target.name}, ID: ${messageId}`);
                        } else {
                            console.error(`❌ 删除消息失败 - ${target.type}: ${target.name}, ID: ${messageId}:`, deleteError);
                        }
                    }
                }
            } catch (error) {
                console.error(`处理消息 ${messageId} 时出错:`, error);
                // 继续处理其他消息
            }
        }

        if (unlockOperations > 0) {
            console.log(`🔓 ${target.type} ${target.name}: 执行了 ${unlockOperations} 次解锁操作来删除违规消息`);
        }

        return { scanned: scannedCount, deleted: deletedCount, permissionErrors, unlockOperations };
    }

    async handleLockedThreadDeletion(message, target) {
        // 检查是否是帖子类型且被锁定
        const isThread = message.channel.isThread && message.channel.isThread();
        if (!isThread || !target.isLocked) {
            // 普通删除
            await this.rateLimiter.execute(async () => {
                await message.delete();
            });
            return false;
        }

        const thread = message.channel;
        let wasLocked = false;

        try {
            // 检查机器人权限
            const permissions = thread.permissionsFor(this.guild.members.me);
            if (!permissions.has(['ManageThreads', 'ManageMessages'])) {
                console.log(`⚠️ 权限不足，无法管理锁定帖子: ${thread.name}`);
                throw new Error('权限不足，无法管理锁定帖子');
            }

            // 记录原始锁定状态
            const originalLocked = thread.locked;
            const originalArchived = thread.archived;
            
            if (originalLocked || originalArchived) {
                wasLocked = true;
                
                // 步骤1: 解锁/恢复帖子
                await this.rateLimiter.execute(async () => {
                    if (originalArchived) {
                        await thread.setArchived(false, '临时恢复以删除违规消息');
                        console.log(`🔓 临时恢复归档帖子: ${thread.name}`);
                    }
                    if (originalLocked) {
                        await thread.setLocked(false, '临时解锁以删除违规消息');
                        console.log(`🔓 临时解锁帖子: ${thread.name}`);
                    }
                });

                // 小延迟确保状态更新
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            // 步骤2: 删除违规消息
            await this.rateLimiter.execute(async () => {
                await message.delete();
            });

            // 步骤3: 恢复原始锁定状态
            if (wasLocked) {
                await this.rateLimiter.execute(async () => {
                    if (originalLocked) {
                        await thread.setLocked(true, '恢复锁定状态');
                        console.log(`🔒 重新锁定帖子: ${thread.name}`);
                    }
                    if (originalArchived) {
                        await thread.setArchived(true, '恢复归档状态');
                        console.log(`📦 重新归档帖子: ${thread.name}`);
                    }
                });
            }

            return wasLocked;

        } catch (error) {
            // 如果删除失败，确保帖子恢复到原始状态
            if (wasLocked) {
                try {
                    console.log(`⚠️ 删除失败，尝试恢复帖子状态: ${thread.name}`);
                    await this.rateLimiter.execute(async () => {
                        if (thread.locked !== target.isLocked) {
                            await thread.setLocked(target.isLocked, '恢复原始锁定状态');
                        }
                    });
                } catch (restoreError) {
                    console.error(`❌ 恢复帖子状态失败: ${thread.name}:`, restoreError);
                }
            }
            throw error;
        }
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