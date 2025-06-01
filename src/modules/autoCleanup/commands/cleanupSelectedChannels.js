const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } = require('discord.js');
const { RateLimiter } = require('../services/rateLimiter');
const { FullServerScanner } = require('../services/fullServerScanner');
const { ProgressTracker } = require('../services/progressTracker');
const { taskManager } = require('../services/taskManager');
const { getBannedKeywords } = require('../../../core/utils/database');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('清理指定频道')
        .setNameLocalizations({
            'en-US': 'cleanup-selected-channels'
        })
        .setDescription('扫描并清理指定频道中的违规消息')
        .addChannelOption(option =>
            option.setName('频道1')
                .setNameLocalizations({ 'en-US': 'channel1' })
                .setDescription('要清理的频道或论坛')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum, ChannelType.GuildNews, ChannelType.PublicThread, ChannelType.PrivateThread)
                .setRequired(true)
        )
        .addBooleanOption(option =>
            option.setName('确认执行')
                .setNameLocalizations({ 'en-US': 'confirm' })
                .setDescription('确认要执行指定频道清理（此操作不可撤销）')
                .setRequired(true)
        )
        .addChannelOption(option =>
            option.setName('频道2')
                .setNameLocalizations({ 'en-US': 'channel2' })
                .setDescription('要清理的频道或论坛')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum, ChannelType.GuildNews, ChannelType.PublicThread, ChannelType.PrivateThread)
                .setRequired(false)
        )
        .addChannelOption(option =>
            option.setName('频道3')
                .setNameLocalizations({ 'en-US': 'channel3' })
                .setDescription('要清理的频道或论坛')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum, ChannelType.GuildNews, ChannelType.PublicThread, ChannelType.PrivateThread)
                .setRequired(false)
        )
        .addChannelOption(option =>
            option.setName('频道4')
                .setNameLocalizations({ 'en-US': 'channel4' })
                .setDescription('要清理的频道或论坛')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum, ChannelType.GuildNews, ChannelType.PublicThread, ChannelType.PrivateThread)
                .setRequired(false)
        )
        .addChannelOption(option =>
            option.setName('频道5')
                .setNameLocalizations({ 'en-US': 'channel5' })
                .setDescription('要清理的频道或论坛')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum, ChannelType.GuildNews, ChannelType.PublicThread, ChannelType.PrivateThread)
                .setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

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
                    .setDescription('指定频道清理是一个重要操作，请将"确认执行"选项设置为"True"来执行。')
                    .setColor(0xffa500);

                return await interaction.editReply({
                    embeds: [embed]
                });
            }

            // 收集选择的频道
            const selectedChannels = [];
            
            // 必须的第一个频道
            const channel1 = interaction.options.getChannel('频道1');
            selectedChannels.push(channel1);
            
            // 可选的其他频道
            for (let i = 2; i <= 5; i++) {
                const channel = interaction.options.getChannel(`频道${i}`);
                if (channel) {
                    selectedChannels.push(channel);
                }
            }

            if (selectedChannels.length === 0) {
                const embed = new EmbedBuilder()
                    .setTitle('❌ 没有选择频道')
                    .setDescription('请至少选择一个要清理的频道。')
                    .setColor(0xff0000);

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

            // 验证频道权限和统计信息
            const validChannels = [];
            const invalidChannels = [];
            let estimatedTargets = 0;

            for (const channel of selectedChannels) {
                try {
                    const permissions = channel.permissionsFor(interaction.guild.members.me);
                    if (permissions.has(['ViewChannel', 'ReadMessageHistory', 'ManageMessages'])) {
                        validChannels.push(channel);
                        
                        // 估算扫描目标数量
                        if (channel.type === ChannelType.GuildForum) {
                            // 论坛频道：估算子帖子数量
                            try {
                                const activeThreads = await channel.threads.fetchActive();
                                const archivedThreads = await channel.threads.fetchArchived();
                                estimatedTargets += activeThreads.threads.size + archivedThreads.threads.size;
                            } catch (error) {
                                estimatedTargets += 1; // 如果获取失败，至少算1个
                            }
                        } else {
                            estimatedTargets += 1; // 普通频道算1个目标
                        }
                    } else {
                        invalidChannels.push(channel);
                    }
                } catch (error) {
                    invalidChannels.push(channel);
                }
            }

            if (validChannels.length === 0) {
                const embed = new EmbedBuilder()
                    .setTitle('❌ 没有有效频道')
                    .setDescription('所选频道中没有任何频道具备必要的权限（查看频道、阅读消息历史、管理消息）。')
                    .setColor(0xff0000);

                return await interaction.editReply({
                    embeds: [embed]
                });
            }

            // 显示确认信息
            const confirmEmbed = new EmbedBuilder()
                .setTitle('⚠️ 指定频道清理确认')
                .setDescription(`即将开始扫描指定的 ${validChannels.length} 个频道并清理违规内容。`)
                .setColor(0xffa500)
                .setTimestamp();

            // 添加有效频道列表
            const channelList = validChannels.map(channel => {
                let channelInfo = `<#${channel.id}>`;
                if (channel.type === ChannelType.GuildForum) {
                    channelInfo += ' (论坛 - 包含所有子帖子)';
                } else if (channel.type === ChannelType.PublicThread || channel.type === ChannelType.PrivateThread) {
                    channelInfo += ' (帖子)';
                }
                return channelInfo;
            }).join('\n');

            confirmEmbed.addFields(
                { name: '📊 清理范围', value: `${validChannels.length} 个频道`, inline: true },
                { name: '🎯 违禁关键字', value: `${bannedKeywords.length} 个`, inline: true },
                { name: '📈 预估目标', value: `约 ${estimatedTargets} 个扫描目标`, inline: true },
                { name: '✅ 要清理的频道', value: channelList, inline: false }
            );

            // 添加无效频道警告
            if (invalidChannels.length > 0) {
                const invalidChannelList = invalidChannels.map(ch => `<#${ch.id}>`).join('\n');
                confirmEmbed.addFields({
                    name: '⚠️ 权限不足的频道（将跳过）',
                    value: invalidChannelList,
                    inline: false
                });
            }

            confirmEmbed.addFields({
                name: '⚠️ 重要提醒',
                value: '• 此操作将暂停自动清理功能\n• 被删除的消息无法恢复\n• 锁定的帖子会被临时解锁\n• 过程中请勿关闭机器人\n• 可以随时使用停止命令中断',
                inline: false
            });

            const confirmButton = new ButtonBuilder()
                .setCustomId('confirm_selected_cleanup')
                .setLabel('确认开始清理')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🗑️');

            const cancelButton = new ButtonBuilder()
                .setCustomId('cancel_selected_cleanup')
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

                if (buttonInteraction.customId === 'cancel_selected_cleanup') {
                    const cancelEmbed = new EmbedBuilder()
                        .setTitle('❌ 操作已取消')
                        .setDescription('指定频道清理操作已取消。')
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
                const progressTracker = new ProgressTracker(interaction.channel, interaction.guild, true); // 标记为局部清理

                // 创建扫描器实例
                const rateLimiter = new RateLimiter();
                const scanner = new FullServerScanner(
                    interaction.guild,
                    rateLimiter,
                    taskManager,
                    progressTracker
                );

                // 收集选择的频道（在现有代码中约第200行之后的部分）
                // 在创建任务数据时，确保传递频道对象而不是ID
                const taskData = {
                    type: 'selectedChannels',
                    selectedChannels: validChannels, // 传递Channel对象数组，而不是ID数组
                    bannedKeywords,
                    guildId,
                    userId,
                    totalChannels: validChannels.length,
                    startTime: new Date()
                };

                // 启动指定频道扫描任务
                const taskDataResult = await taskManager.startSelectedChannelsCleanup(interaction.guild, taskData);

                console.log(`🚀 启动指定频道清理 - Guild: ${guildId}, User: ${interaction.user.tag}, Task: ${taskDataResult.taskId}, Channels: ${validChannels.length}`);

                // 在后台异步执行扫描
                scanner.startSelectedChannels(taskDataResult, validChannels).catch(error => {
                    console.error('指定频道扫描出错:', error);
                });

                // 发送启动成功消息
                const startEmbed = new EmbedBuilder()
                    .setTitle('🚀 指定频道清理已启动')
                    .setDescription('清理任务已开始，进度信息将在下方显示。')
                    .addFields(
                        { name: '任务ID', value: `\`${taskDataResult.taskId}\``, inline: true },
                        { name: '清理范围', value: `${validChannels.length} 个频道`, inline: true },
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
            console.error('执行指定频道清理时出错:', error);
            
            const errorMessage = error.message || '执行指定频道清理时发生未知错误';
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