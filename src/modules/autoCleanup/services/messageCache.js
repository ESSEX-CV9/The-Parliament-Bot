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

    // 处理锁定帖子删除（复用现有逻辑）
    async handleLockedThreadDeletion(message, target) {
        const isThread = message.channel.isThread && message.channel.isThread();
        if (!isThread || !target.isLocked) {
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

            const originalLocked = thread.locked;
            const originalArchived = thread.archived;
            
            if (originalLocked || originalArchived) {
                wasLocked = true;
                
                await this.rateLimiter.execute(async () => {
                    if (originalArchived) {
                        await thread.setArchived(false, '临时恢复以删除违规消息');
                    }
                    if (originalLocked) {
                        await thread.setLocked(false, '临时解锁以删除违规消息');
                    }
                }, 'other');

                await new Promise(resolve => setTimeout(resolve, 200));
            }

            await this.rateLimiter.execute(async () => {
                await message.delete();
            }, 'delete');

            if (wasLocked) {
                await this.rateLimiter.execute(async () => {
                    if (originalLocked) {
                        await thread.setLocked(true, '恢复锁定状态');
                    }
                    if (originalArchived) {
                        await thread.setArchived(true, '恢复归档状态');
                    }
                }, 'other');
            }

            return wasLocked;

        } catch (error) {
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