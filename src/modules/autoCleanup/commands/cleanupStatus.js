const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { taskManager } = require('../services/taskManager');
const { getAutoCleanupSettings } = require('../../../core/utils/database');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('清理状态')
        .setNameLocalizations({
            'en-US': 'cleanup-status'
        })
        .setDescription('查看清理功能的当前状态')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            const guildId = interaction.guild.id;
            
            // 获取设置和任务状态
            const settings = await getAutoCleanupSettings(guildId);
            const activeTask = await taskManager.getActiveTask(guildId);
            const isAutoCleanupPaused = taskManager.isAutoCleanupPaused(guildId);

            const embed = new EmbedBuilder()
                .setTitle('🔍 自动清理状态')
                .setDescription(`服务器 **${interaction.guild.name}** 的清理功能状态`)
                .setColor(settings.isEnabled ? 0x00ff00 : 0xff0000)
                .setTimestamp();

            // 基本设置状态
            embed.addFields(
                {
                    name: '⚙️ 基本设置',
                    value: `自动清理: ${settings.isEnabled ? '✅ 启用' : '❌ 禁用'}\n` +
                           `实时监控: ${settings.autoCleanupEnabled && !isAutoCleanupPaused ? '✅ 运行中' : '❌ 暂停/禁用'}\n` +
                           `违禁关键字: ${settings.bannedKeywords?.length || 0} 个`,
                    inline: true
                }
            );

            // 监控频道信息
            let channelInfo = '所有频道';
            if (settings.monitorChannels && settings.monitorChannels.length > 0) {
                channelInfo = `${settings.monitorChannels.length} 个指定频道`;
            }
            
            embed.addFields({
                name: '📺 监控范围',
                value: channelInfo,
                inline: true
            });

            // 权限角色信息
            const roleInfo = settings.cleanupRole ? `<@&${settings.cleanupRole}>` : '管理员权限';
            embed.addFields({
                name: '👥 管理权限',
                value: roleInfo,
                inline: true
            });

            // 活跃任务信息
            if (activeTask) {
                const startTime = new Date(activeTask.createdAt);
                const duration = Math.round((Date.now() - startTime.getTime()) / 1000);
                const progress = activeTask.progress || {};

                let taskStatus = '';
                if (activeTask.type === 'fullServer') {
                    const channelProgress = progress.totalChannels > 0 
                        ? Math.round((progress.completedChannels || 0) / progress.totalChannels * 100)
                        : 0;
                    
                    taskStatus = `**全服务器清理** (${activeTask.status})\n` +
                                `进度: ${progress.completedChannels || 0}/${progress.totalChannels || 0} 频道 (${channelProgress}%)\n` +
                                `扫描: ${(progress.scannedMessages || 0).toLocaleString()} 消息\n` +
                                `删除: ${(progress.deletedMessages || 0).toLocaleString()} 消息\n` +
                                `运行时间: ${this.formatDuration(duration)}\n` +
                                `任务ID: \`${activeTask.taskId}\``;
                } else {
                    taskStatus = `类型: ${activeTask.type}\n状态: ${activeTask.status}\n运行时间: ${this.formatDuration(duration)}`;
                }

                embed.addFields({
                    name: '🔄 当前任务',
                    value: taskStatus,
                    inline: false
                });

                embed.setColor(0xffa500); // 橙色表示有活跃任务
            } else {
                embed.addFields({
                    name: '🔄 当前任务',
                    value: '无活跃任务',
                    inline: false
                });
            }

            // 暂停状态提醒
            if (isAutoCleanupPaused) {
                embed.addFields({
                    name: '⚠️ 注意',
                    value: '自动清理功能已暂停，通常是因为有全服务器清理任务在进行中。',
                    inline: false
                });
            }

            // 系统统计
            const taskStats = taskManager.getTaskStats();
            embed.addFields({
                name: '📊 系统统计',
                value: `全局活跃任务: ${taskStats.totalActiveTasks}\n暂停清理的服务器: ${taskStats.pausedServers}`,
                inline: true
            });

            await interaction.editReply({
                embeds: [embed],
                ephemeral: true
            });

        } catch (error) {
            console.error('查看清理状态时出错:', error);
            
            const errorMessage = error.message || '查看清理状态时发生未知错误';
            await interaction.editReply({
                content: `❌ 操作失败：${errorMessage}`,
                ephemeral: true
            });
        }
    },

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
            return `${hours}小时${minutes}分`;
        }
    }
}; 