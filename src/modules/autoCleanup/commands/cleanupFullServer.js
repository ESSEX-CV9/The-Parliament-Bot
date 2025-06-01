const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { RateLimiter } = require('../services/rateLimiter');
const { FullServerScanner } = require('../services/fullServerScanner');
const { ProgressTracker } = require('../services/progressTracker');
const { taskManager } = require('../services/taskManager');
const { getBannedKeywords } = require('../../../core/utils/database');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('清理全服务器消息')
        .setNameLocalizations({
            'en-US': 'cleanup-full-server'
        })
        .setDescription('扫描并清理整个服务器中的违规消息（需要确认）')
        .addBooleanOption(option =>
            option.setName('确认执行')
                .setNameLocalizations({ 'en-US': 'confirm' })
                .setDescription('确认要执行全服务器清理（此操作不可撤销）')
                .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        try {
            await interaction.deferReply();

            const confirmed = interaction.options.getBoolean('确认执行');
            const guildId = interaction.guild.id;
            const userId = interaction.user.id;

            // 检查确认状态
            if (!confirmed) {
                const embed = new EmbedBuilder()
                    .setTitle('⚠️ 需要确认')
                    .setDescription('全服务器清理是一个重要操作，请将"确认执行"选项设置为"True"来执行。')
                    .setColor(0xffa500);

                return await interaction.editReply({
                    embeds: [embed]
                });
            }

            // 检查是否已有活跃任务
            const existingTask = await taskManager.getActiveTask(guildId);
            if (existingTask) {
                const embed = new EmbedBuilder()
                    .setTitle('❌ 任务已在进行中')
                    .setDescription('服务器已有正在进行的清理任务，请等待当前任务完成或使用停止命令。')
                    .addFields({
                        name: '当前任务信息',
                        value: `任务ID: \`${existingTask.taskId}\`\n状态: \`${existingTask.status}\`\n开始时间: <t:${Math.floor(new Date(existingTask.createdAt).getTime() / 1000)}:R>`
                    })
                    .setColor(0xff0000);

                return await interaction.editReply({
                    embeds: [embed]
                });
            }

            // 检查违禁关键字
            const bannedKeywords = await getBannedKeywords(guildId);
            if (bannedKeywords.length === 0) {
                const embed = new EmbedBuilder()
                    .setTitle('❌ 没有违禁关键字')
                    .setDescription('请先使用 `/添加违禁关键字` 命令设置要清理的关键字。')
                    .setColor(0xff0000);

                return await interaction.editReply({
                    embeds: [embed]
                });
            }

            // 获取服务器统计信息
            const channels = await interaction.guild.channels.fetch();
            const textChannels = channels.filter(channel => 
                channel.isTextBased() && 
                !channel.isThread() && 
                channel.viewable
            );

            // 显示确认信息
            const confirmEmbed = new EmbedBuilder()
                .setTitle('⚠️ 全服务器清理确认')
                .setDescription(`即将开始扫描服务器 **${interaction.guild.name}** 中的所有消息并清理违规内容。`)
                .addFields(
                    { name: '📊 扫描范围', value: `${textChannels.size} 个文字频道`, inline: true },
                    { name: '🎯 违禁关键字', value: `${bannedKeywords.length} 个`, inline: true },
                    { name: '⏱️ 预计时间', value: '可能需要数分钟到数小时', inline: true },
                    { name: '⚠️ 重要提醒', value: '• 此操作将暂停自动清理功能\n• 被删除的消息无法恢复\n• 过程中请勿关闭机器人\n• 可以随时使用停止命令中断', inline: false }
                )
                .setColor(0xffa500)
                .setTimestamp();

            const confirmButton = new ButtonBuilder()
                .setCustomId('confirm_full_cleanup')
                .setLabel('确认开始清理')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🗑️');

            const cancelButton = new ButtonBuilder()
                .setCustomId('cancel_full_cleanup')
                .setLabel('取消')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('❌');

            const actionRow = new ActionRowBuilder()
                .addComponents(confirmButton, cancelButton);

            const confirmMessage = await interaction.editReply({
                embeds: [confirmEmbed],
                components: [actionRow]
            });

            // 等待用户确认
            try {
                const buttonInteraction = await confirmMessage.awaitMessageComponent({
                    filter: i => i.user.id === userId,
                    time: 60000 // 60秒超时
                });

                if (buttonInteraction.customId === 'cancel_full_cleanup') {
                    const cancelEmbed = new EmbedBuilder()
                        .setTitle('❌ 操作已取消')
                        .setDescription('全服务器清理操作已取消。')
                        .setColor(0x808080);

                    await buttonInteraction.update({
                        embeds: [cancelEmbed],
                        components: []
                    });
                    return;
                }

                // 用户确认，开始清理
                await buttonInteraction.update({
                    embeds: [confirmEmbed],
                    components: []
                });

                // 创建进度追踪器
                const progressTracker = new ProgressTracker(interaction.channel, interaction.guild);

                // 创建扫描器实例
                const rateLimiter = new RateLimiter();
                const scanner = new FullServerScanner(
                    interaction.guild,
                    rateLimiter,
                    taskManager,
                    progressTracker
                );

                // 启动全服务器扫描任务
                const taskData = await taskManager.startFullServerScan(interaction.guild, {
                    userId: userId,
                    channelId: interaction.channel.id
                });

                console.log(`🚀 启动全服务器清理 - Guild: ${guildId}, User: ${interaction.user.tag}, Task: ${taskData.taskId}`);

                // 在后台异步执行扫描
                scanner.start(taskData).catch(error => {
                    console.error('全服务器扫描出错:', error);
                });

                // 发送启动成功消息
                const startEmbed = new EmbedBuilder()
                    .setTitle('🚀 全服务器清理已启动')
                    .setDescription('清理任务已开始，进度信息将在下方显示。')
                    .addFields(
                        { name: '任务ID', value: `\`${taskData.taskId}\``, inline: true },
                        { name: '状态', value: '运行中', inline: true },
                        { name: '💡 提示', value: '使用 `/停止清理任务` 可以中断清理过程', inline: false }
                    )
                    .setColor(0x00ff00)
                    .setTimestamp();

                await interaction.followUp({
                    embeds: [startEmbed]
                });

            } catch (timeoutError) {
                // 超时处理
                const timeoutEmbed = new EmbedBuilder()
                    .setTitle('⏰ 操作超时')
                    .setDescription('确认操作超时，清理任务已取消。')
                    .setColor(0x808080);

                await interaction.editReply({
                    embeds: [timeoutEmbed],
                    components: []
                });
            }

        } catch (error) {
            console.error('执行全服务器清理时出错:', error);
            
            const errorMessage = error.message || '执行全服务器清理时发生未知错误';
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 操作失败')
                .setDescription(`执行清理时出错：${errorMessage}`)
                .setColor(0xff0000);

            await interaction.editReply({
                embeds: [errorEmbed],
                components: []
            });
        }
    },
}; 