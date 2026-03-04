/**
 * 频道冲水 —— 合并命令
 * 7 个子命令: 全服清理 / 指定频道 / 历史清理 / 状态 / 停止 / 开关 / 设置范围
 */
const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } = require('discord.js');
const { RateLimiter } = require('../services/rateLimiter');
const { FullServerScanner } = require('../services/fullServerScanner');
const { ProgressTracker } = require('../services/progressTracker');
const { taskManager } = require('../services/taskManager');
const { KeywordDetector } = require('../services/keywordDetector');
const {
    getBannedKeywords,
    getAutoCleanupSettings,
    saveAutoCleanupSettings,
    setCleanupChannels,
} = require('../../../core/utils/database');

// ========== 工具函数 ==========
function formatDuration(seconds) {
    if (seconds < 60) return `${seconds}秒`;
    if (seconds < 3600) {
        const minutes = Math.floor(seconds / 60);
        const remaining = seconds % 60;
        return `${minutes}分${remaining}秒`;
    }
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}小时${minutes}分`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('频道冲水')
        .setNameLocalizations({ 'en-US': 'cleanup' })
        .setDescription('消息清理操作（全服 / 指定频道 / 历史 / 状态 / 开关等）')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)

        // ── 全服清理 ──
        .addSubcommand(sub => sub
            .setName('全服清理')
            .setDescription('扫描并清理整个服务器中的违规消息（需要确认）')
            .addBooleanOption(opt => opt
                .setName('确认执行')
                .setNameLocalizations({ 'en-US': 'confirm' })
                .setDescription('确认要执行全服务器清理（此操作不可撤销）')
                .setRequired(true)
            )
        )

        // ── 指定频道 ──
        .addSubcommand(sub => sub
            .setName('指定频道')
            .setDescription('扫描并清理指定频道中的违规消息')
            .addChannelOption(opt => opt
                .setName('频道1').setDescription('要清理的频道或论坛')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum, ChannelType.GuildNews, ChannelType.PublicThread, ChannelType.PrivateThread)
                .setRequired(true)
            )
            .addBooleanOption(opt => opt
                .setName('确认执行')
                .setDescription('确认要执行指定频道清理（此操作不可撤销）')
                .setRequired(true)
            )
            .addChannelOption(opt => opt
                .setName('频道2').setDescription('要清理的频道或论坛')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum, ChannelType.GuildNews, ChannelType.PublicThread, ChannelType.PrivateThread)
                .setRequired(false)
            )
            .addChannelOption(opt => opt
                .setName('频道3').setDescription('要清理的频道或论坛')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum, ChannelType.GuildNews, ChannelType.PublicThread, ChannelType.PrivateThread)
                .setRequired(false)
            )
            .addChannelOption(opt => opt
                .setName('频道4').setDescription('要清理的频道或论坛')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum, ChannelType.GuildNews, ChannelType.PublicThread, ChannelType.PrivateThread)
                .setRequired(false)
            )
            .addChannelOption(opt => opt
                .setName('频道5').setDescription('要清理的频道或论坛')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum, ChannelType.GuildNews, ChannelType.PublicThread, ChannelType.PrivateThread)
                .setRequired(false)
            )
        )

        // ── 历史清理 ──
        .addSubcommand(sub => sub
            .setName('历史清理')
            .setDescription('清理指定频道的历史消息')
            .addChannelOption(opt => opt
                .setName('频道').setDescription('要清理的频道')
                .addChannelTypes(ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread)
                .setRequired(true)
            )
            .addIntegerOption(opt => opt
                .setName('天数').setDescription('清理多少天内的消息（默认7天，最多30天）')
                .setMinValue(1).setMaxValue(30).setRequired(false)
            )
            .addIntegerOption(opt => opt
                .setName('限制数量').setDescription('最多扫描多少条消息（默认1000条，最多5000条）')
                .setMinValue(100).setMaxValue(5000).setRequired(false)
            )
        )

        // ── 状态 ──
        .addSubcommand(sub => sub
            .setName('状态')
            .setDescription('查看清理功能的当前状态')
        )

        // ── 停止 ──
        .addSubcommand(sub => sub
            .setName('停止')
            .setDescription('停止当前正在进行的清理任务')
        )

        // ── 开关 ──
        .addSubcommand(sub => sub
            .setName('开关')
            .setDescription('启用或禁用自动清理功能')
            .addBooleanOption(opt => opt
                .setName('启用').setDescription('是否启用自动清理功能').setRequired(true)
            )
        )

        // ── 设置范围 ──
        .addSubcommand(sub => sub
            .setName('设置范围')
            .setDescription('设置要监控的频道（留空表示监控所有频道）')
            .addChannelOption(opt => opt.setName('频道1').setDescription('要监控的频道').addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum, ChannelType.PublicThread, ChannelType.PrivateThread).setRequired(false))
            .addChannelOption(opt => opt.setName('频道2').setDescription('要监控的频道').addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum, ChannelType.PublicThread, ChannelType.PrivateThread).setRequired(false))
            .addChannelOption(opt => opt.setName('频道3').setDescription('要监控的频道').addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum, ChannelType.PublicThread, ChannelType.PrivateThread).setRequired(false))
            .addChannelOption(opt => opt.setName('频道4').setDescription('要监控的频道').addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum, ChannelType.PublicThread, ChannelType.PrivateThread).setRequired(false))
            .addChannelOption(opt => opt.setName('频道5').setDescription('要监控的频道').addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum, ChannelType.PublicThread, ChannelType.PrivateThread).setRequired(false))
            .addBooleanOption(opt => opt.setName('清空设置').setDescription('清空所有监控频道设置（将监控所有频道）').setRequired(false))
        ),

    // ========== Execute ==========
    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;

        try {
            switch (sub) {
                case '全服清理': return await this._fullServer(interaction, guildId);
                case '指定频道': return await this._selectedChannels(interaction, guildId);
                case '历史清理': return await this._history(interaction, guildId);
                case '状态':     return await this._status(interaction, guildId);
                case '停止':     return await this._stop(interaction, guildId);
                case '开关':     return await this._toggle(interaction, guildId);
                case '设置范围': return await this._setRange(interaction, guildId);
            }
        } catch (error) {
            console.error(`[频道冲水][${sub}] 出错:`, error);
            const msg = `❌ 操作失败：${error.message || '未知错误'}`;
            try { await interaction.editReply({ content: msg }); } catch (_) {
                try { await interaction.reply({ content: msg, ephemeral: true }); } catch (__) {}
            }
        }
    },

    // ============================= 全服清理 =============================
    async _fullServer(interaction, guildId) {
        await interaction.deferReply();
        const confirmed = interaction.options.getBoolean('确认执行');
        const userId = interaction.user.id;

        if (!confirmed) {
            const embed = new EmbedBuilder().setTitle('⚠️ 需要确认').setDescription('全服务器清理是一个重要操作，请将"确认执行"选项设置为"True"来执行。').setColor(0xffa500);
            return await interaction.editReply({ embeds: [embed] });
        }

        const existingTask = await taskManager.getActiveTask(guildId);
        if (existingTask) {
            const embed = new EmbedBuilder().setTitle('❌ 任务已在进行中').setDescription('服务器已有正在进行的清理任务，请等待当前任务完成或使用停止命令。')
                .addFields({ name: '当前任务信息', value: `任务ID: \`${existingTask.taskId}\`\n状态: \`${existingTask.status}\`\n开始时间: <t:${Math.floor(new Date(existingTask.createdAt).getTime() / 1000)}:R>` }).setColor(0xff0000);
            return await interaction.editReply({ embeds: [embed] });
        }

        const bannedKeywords = await getBannedKeywords(guildId);
        if (bannedKeywords.length === 0) {
            const embed = new EmbedBuilder().setTitle('❌ 没有违禁关键字').setDescription('请先使用 `/频道冲水-关键词 添加` 命令设置要清理的关键字。').setColor(0xff0000);
            return await interaction.editReply({ embeds: [embed] });
        }

        const botMember = interaction.guild.members.me;
        const requiredPermissions = ['ManageMessages', 'ReadMessageHistory', 'ViewChannel'];
        const missingPermissions = requiredPermissions.filter(perm => !botMember.permissions.has(perm));
        if (missingPermissions.length > 0) {
            const embed = new EmbedBuilder().setTitle('❌ 权限不足').setDescription('机器人缺少必要的权限来执行全服务器清理。')
                .addFields({ name: '缺少的权限', value: missingPermissions.map(p => `• ${p}`).join('\n') }).setColor(0xff0000);
            return await interaction.editReply({ embeds: [embed] });
        }

        const threadPermissions = ['ManageThreads'];
        const missingThreadPermissions = threadPermissions.filter(perm => !botMember.permissions.has(perm));
        let permissionWarning = '';
        if (missingThreadPermissions.length > 0) permissionWarning = '\n⚠️ **注意**：机器人缺少"管理帖子"权限，无法处理锁定的帖子。';

        const channels = await interaction.guild.channels.fetch();
        const textChannels = channels.filter(c => c.isTextBased() && c.viewable);
        const forumChannels = channels.filter(c => c.type === ChannelType.GuildForum && c.viewable);

        const confirmEmbed = new EmbedBuilder()
            .setTitle('⚠️ 全服务器清理确认')
            .setDescription(`即将开始扫描服务器 **${interaction.guild.name}** 中的所有消息并清理违规内容。${permissionWarning}`)
            .addFields(
                { name: '📊 扫描范围', value: `${textChannels.size} 个文字频道\n${forumChannels.size} 个论坛频道（包含子帖子）`, inline: true },
                { name: '🎯 违禁关键字', value: `${bannedKeywords.length} 个`, inline: true },
                { name: '⏱️ 预计时间', value: '可能需要数分钟到数小时', inline: true },
                { name: '🔍 扫描内容', value: '• 普通文字频道\n• 论坛帖子（活跃+归档）\n• 子帖子和私人帖子\n• 🔒 **锁定帖子**（临时解锁删除后重新锁定）\n• 公告频道等', inline: false },
                { name: '⚠️ 重要提醒', value: '• 此操作将暂停自动清理功能\n• 被删除的消息无法恢复\n• 锁定的帖子会被临时解锁\n• 过程中请勿关闭机器人\n• 可以随时使用停止命令中断', inline: false },
            )
            .setColor(0xffa500).setTimestamp();

        const confirmButton = new ButtonBuilder().setCustomId('confirm_full_cleanup').setLabel('确认开始清理').setStyle(ButtonStyle.Danger).setEmoji('🗑️');
        const cancelButton = new ButtonBuilder().setCustomId('cancel_full_cleanup').setLabel('取消').setStyle(ButtonStyle.Secondary).setEmoji('❌');
        const actionRow = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

        const confirmMessage = await interaction.editReply({ embeds: [confirmEmbed], components: [actionRow] });

        try {
            const buttonInteraction = await confirmMessage.awaitMessageComponent({ filter: i => i.user.id === userId, time: 60000 });
            if (buttonInteraction.customId === 'cancel_full_cleanup') {
                const cancelEmbed = new EmbedBuilder().setTitle('❌ 操作已取消').setDescription('全服务器清理操作已取消。').setColor(0x808080);
                return await buttonInteraction.update({ embeds: [cancelEmbed], components: [] });
            }
            await buttonInteraction.update({ embeds: [confirmEmbed], components: [] });

            const progressTracker = new ProgressTracker(interaction.channel, interaction.guild);
            const rateLimiter = new RateLimiter();
            const scanner = new FullServerScanner(interaction.guild, rateLimiter, taskManager, progressTracker);
            const taskData = await taskManager.startFullServerScan(interaction.guild, { userId, channelId: interaction.channel.id });

            console.log(`🚀 启动全服务器清理 - Guild: ${guildId}, User: ${interaction.user.tag}, Task: ${taskData.taskId}`);
            scanner.start(taskData).catch(err => console.error('全服务器扫描出错:', err));

            const startEmbed = new EmbedBuilder().setTitle('🚀 全服务器清理已启动').setDescription('清理任务已开始，进度信息将在下方显示。')
                .addFields(
                    { name: '任务ID', value: `\`${taskData.taskId}\``, inline: true },
                    { name: '状态', value: '运行中', inline: true },
                    { name: '💡 提示', value: '使用 `/频道冲水 停止` 可以中断清理过程', inline: false },
                ).setColor(0x00ff00).setTimestamp();
            await interaction.followUp({ embeds: [startEmbed] });

        } catch (_) {
            const timeoutEmbed = new EmbedBuilder().setTitle('⏰ 操作超时').setDescription('确认操作超时，清理任务已取消。').setColor(0x808080);
            await interaction.editReply({ embeds: [timeoutEmbed], components: [] });
        }
    },

    // ============================= 指定频道 =============================
    async _selectedChannels(interaction, guildId) {
        await interaction.deferReply();
        const confirmed = interaction.options.getBoolean('确认执行');
        const userId = interaction.user.id;

        if (!confirmed) {
            const embed = new EmbedBuilder().setTitle('⚠️ 需要确认').setDescription('指定频道清理是一个重要操作，请将"确认执行"选项设置为"True"来执行。').setColor(0xffa500);
            return await interaction.editReply({ embeds: [embed] });
        }

        const selectedChannels = [];
        const channel1 = interaction.options.getChannel('频道1');
        selectedChannels.push(channel1);
        for (let i = 2; i <= 5; i++) {
            const ch = interaction.options.getChannel(`频道${i}`);
            if (ch) selectedChannels.push(ch);
        }

        const existingTask = await taskManager.getActiveTask(guildId);
        if (existingTask) {
            const embed = new EmbedBuilder().setTitle('❌ 任务已在进行中').setDescription('服务器已有正在进行的清理任务，请等待当前任务完成或使用停止命令。')
                .addFields({ name: '当前任务信息', value: `任务ID: \`${existingTask.taskId}\`\n状态: \`${existingTask.status}\`\n开始时间: <t:${Math.floor(new Date(existingTask.createdAt).getTime() / 1000)}:R>` }).setColor(0xff0000);
            return await interaction.editReply({ embeds: [embed] });
        }

        const bannedKeywords = await getBannedKeywords(guildId);
        if (bannedKeywords.length === 0) {
            const embed = new EmbedBuilder().setTitle('❌ 没有违禁关键字').setDescription('请先使用 `/频道冲水-关键词 添加` 命令设置要清理的关键字。').setColor(0xff0000);
            return await interaction.editReply({ embeds: [embed] });
        }

        const validChannels = [];
        const invalidChannels = [];
        let estimatedTargets = 0;

        for (const channel of selectedChannels) {
            try {
                const permissions = channel.permissionsFor(interaction.guild.members.me);
                if (permissions.has(['ViewChannel', 'ReadMessageHistory', 'ManageMessages'])) {
                    validChannels.push(channel);
                    if (channel.type === ChannelType.GuildForum) {
                        try {
                            const activeThreads = await channel.threads.fetchActive();
                            const archivedThreads = await channel.threads.fetchArchived();
                            estimatedTargets += activeThreads.threads.size + archivedThreads.threads.size;
                        } catch (_) { estimatedTargets += 1; }
                    } else { estimatedTargets += 1; }
                } else { invalidChannels.push(channel); }
            } catch (_) { invalidChannels.push(channel); }
        }

        if (validChannels.length === 0) {
            const embed = new EmbedBuilder().setTitle('❌ 没有有效频道').setDescription('所选频道中没有任何频道具备必要的权限。').setColor(0xff0000);
            return await interaction.editReply({ embeds: [embed] });
        }

        const channelList = validChannels.map(ch => {
            let info = `<#${ch.id}>`;
            if (ch.type === ChannelType.GuildForum) info += ' (论坛 - 包含所有子帖子)';
            else if (ch.type === ChannelType.PublicThread || ch.type === ChannelType.PrivateThread) info += ' (帖子)';
            return info;
        }).join('\n');

        const confirmEmbed = new EmbedBuilder()
            .setTitle('⚠️ 指定频道清理确认')
            .setDescription(`即将开始扫描指定的 ${validChannels.length} 个频道并清理违规内容。`)
            .addFields(
                { name: '📊 清理范围', value: `${validChannels.length} 个频道`, inline: true },
                { name: '🎯 违禁关键字', value: `${bannedKeywords.length} 个`, inline: true },
                { name: '📈 预估目标', value: `约 ${estimatedTargets} 个扫描目标`, inline: true },
                { name: '✅ 要清理的频道', value: channelList, inline: false },
            )
            .setColor(0xffa500).setTimestamp();

        if (invalidChannels.length > 0) {
            confirmEmbed.addFields({ name: '⚠️ 权限不足的频道（将跳过）', value: invalidChannels.map(ch => `<#${ch.id}>`).join('\n'), inline: false });
        }
        confirmEmbed.addFields({ name: '⚠️ 重要提醒', value: '• 此操作将暂停自动清理功能\n• 被删除的消息无法恢复\n• 锁定的帖子会被临时解锁\n• 过程中请勿关闭机器人\n• 可以随时使用停止命令中断', inline: false });

        const confirmButton = new ButtonBuilder().setCustomId('confirm_selected_cleanup').setLabel('确认开始清理').setStyle(ButtonStyle.Danger).setEmoji('🗑️');
        const cancelButton = new ButtonBuilder().setCustomId('cancel_selected_cleanup').setLabel('取消').setStyle(ButtonStyle.Secondary).setEmoji('❌');
        const actionRow = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

        const confirmMessage = await interaction.editReply({ embeds: [confirmEmbed], components: [actionRow] });

        try {
            const buttonInteraction = await confirmMessage.awaitMessageComponent({ filter: i => i.user.id === userId, time: 60000 });
            if (buttonInteraction.customId === 'cancel_selected_cleanup') {
                const cancelEmbed = new EmbedBuilder().setTitle('❌ 操作已取消').setDescription('指定频道清理操作已取消。').setColor(0x808080);
                return await buttonInteraction.update({ embeds: [cancelEmbed], components: [] });
            }
            await buttonInteraction.update({ embeds: [confirmEmbed], components: [] });

            const progressTracker = new ProgressTracker(interaction.channel, interaction.guild, true);
            const rateLimiter = new RateLimiter();
            const scanner = new FullServerScanner(interaction.guild, rateLimiter, taskManager, progressTracker);
            const taskPayload = { type: 'selectedChannels', selectedChannels: validChannels, bannedKeywords, guildId, userId, totalChannels: validChannels.length, startTime: new Date() };
            const taskDataResult = await taskManager.startSelectedChannelsCleanup(interaction.guild, taskPayload);

            console.log(`🚀 启动指定频道清理 - Guild: ${guildId}, User: ${interaction.user.tag}, Task: ${taskDataResult.taskId}, Channels: ${validChannels.length}`);
            scanner.startSelectedChannels(taskDataResult, validChannels).catch(err => console.error('指定频道扫描出错:', err));

            const startEmbed = new EmbedBuilder().setTitle('🚀 指定频道清理已启动').setDescription('清理任务已开始，进度信息将在下方显示。')
                .addFields(
                    { name: '任务ID', value: `\`${taskDataResult.taskId}\``, inline: true },
                    { name: '清理范围', value: `${validChannels.length} 个频道`, inline: true },
                    { name: '状态', value: '运行中', inline: true },
                    { name: '💡 提示', value: '使用 `/频道冲水 停止` 可以中断清理过程', inline: false },
                ).setColor(0x00ff00).setTimestamp();
            await interaction.followUp({ embeds: [startEmbed] });
        } catch (_) {
            const timeoutEmbed = new EmbedBuilder().setTitle('⏰ 操作超时').setDescription('确认操作超时，清理任务已取消。').setColor(0x808080);
            await interaction.editReply({ embeds: [timeoutEmbed], components: [] });
        }
    },

    // ============================= 历史清理 =============================
    async _history(interaction, guildId) {
        await interaction.deferReply();
        const channel = interaction.options.getChannel('频道');
        const days = interaction.options.getInteger('天数') || 7;
        const limit = interaction.options.getInteger('限制数量') || 1000;

        const permissions = channel.permissionsFor(interaction.guild.members.me);
        if (!permissions.has(['ViewChannel', 'ReadMessageHistory', 'ManageMessages'])) {
            const embed = new EmbedBuilder().setTitle('❌ 权限不足').setDescription('机器人在该频道没有必要的权限。').setColor(0xff0000);
            return await interaction.editReply({ embeds: [embed] });
        }

        const bannedKeywords = await getBannedKeywords(guildId);
        if (bannedKeywords.length === 0) {
            const embed = new EmbedBuilder().setTitle('❌ 没有违禁关键字').setDescription('请先使用 `/频道冲水-关键词 添加` 命令设置要清理的关键字。').setColor(0xff0000);
            return await interaction.editReply({ embeds: [embed] });
        }

        const cutoffTime = Date.now() - (days * 24 * 60 * 60 * 1000);
        const rateLimiter = new RateLimiter();
        const keywordDetector = new KeywordDetector();

        const startEmbed = new EmbedBuilder()
            .setTitle('🔍 开始历史消息清理')
            .setDescription(`正在扫描频道 <#${channel.id}> 中的消息...`)
            .addFields(
                { name: '时间范围', value: `最近 ${days} 天`, inline: true },
                { name: '扫描限制', value: `最多 ${limit.toLocaleString()} 条`, inline: true },
                { name: '违禁关键字', value: `${bannedKeywords.length} 个`, inline: true },
            ).setColor(0x00ff00).setTimestamp();
        const statusMessage = await interaction.editReply({ embeds: [startEmbed] });

        let scannedCount = 0, deletedCount = 0, lastMessageId = null, hasMoreMessages = true, lastUpdateTime = Date.now();
        console.log(`🔍 开始历史消息清理 - Guild: ${guildId}, Channel: ${channel.name}, Days: ${days}, User: ${interaction.user.tag}`);

        while (hasMoreMessages && scannedCount < limit) {
            try {
                const messages = await rateLimiter.execute(async () => {
                    const options = { limit: Math.min(100, limit - scannedCount) };
                    if (lastMessageId) options.before = lastMessageId;
                    return await channel.messages.fetch(options);
                });
                if (messages.size === 0) { hasMoreMessages = false; break; }

                for (const [messageId, message] of messages) {
                    scannedCount++;
                    if (message.createdTimestamp < cutoffTime) { hasMoreMessages = false; break; }
                    if (message.author.bot || message.system) continue;

                    const checkResult = await keywordDetector.checkMessageAdvanced(message, bannedKeywords);
                    if (checkResult.shouldDelete) {
                        try {
                            await rateLimiter.execute(async () => { await message.delete(); });
                            deletedCount++;
                            console.log(`🗑️ 删除历史违规消息 - 频道: ${channel.name}, 作者: ${message.author.tag}, 关键字: ${checkResult.matchedKeywords.join(', ')}`);
                        } catch (deleteError) { console.error(`删除消息失败 - ID: ${messageId}:`, deleteError); }
                    }
                }
                lastMessageId = messages.last().id;

                const now = Date.now();
                if (now - lastUpdateTime >= 5000) {
                    const progressEmbed = new EmbedBuilder().setTitle('🔍 历史消息清理进行中').setDescription(`正在扫描频道 <#${channel.id}> 中的消息...`)
                        .addFields(
                            { name: '已扫描', value: `${scannedCount.toLocaleString()} 条`, inline: true },
                            { name: '已删除', value: `${deletedCount.toLocaleString()} 条`, inline: true },
                            { name: '进度', value: `${Math.round((scannedCount / limit) * 100)}%`, inline: true },
                        ).setColor(0x00ff00).setTimestamp();
                    await statusMessage.edit({ embeds: [progressEmbed] });
                    lastUpdateTime = now;
                }
                await new Promise(resolve => setTimeout(resolve, 200));
            } catch (error) { console.error('处理消息批次时出错:', error); break; }
        }

        const successRate = scannedCount > 0 ? ((deletedCount / scannedCount) * 100).toFixed(2) : '0';
        const duration = Math.round((Date.now() - statusMessage.createdTimestamp) / 1000);
        const completeEmbed = new EmbedBuilder().setTitle('✅ 历史消息清理完成').setDescription(`频道 <#${channel.id}> 的历史消息清理已完成！`)
            .addFields(
                { name: '扫描消息', value: `${scannedCount.toLocaleString()} 条`, inline: true },
                { name: '删除消息', value: `${deletedCount.toLocaleString()} 条`, inline: true },
                { name: '清理率', value: `${successRate}%`, inline: true },
                { name: '用时', value: `${duration} 秒`, inline: true },
                { name: '时间范围', value: `最近 ${days} 天`, inline: true },
                { name: '状态', value: scannedCount >= limit ? '达到扫描限制' : '全部完成', inline: true },
            ).setColor(0x00ff00).setTimestamp();
        await statusMessage.edit({ embeds: [completeEmbed] });
        console.log(`✅ 历史消息清理完成 - Guild: ${guildId}, Channel: ${channel.name}, Scanned: ${scannedCount}, Deleted: ${deletedCount}`);
    },

    // ============================= 状态 =============================
    async _status(interaction, guildId) {
        await interaction.deferReply({ ephemeral: true });
        const settings = await getAutoCleanupSettings(guildId);
        const activeTask = await taskManager.getActiveTask(guildId);
        const isAutoCleanupPaused = taskManager.isAutoCleanupPaused(guildId);

        const embed = new EmbedBuilder()
            .setTitle('🔍 自动清理状态')
            .setDescription(`服务器 **${interaction.guild.name}** 的清理功能状态`)
            .setColor(settings.isEnabled ? 0x00ff00 : 0xff0000)
            .setTimestamp();

        embed.addFields({
            name: '⚙️ 基本设置',
            value: `自动清理: ${settings.isEnabled ? '✅ 启用' : '❌ 禁用'}\n实时监控: ${settings.autoCleanupEnabled && !isAutoCleanupPaused ? '✅ 运行中' : '❌ 暂停/禁用'}\n违禁关键字: ${settings.bannedKeywords?.length || 0} 个`,
            inline: true,
        });

        let channelInfo = '所有频道';
        if (settings.monitorChannels && settings.monitorChannels.length > 0) channelInfo = `${settings.monitorChannels.length} 个指定频道`;
        embed.addFields({ name: '📺 监控范围', value: channelInfo, inline: true });

        const roleInfo = settings.cleanupRole ? `<@&${settings.cleanupRole}>` : '管理员权限';
        embed.addFields({ name: '👥 管理权限', value: roleInfo, inline: true });

        if (activeTask) {
            const startTime = new Date(activeTask.createdAt);
            const duration = Math.round((Date.now() - startTime.getTime()) / 1000);
            const progress = activeTask.progress || {};
            let taskStatus = '';
            if (activeTask.type === 'fullServer') {
                const channelProgress = progress.totalChannels > 0 ? Math.round((progress.completedChannels || 0) / progress.totalChannels * 100) : 0;
                taskStatus = `**全服务器清理** (${activeTask.status})\n进度: ${progress.completedChannels || 0}/${progress.totalChannels || 0} 频道 (${channelProgress}%)\n扫描: ${(progress.scannedMessages || 0).toLocaleString()} 消息\n删除: ${(progress.deletedMessages || 0).toLocaleString()} 消息\n运行时间: ${formatDuration(duration)}\n任务ID: \`${activeTask.taskId}\``;
            } else {
                taskStatus = `类型: ${activeTask.type}\n状态: ${activeTask.status}\n运行时间: ${formatDuration(duration)}`;
            }
            embed.addFields({ name: '🔄 当前任务', value: taskStatus, inline: false });
            embed.setColor(0xffa500);
        } else {
            embed.addFields({ name: '🔄 当前任务', value: '无活跃任务', inline: false });
        }

        if (isAutoCleanupPaused) {
            embed.addFields({ name: '⚠️ 注意', value: '自动清理功能已暂停，通常是因为有全服务器清理任务在进行中。', inline: false });
        }

        const taskStats = taskManager.getTaskStats();
        embed.addFields({ name: '📊 系统统计', value: `全局活跃任务: ${taskStats.totalActiveTasks}\n暂停清理的服务器: ${taskStats.pausedServers}`, inline: true });

        await interaction.editReply({ embeds: [embed] });
    },

    // ============================= 停止 =============================
    async _stop(interaction, guildId) {
        await interaction.deferReply({ ephemeral: true });
        const activeTask = await taskManager.getActiveTask(guildId);
        if (!activeTask) {
            const embed = new EmbedBuilder().setTitle('ℹ️ 没有活跃任务').setDescription('当前没有正在进行的清理任务。').setColor(0x808080);
            return await interaction.editReply({ embeds: [embed] });
        }

        await taskManager.stopTask(guildId, activeTask.taskId, 'manually_stopped');
        const startTime = new Date(activeTask.createdAt);
        const duration = Math.round((Date.now() - startTime) / 1000);

        const embed = new EmbedBuilder()
            .setTitle('⏹️ 清理任务已停止')
            .setDescription('清理任务已成功停止，自动清理功能已恢复。')
            .addFields(
                { name: '任务ID', value: `\`${activeTask.taskId}\``, inline: true },
                { name: '任务类型', value: activeTask.type === 'fullServer' ? '全服务器清理' : '未知', inline: true },
                { name: '运行时间', value: `${duration}秒`, inline: true },
            ).setColor(0xffa500).setTimestamp();

        if (activeTask.progress) {
            const progress = activeTask.progress;
            embed.addFields({ name: '📊 停止时的进度', value: `频道: ${progress.completedChannels || 0}/${progress.totalChannels || 0}\n扫描消息: ${(progress.scannedMessages || 0).toLocaleString()}\n删除消息: ${(progress.deletedMessages || 0).toLocaleString()}`, inline: false });
        }
        console.log(`⏹️ 停止清理任务 - Guild: ${guildId}, Task: ${activeTask.taskId}, User: ${interaction.user.tag}`);
        await interaction.editReply({ embeds: [embed] });
    },

    // ============================= 开关 =============================
    async _toggle(interaction, guildId) {
        await interaction.deferReply({ ephemeral: true });
        const enable = interaction.options.getBoolean('启用');
        const settings = await getAutoCleanupSettings(guildId);
        settings.isEnabled = enable;
        await saveAutoCleanupSettings(guildId, settings);

        const embed = new EmbedBuilder()
            .setTitle(enable ? '✅ 自动清理已启用' : '❌ 自动清理已禁用')
            .setDescription(enable ? '自动清理功能已启用。新消息将被自动检查和清理。' : '自动清理功能已禁用。不会自动清理任何消息。')
            .setColor(enable ? 0x00ff00 : 0xff0000).setTimestamp()
            .addFields(
                { name: '违禁关键字', value: `${settings.bannedKeywords.length} 个`, inline: true },
                { name: '监控频道', value: settings.monitorChannels.length > 0 ? `${settings.monitorChannels.length} 个指定频道` : '所有频道', inline: true },
            );
        if (enable && settings.bannedKeywords.length === 0) {
            embed.addFields({ name: '⚠️ 提醒', value: '请使用 `/频道冲水-关键词 添加` 命令设置要清理的关键字。', inline: false });
        }
        console.log(`🔄 切换自动清理 - Guild: ${guildId}, Enabled: ${enable}, User: ${interaction.user.tag}`);
        await interaction.editReply({ embeds: [embed] });
    },

    // ============================= 设置范围 =============================
    async _setRange(interaction, guildId) {
        await interaction.deferReply({ ephemeral: true });
        const clearSettings = interaction.options.getBoolean('清空设置') || false;

        if (clearSettings) {
            await setCleanupChannels(guildId, []);
            const embed = new EmbedBuilder().setTitle('✅ 清理频道设置已清空').setDescription('已清空所有监控频道设置，现在将监控服务器中的所有频道。').setColor(0x00ff00).setTimestamp();
            console.log(`✅ 清空清理频道设置 - Guild: ${guildId}, User: ${interaction.user.tag}`);
            return await interaction.editReply({ embeds: [embed] });
        }

        const selectedChannels = [];
        for (let i = 1; i <= 5; i++) {
            const ch = interaction.options.getChannel(`频道${i}`);
            if (ch) selectedChannels.push(ch);
        }
        if (selectedChannels.length === 0) {
            return await interaction.editReply({ content: '❌ 请至少选择一个频道，或使用"清空设置"选项来监控所有频道。' });
        }

        const invalidChannels = [];
        const validChannels = [];
        for (const channel of selectedChannels) {
            try {
                const permissions = channel.permissionsFor(interaction.guild.members.me);
                if (permissions.has(['ViewChannel', 'ReadMessageHistory', 'ManageMessages'])) validChannels.push(channel);
                else invalidChannels.push(channel);
            } catch (_) { invalidChannels.push(channel); }
        }
        if (validChannels.length === 0) {
            return await interaction.editReply({ content: '❌ 所选频道中没有任何频道具备必要的权限（查看频道、阅读消息历史、管理消息）。' });
        }

        const channelIds = validChannels.map(ch => ch.id);
        await setCleanupChannels(guildId, channelIds);

        const embed = new EmbedBuilder().setTitle('✅ 清理频道设置已更新').setDescription('成功设置要监控的频道。自动清理功能将只在这些频道中生效。').setColor(0x00ff00).setTimestamp();
        if (validChannels.length > 0) {
            embed.addFields({ name: `✅ 已设置的监控频道 (${validChannels.length})`, value: validChannels.map(ch => `<#${ch.id}>`).join('\n'), inline: false });
        }
        if (invalidChannels.length > 0) {
            embed.addFields({ name: `⚠️ 权限不足的频道 (${invalidChannels.length})`, value: `${invalidChannels.map(ch => `<#${ch.id}>`).join('\n')}\n*这些频道已跳过，请检查机器人权限*`, inline: false });
        }

        console.log(`✅ 设置清理频道 - Guild: ${guildId}, Channels: ${channelIds.join(', ')}, User: ${interaction.user.tag}`);
        await interaction.editReply({ embeds: [embed] });
    },
};
