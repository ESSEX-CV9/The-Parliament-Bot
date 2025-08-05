const { EmbedBuilder } = require('discord.js');

class ProgressManager {
    constructor(interaction, totalItems) {
        this.interaction = interaction;
        this.totalItems = totalItems;
        this.processedCount = 0;
        this.successCount = 0;
        this.failCount = 0;
        this.updateCounter = 0; // 新增：用于计数的计数器
        this.startTime = Date.now();
        this.progressMessage = null;
        this.status = '运行中...';
        this.currentTasks = new Set();
    }

    // 创建初始进度消息
    async start() {
        const embed = this.buildEmbed();
        // 移除 ephemeral: true，确保消息是公开的
        this.progressMessage = await this.interaction.editReply({ embeds: [embed] });
    }

    // 更新进度
    update(success, taskName = null) {
        this.processedCount++;
        this.updateCounter++;
        if (success) {
            this.successCount++;
        } else {
            this.failCount++;
        }
        if (taskName) {
            this.currentTasks.delete(taskName);
        }
        
        // 每处理10个，或者任务已全部完成，才调度一次更新
        if (this.updateCounter >= 10 || this.processedCount === this.totalItems) {
            this.scheduleUpdate();
            this.updateCounter = 0; // 重置计数器
        }
    }
    
    // 添加一个正在处理的任务
    addTask(taskName) {
        this.currentTasks.add(taskName);
    }

    // 使用防抖/延迟执行来调度更新
    scheduleUpdate() {
        // 如果已经有计划的更新，则清除它
        if (this.updateTimeout) {
            clearTimeout(this.updateTimeout);
        }
        // 设置一个新的更新计划
        this.updateTimeout = setTimeout(() => {
            if (this.progressMessage) {
                const embed = this.buildEmbed();
                this.progressMessage.edit({ embeds: [embed] }).catch(err => {
                    // 如果消息被删除或交互失效，则停止后续更新尝试
                    if (err.code === 10008) {
                        this.progressMessage = null;
                    }
                    console.error('进度更新失败:', err);
                });
            }
        }, 1500); // 在最后一次调用后等待1.5秒再更新
    }

    // 完成
    async finish(finalStatus = '完成') {
        // 清除任何待定的更新计划
        if (this.updateTimeout) {
            clearTimeout(this.updateTimeout);
            this.updateTimeout = null;
        }
        
        this.status = finalStatus;
        const embed = this.buildEmbed();

        // 强制等待，以确保与上一次API调用有足够的时间间隔，避免速率限制
        await new Promise(resolve => setTimeout(resolve, 1500));

        if (this.progressMessage) {
            try {
                await this.progressMessage.edit({ embeds: [embed] });
            } catch (error) {
                console.error('编辑最终进度消息失败 (延迟后):', error);
                // 保留最后的备用方案，以防万一
                if (error.code === 10008) {
                    await this.interaction.followUp({ embeds: [embed], ephemeral: true }).catch(console.error);
                }
            }
        } else {
            // 如果 progressMessage 从未被创建或中途失效
            await this.interaction.followUp({ embeds: [embed], ephemeral: true }).catch(console.error);
        }
    }

    // 构建Embed
    buildEmbed() {
        const percentage = this.totalItems > 0 ? Math.round((this.processedCount / this.totalItems) * 100) : 0;
        const elapsedTime = Math.round((Date.now() - this.startTime) / 1000);
        const itemsPerSecond = elapsedTime > 0 ? (this.processedCount / elapsedTime).toFixed(2) : 0;

        let description = `**进度**: ${this.processedCount} / ${this.totalItems} (${percentage}%)\n` +
                          `**状态**: ${this.status}\n\n` +
                          `✅ **成功**: ${this.successCount}\n` +
                          `❌ **失败**: ${this.failCount}\n\n` +
                          `⏱️ **已用时**: ${elapsedTime} 秒\n` +
                          `⚡ **速度**: ${itemsPerSecond} 个/秒`;
                          
        if (this.currentTasks.size > 0) {
            description += `\n\n**正在处理:**\n- ${[...this.currentTasks].slice(0, 5).join('\n- ')}`;
        }

        return new EmbedBuilder()
            .setTitle('📊 全频道补档扫描进度')
            .setColor(this.status === '运行中...' ? '#0099ff' : '#00ff00')
            .setDescription(description)
            .setTimestamp();
    }
    
}

module.exports = ProgressManager;