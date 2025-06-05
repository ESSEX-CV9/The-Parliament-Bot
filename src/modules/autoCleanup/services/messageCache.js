class MessageCache {
    constructor(rateLimiter, batchSize = 3000) {
        this.rateLimiter = rateLimiter;
        this.batchSize = batchSize;
        this.violatingMessages = []; // 待删除消息缓存
        this.isDeleting = false;
        this.totalScanned = 0;
        this.totalDeleted = 0;
        this.unlockOperations = 0;
    }

    // 添加违规消息到缓存
    async addViolatingMessage(message, matchedKeywords, target) {
        this.violatingMessages.push({
            message,
            matchedKeywords,
            target,
            timestamp: Date.now()
        });

        // 检查是否需要批量删除
        if (this.violatingMessages.length >= this.batchSize) {
            await this.flushDeletions();
        }
    }

    // 批量删除缓存中的消息
    async flushDeletions() {
        if (this.isDeleting || this.violatingMessages.length === 0) {
            return;
        }

        this.isDeleting = true;
        const messagesToDelete = [...this.violatingMessages];
        this.violatingMessages = []; // 清空缓存

        console.log(`🗑️ 开始批量删除 ${messagesToDelete.length} 条违规消息...`);

        let deletedCount = 0;
        let unlockCount = 0;

        for (const item of messagesToDelete) {
            try {
                // 处理锁定帖子的删除
                const wasLocked = await this.handleLockedThreadDeletion(item.message, item.target);
                if (wasLocked) unlockCount++;

                deletedCount++;

                const channelInfo = item.target.parentForum ? 
                    `${item.target.parentForum}/${item.target.name}` : 
                    item.target.name;
                
                if (deletedCount % 100 === 0) { // 每100条消息输出一次日志
                    console.log(`🗑️ 已删除 ${deletedCount}/${messagesToDelete.length} 条违规消息...`);
                }

            } catch (error) {
                console.error(`删除消息失败:`, error);
            }
        }

        this.totalDeleted += deletedCount;
        this.unlockOperations += unlockCount;

        console.log(`✅ 批量删除完成：${deletedCount} 条消息，${unlockCount} 次解锁操作`);
        this.isDeleting = false;
    }

    // 处理锁定帖子删除（修复版本）
    async handleLockedThreadDeletion(message, target) {
        const isThread = message.channel.isThread && message.channel.isThread();
        if (!isThread || !target.isLocked) {
            // 普通频道或非锁定线程，直接删除
            await this.rateLimiter.execute(async () => {
                await message.delete();
            }, 'delete');
            return false;
        }

        const thread = message.channel;
        let wasLocked = false;

        try {
            const permissions = thread.permissionsFor(thread.guild.members.me);
            if (!permissions.has(['ManageThreads', 'ManageMessages'])) {
                throw new Error('权限不足，无法管理锁定帖子');
            }

            // 使用target中存储的原始状态
            const originalLocked = target.originalLocked || false;
            const originalArchived = target.originalArchived || false;
            
            console.log(`🔓 处理锁定线程 ${thread.name}: 锁定=${originalLocked}, 归档=${originalArchived}`);
            
            if (originalLocked || originalArchived) {
                wasLocked = true;
                
                // 先解除归档状态（必须在解锁之前）
                if (originalArchived) {
                    try {
                        await this.rateLimiter.execute(async () => {
                            await thread.setArchived(false, '临时恢复以删除违规消息');
                        }, 'other');
                        console.log(`📂 已取消归档: ${thread.name}`);
                        
                        // 等待状态更新，并验证
                        await new Promise(resolve => setTimeout(resolve, 800));
                        
                        // 验证归档状态是否已更改
                        const refreshedThread = await thread.fetch();
                        if (refreshedThread.archived) {
                            console.warn(`⚠️ 线程 ${thread.name} 仍处于归档状态，等待更长时间`);
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }
                    } catch (unarchiveError) {
                        console.error(`❌ 取消归档失败: ${thread.name} - ${unarchiveError.message}`);
                        throw new Error(`无法取消归档线程 ${thread.name}: ${unarchiveError.message}`);
                    }
                }
                
                // 再解除锁定状态
                if (originalLocked) {
                    try {
                        await this.rateLimiter.execute(async () => {
                            await thread.setLocked(false, '临时解锁以删除违规消息');
                        }, 'other');
                        console.log(`🔓 已解锁: ${thread.name}`);
                        
                        // 等待状态更新
                        await new Promise(resolve => setTimeout(resolve, 500));
                        
                        // 验证锁定状态是否已更改
                        const refreshedThread = await thread.fetch();
                        if (refreshedThread.locked) {
                            console.warn(`⚠️ 线程 ${thread.name} 仍处于锁定状态，等待更长时间`);
                            await new Promise(resolve => setTimeout(resolve, 800));
                        }
                    } catch (unlockError) {
                        console.error(`❌ 解锁失败: ${thread.name} - ${unlockError.message}`);
                        throw new Error(`无法解锁线程 ${thread.name}: ${unlockError.message}`);
                    }
                }

                // 重新获取线程对象以确保状态最新
                try {
                    const refreshedThread = await thread.fetch();
                    console.log(`🔄 刷新线程状态: ${refreshedThread.name} - 锁定=${refreshedThread.locked}, 归档=${refreshedThread.archived}`);
                } catch (fetchError) {
                    console.warn(`⚠️ 无法刷新线程状态，继续执行删除: ${fetchError.message}`);
                }
            }

            // 删除消息
            try {
                await this.rateLimiter.execute(async () => {
                    await message.delete();
                }, 'delete');

                console.log(`🗑️ 已删除消息: ${message.id} 从线程 ${thread.name}`);
            } catch (deleteError) {
                // 如果删除失败，检查是否是因为线程状态问题
                if (deleteError.code === 50083) { // Thread is archived
                    console.error(`❌ 删除失败：线程 ${thread.name} 仍然是归档状态`);
                    
                    // 最后一次尝试刷新并取消归档
                    try {
                        const finalRefresh = await thread.fetch();
                        console.log(`🔄 最终状态检查: ${finalRefresh.name} - 锁定=${finalRefresh.locked}, 归档=${finalRefresh.archived}`);
                        
                        if (finalRefresh.archived) {
                            await this.rateLimiter.execute(async () => {
                                await finalRefresh.setArchived(false, '最后尝试取消归档');
                            }, 'other');
                            
                            await new Promise(resolve => setTimeout(resolve, 1000));
                            
                            // 再次尝试删除
                            await this.rateLimiter.execute(async () => {
                                await message.delete();
                            }, 'delete');
                            
                            console.log(`🗑️ 二次尝试成功删除消息: ${message.id}`);
                        } else {
                            throw deleteError; // 如果不是归档问题，重新抛出错误
                        }
                    } catch (finalAttemptError) {
                        console.error(`❌ 最终删除尝试失败: ${finalAttemptError.message}`);
                        throw new Error(`无法删除消息 ${message.id} 从线程 ${thread.name}: ${finalAttemptError.message}`);
                    }
                } else {
                    console.error(`❌ 删除消息失败: ${deleteError.message}`);
                    throw deleteError;
                }
            }

            // 恢复原始状态
            if (wasLocked) {
                // 先恢复锁定状态
                if (originalLocked) {
                    await this.rateLimiter.execute(async () => {
                        await thread.setLocked(true, '恢复锁定状态');
                    }, 'other');
                    console.log(`🔒 已重新锁定: ${thread.name}`);
                }
                
                // 再恢复归档状态
                if (originalArchived) {
                    await this.rateLimiter.execute(async () => {
                        await thread.setArchived(true, '恢复归档状态');
                    }, 'other');
                    console.log(`📁 已重新归档: ${thread.name}`);
                }
            }

            return wasLocked;

        } catch (error) {
            console.error(`❌ 处理锁定线程删除失败 (${thread.name}):`, error);
            
            // 错误恢复：尝试恢复原始状态
            if (wasLocked) {
                try {
                    if (target.originalLocked) {
                        await this.rateLimiter.execute(async () => {
                            await thread.setLocked(true, '错误恢复：恢复锁定状态');
                        }, 'other');
                    }
                    if (target.originalArchived) {
                        await this.rateLimiter.execute(async () => {
                            await thread.setArchived(true, '错误恢复：恢复归档状态');
                        }, 'other');
                    }
                    console.log(`🔄 已恢复线程状态: ${thread.name}`);
                } catch (recoveryError) {
                    console.error(`❌ 恢复线程状态失败: ${recoveryError.message}`);
                }
            }
            
            throw error;
        }
    }

    // 获取统计信息
    getStats() {
        return {
            pendingDeletions: this.violatingMessages.length,
            totalDeleted: this.totalDeleted,
            unlockOperations: this.unlockOperations,
            isDeleting: this.isDeleting
        };
    }

    // 扫描完成后的最终清理
    async finalFlush() {
        if (this.violatingMessages.length > 0) {
            console.log(`🔄 扫描完成，执行最终删除 ${this.violatingMessages.length} 条违规消息...`);
            await this.flushDeletions();
        }
    }
}

module.exports = { MessageCache }; 