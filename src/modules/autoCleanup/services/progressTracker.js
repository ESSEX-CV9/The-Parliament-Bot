const { EmbedBuilder } = require('discord.js');

class ProgressTracker {
    constructor(responseChannel, guild, isPartialCleanup = false) {
        this.responseChannel = responseChannel;
        this.guild = guild;
        this.isPartialCleanup = isPartialCleanup;
        this.totalChannels = 0;
        this.completedChannels = 0;
        this.totalScanned = 0;
        this.totalDeleted = 0;
        this.totalUnlockOperations = 0;
        this.pendingDeletions = 0;
        this.startTime = Date.now();
        this.progressMessage = null;
        this.currentChannel = null;
        this.updateInterval = null;
        this.lastUpdateTime = 0;
        this.minUpdateInterval = 5000;
    }

    async setTotalChannels(count) {
        this.totalChannels = count;
        await this.sendInitialMessage();
        this.startPeriodicUpdates();
    }

    async sendInitialMessage() {
        const title = this.isPartialCleanup ? '🔍 指定频道清理已开始' : '🔍 全服务器清理已开始';
        const description = this.isPartialCleanup ? 
            `正在扫描服务器 **${this.guild.name}** 中的指定频道...` :
            `正在扫描服务器 **${this.guild.name}** 中的所有消息...`;

        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
            .addFields(
                { name: '📊 扫描进度', value: `0/${this.totalChannels} (0%)`, inline: true },
                { name: '🔍 已扫描消息', value: '0', inline: true },
                { name: '🗑️ 已删除消息', value: '0', inline: true },
                { name: '⏱️ 开始时间', value: `<t:${Math.floor(this.startTime / 1000)}:R>`, inline: true },
                { name: '📍 当前目标', value: '准备中...', inline: true },
                { name: '⏲️ 用时', value: '0秒', inline: true }
            )
            .setColor(0x00ff00)
            .setTimestamp();

        try {
            this.progressMessage = await this.responseChannel.send({ embeds: [embed] });
        } catch (error) {
            console.error('发送初始进度消息失败:', error);
        }
    }

    async updateCurrentChannel(channelName) {
        this.currentChannel = channelName;
        await this.updateProgressDisplay();
    }

    async updateProgress(channelId, scannedCount) {
        this.totalScanned += scannedCount;
        await this.throttledUpdate();
    }

    async completeChannel(channelId, stats) {
        this.completedChannels++;
        this.totalDeleted += stats.deleted;
        this.totalUnlockOperations += stats.unlockOperations || 0;
        await this.updateProgressDisplay();
    }

    async throttledUpdate() {
        const now = Date.now();
        if (now - this.lastUpdateTime >= this.minUpdateInterval) {
            await this.updateProgressDisplay();
            this.lastUpdateTime = now;
        }
    }

    async updateProgressWithCache(totalScanned, cacheStats) {
        this.totalScanned = totalScanned;
        this.totalDeleted = cacheStats.totalDeleted;
        this.pendingDeletions = cacheStats.pendingDeletions;
        await this.updateProgressDisplay();
    }

    async updateProgressDisplay() {
        if (!this.progressMessage) return;

        try {
            const progress = this.totalChannels > 0 ? Math.round((this.completedChannels / this.totalChannels) * 100) : 0;
            const elapsed = Math.round((Date.now() - this.startTime) / 1000);
            const elapsedFormatted = this.formatDuration(elapsed);

            // 计算扫描速度
            const scanSpeed = elapsed > 0 ? Math.round(this.totalScanned / elapsed) : 0;
            const deleteSpeed = elapsed > 0 ? Math.round(this.totalDeleted / elapsed) : 0;

            const title = this.isPartialCleanup ? '🔍 指定频道清理进行中' : '🔍 全服务器清理进行中';
            const description = this.isPartialCleanup ? 
                `正在扫描服务器 **${this.guild.name}** 中的指定频道...` :
                `正在扫描服务器 **${this.guild.name}** 中的所有消息...`;

            const embed = new EmbedBuilder()
                .setTitle(title)
                .setDescription(description)
                .addFields(
                    { 
                        name: '📊 扫描进度', 
                        value: `${this.completedChannels}/${this.totalChannels} 个目标 (${progress}%)`, 
                        inline: true 
                    },
                    { 
                        name: '🔍 已扫描消息', 
                        value: `${this.totalScanned.toLocaleString()} (${scanSpeed}/秒)`, 
                        inline: true 
                    },
                    { 
                        name: '🗑️ 已删除消息', 
                        value: `${this.totalDeleted.toLocaleString()} (${deleteSpeed}/秒)`, 
                        inline: true 
                    },
                    { 
                        name: '📍 当前目标', 
                        value: this.currentChannel || '准备中...', 
                        inline: true 
                    },
                    { 
                        name: '⏲️ 用时', 
                        value: elapsedFormatted, 
                        inline: true 
                    }
                )
                .setColor(0x00ff00)
                .setTimestamp();

            // 显示待删除消息数量
            if (this.pendingDeletions > 0) {
                embed.addFields({
                    name: '🔄 待删除消息',
                    value: `${this.pendingDeletions.toLocaleString()} 条`,
                    inline: true
                });
            }

            // 如果有解锁操作，显示统计
            if (this.totalUnlockOperations > 0) {
                embed.addFields({
                    name: '🔓 解锁操作',
                    value: `${this.totalUnlockOperations} 次`,
                    inline: true
                });
            }

            // 添加进度条
            const progressBarLength = 20;
            const filledLength = Math.round((progress / 100) * progressBarLength);
            const progressBar = '█'.repeat(filledLength) + '░'.repeat(progressBarLength - filledLength);
            embed.addFields({ name: '📈 进度条', value: `\`${progressBar}\` ${progress}%`, inline: false });

            // 添加扫描范围说明
            const scopeDesc = this.isPartialCleanup ? 
                '• **指定频道清理**：仅扫描选择的频道\n• 论坛频道包含所有子帖子\n• 🔒 **锁定帖子将被临时解锁**' :
                '• **全服务器清理**：扫描所有频道和帖子\n• 🔒 **锁定帖子将被临时解锁**\n• ⏭️ **豁免频道已自动跳过**';

            embed.addFields({
                name: '📋 扫描范围',
                value: scopeDesc + '\n⚡ **已启用智能并行优化**',
                inline: false
            });

            await this.progressMessage.edit({ embeds: [embed] });
        } catch (error) {
            console.error('更新进度显示失败:', error);
        }
    }

    async complete(finalStats) {
        this.stopPeriodicUpdates();

        if (!this.progressMessage) return;

        try {
            const elapsed = Math.round((Date.now() - this.startTime) / 1000);
            const elapsedFormatted = this.formatDuration(elapsed);
            
            const successRate = finalStats.totalMessagesScanned > 0 
                ? ((finalStats.totalMessagesDeleted / finalStats.totalMessagesScanned) * 100).toFixed(2)
                : '0';

            const title = this.isPartialCleanup ? '✅ 指定频道清理完成' : '✅ 全服务器清理完成';
            const description = this.isPartialCleanup ? 
                `服务器 **${this.guild.name}** 的指定频道清理已完成！` :
                `服务器 **${this.guild.name}** 的消息清理已完成！`;

            const embed = new EmbedBuilder()
                .setTitle(title)
                .setDescription(description)
                .addFields(
                    { name: '📊 扫描目标', value: `${finalStats.totalChannelsScanned}/${this.totalChannels}`, inline: true },
                    { name: '🔍 总扫描消息', value: finalStats.totalMessagesScanned.toLocaleString(), inline: true },
                    { name: '🗑️ 总删除消息', value: finalStats.totalMessagesDeleted.toLocaleString(), inline: true },
                    { name: '📈 清理率', value: `${successRate}%`, inline: true },
                    { name: '⏲️ 总用时', value: elapsedFormatted, inline: true },
                    { name: '🏁 完成时间', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                )
                .setColor(0x00ff00)
                .setTimestamp();

            // 显示任务类型
            if (finalStats.taskType === 'selectedChannels') {
                embed.addFields({
                    name: '📋 清理范围',
                    value: `指定的 ${finalStats.selectedChannelsCount} 个频道`,
                    inline: true
                });
            }

            // 显示解锁操作统计
            if (this.totalUnlockOperations > 0) {
                embed.addFields({
                    name: '🔓 解锁操作统计',
                    value: `执行了 ${this.totalUnlockOperations} 次临时解锁操作来删除锁定帖子中的违规内容`,
                    inline: false
                });
            }

            if (!finalStats.completedNormally) {
                embed.addFields({ name: '⚠️ 注意', value: '清理任务被手动停止，可能未完成所有目标的扫描。', inline: false });
            }

            await this.progressMessage.edit({ embeds: [embed] });
        } catch (error) {
            console.error('发送完成消息失败:', error);
        }
    }

    async error(error) {
        this.stopPeriodicUpdates();

        if (!this.progressMessage) return;

        try {
            const elapsed = Math.round((Date.now() - this.startTime) / 1000);
            const elapsedFormatted = this.formatDuration(elapsed);

            const embed = new EmbedBuilder()
                .setTitle('❌ 清理任务出错')
                .setDescription(`服务器 **${this.guild.name}** 的消息清理遇到错误`)
                .addFields(
                    { name: '📊 已完成频道', value: `${this.completedChannels}/${this.totalChannels}`, inline: true },
                    { name: '🔍 已扫描消息', value: this.totalScanned.toLocaleString(), inline: true },
                    { name: '🗑️ 已删除消息', value: this.totalDeleted.toLocaleString(), inline: true },
                    { name: '⏲️ 运行时间', value: elapsedFormatted, inline: true },
                    { name: '❌ 错误信息', value: `\`${error.message}\``, inline: false }
                )
                .setColor(0xff0000)
                .setTimestamp();

            await this.progressMessage.edit({ embeds: [embed] });
        } catch (editError) {
            console.error('发送错误消息失败:', editError);
        }
    }

    startPeriodicUpdates() {
        // 每30秒自动更新一次进度
        this.updateInterval = setInterval(async () => {
            await this.updateProgressDisplay();
        }, 30000);
    }

    stopPeriodicUpdates() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }

    formatDuration(seconds) {
        if (seconds < 60) {
            return `${seconds}秒`;
        } else if (seconds < 3600) {
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = seconds % 60;
            return `${minutes}分${remainingSeconds}秒`;
        } else {
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const remainingSeconds = seconds % 60;
            return `${hours}小时${minutes}分${remainingSeconds}秒`;
        }
    }
}

module.exports = { ProgressTracker }; 