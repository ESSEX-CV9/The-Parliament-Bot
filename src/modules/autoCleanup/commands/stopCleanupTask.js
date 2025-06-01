const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { taskManager } = require('../services/taskManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('停止清理任务')
        .setNameLocalizations({
            'en-US': 'stop-cleanup-task'
        })
        .setDescription('停止当前正在进行的清理任务')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            const guildId = interaction.guild.id;
            
            // 检查是否有活跃任务
            const activeTask = await taskManager.getActiveTask(guildId);
            if (!activeTask) {
                const embed = new EmbedBuilder()
                    .setTitle('ℹ️ 没有活跃任务')
                    .setDescription('当前没有正在进行的清理任务。')
                    .setColor(0x808080);

                return await interaction.editReply({
                    embeds: [embed],
                    ephemeral: true
                });
            }

            // 停止任务
            await taskManager.stopTask(guildId, activeTask.taskId, 'manually_stopped');

            // 计算任务运行时间
            const startTime = new Date(activeTask.createdAt);
            const endTime = new Date();
            const duration = Math.round((endTime - startTime) / 1000);

            const embed = new EmbedBuilder()
                .setTitle('⏹️ 清理任务已停止')
                .setDescription('清理任务已成功停止，自动清理功能已恢复。')
                .addFields(
                    { name: '任务ID', value: `\`${activeTask.taskId}\``, inline: true },
                    { name: '任务类型', value: activeTask.type === 'fullServer' ? '全服务器清理' : '未知', inline: true },
                    { name: '运行时间', value: `${duration}秒`, inline: true }
                )
                .setColor(0xffa500)
                .setTimestamp();

            // 添加进度信息（如果有的话）
            if (activeTask.progress) {
                const progress = activeTask.progress;
                embed.addFields({
                    name: '📊 停止时的进度',
                    value: `频道: ${progress.completedChannels || 0}/${progress.totalChannels || 0}\n` +
                           `扫描消息: ${(progress.scannedMessages || 0).toLocaleString()}\n` +
                           `删除消息: ${(progress.deletedMessages || 0).toLocaleString()}`,
                    inline: false
                });
            }

            console.log(`⏹️ 停止清理任务 - Guild: ${guildId}, Task: ${activeTask.taskId}, User: ${interaction.user.tag}`);

            await interaction.editReply({
                embeds: [embed],
                ephemeral: true
            });

        } catch (error) {
            console.error('停止清理任务时出错:', error);
            
            const errorMessage = error.message || '停止清理任务时发生未知错误';
            await interaction.editReply({
                content: `❌ 操作失败：${errorMessage}`,
                ephemeral: true
            });
        }
    },
}; 