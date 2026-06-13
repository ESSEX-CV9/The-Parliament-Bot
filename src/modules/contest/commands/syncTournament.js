// src/modules/contest/commands/syncTournament.js
const { SlashCommandBuilder, ChannelType, MessageFlags } = require('discord.js');
const { getContestSettings } = require('../utils/contestDatabase');
const { checkContestReviewPermission, getReviewPermissionDeniedMessage } = require('../utils/contestPermissions');
const { retroSync } = require('../services/tournamentSyncService');

const data = new SlashCommandBuilder()
    .setName('赛事-同步书单')
    .setDescription('将赛事书单同步到索引页，补全历史投稿记录')
    .addChannelOption(option =>
        option.setName('频道')
            .setDescription('指定要同步的赛事频道（不填则同步全部赛事）')
            .setRequired(false)
            .addChannelTypes(ChannelType.GuildText));

async function execute(interaction) {
    try {
        if (!interaction.guild) {
            return interaction.reply({
                content: '❌ 此指令只能在服务器中使用。',
                flags: MessageFlags.Ephemeral,
            });
        }

        const settings = await getContestSettings(interaction.guild.id);
        const hasPermission = checkContestReviewPermission(interaction.member, settings);
        if (!hasPermission) {
            return interaction.reply({
                content: getReviewPermissionDeniedMessage(),
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ ephemeral: true });

        const targetChannel = interaction.options.getChannel('频道');
        const targetChannelId = targetChannel?.id || null;
        const scopeText = targetChannel ? `<#${targetChannelId}>` : '全部赛事';

        await interaction.editReply({ content: `⏳ 正在同步 ${scopeText} 的书单，请稍候...` });

        const stats = await retroSync(interaction.guild.id, targetChannelId);

        const errorLines = stats.errors.length > 0
            ? `\n\n⚠️ **失败 ${stats.errors.length} 场：**\n${stats.errors.map(e => `• ${e.title}：${e.error}`).join('\n')}`
            : '';

        await interaction.editReply({
            content:
                `✅ **书单同步完成**\n\n` +
                `📦 共处理 **${stats.total}** 场赛事\n` +
                `✔️ 成功同步 **${stats.synced}** 场\n` +
                `➕ 新增投稿 **${stats.addedItems}** 条\n` +
                `⏭️ 跳过（帖子未收录）**${stats.skippedItems}** 条` +
                errorLines,
        });

    } catch (error) {
        console.error('[syncTournament] 执行出错:', error);
        try {
            if (interaction.deferred) {
                await interaction.editReply({ content: `❌ 同步时出现错误：${error.message}` });
            } else {
                await interaction.reply({ content: `❌ 同步时出现错误：${error.message}`, flags: MessageFlags.Ephemeral });
            }
        } catch (_) {}
    }
}

module.exports = { data, execute };
