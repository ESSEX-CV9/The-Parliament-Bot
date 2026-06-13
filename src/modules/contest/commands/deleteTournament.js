// src/modules/contest/commands/deleteTournament.js
const {
    SlashCommandBuilder,
    ChannelType,
    MessageFlags,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
} = require('discord.js');
const { getContestSettings } = require('../utils/contestDatabase');
const { checkContestReviewPermission, getReviewPermissionDeniedMessage } = require('../utils/contestPermissions');
const { deleteBooklist, listGuildBooklists, deleteAllGuildBooklists } = require('../services/tournamentSyncService');

const data = new SlashCommandBuilder()
    .setName('赛事-删除书单')
    .setDescription('删除索引页上的赛事书单（可删单个或本服全部，需二次确认）')
    .addChannelOption(option =>
        option.setName('频道')
            .setDescription('要删除书单的赛事频道')
            .setRequired(false)
            .addChannelTypes(ChannelType.GuildText))
    .addStringOption(option =>
        option.setName('频道id')
            .setDescription('要删除书单的频道ID（用于频道已删除的孤儿书单，可从 /赛事-书单列表 复制）')
            .setRequired(false))
    .addBooleanOption(option =>
        option.setName('删除全部')
            .setDescription('删除本服全部赛事书单（用于清空重建，谨慎操作）')
            .setRequired(false));

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

        const targetChannel = interaction.options.getChannel('频道');
        const rawChannelId = interaction.options.getString('频道id');
        const deleteAll = interaction.options.getBoolean('删除全部') || false;

        // 解析单频道目标：优先频道选择器，其次手填的频道ID（用于已删除频道的孤儿书单）
        const cleanedId = rawChannelId ? rawChannelId.trim().replace(/[<#>]/g, '') : null;
        const singleTargetId = targetChannel?.id || cleanedId || null;
        const singleCount = [targetChannel, cleanedId, deleteAll].filter(Boolean).length;

        // 参数校验：三者只能选其一
        if (singleCount > 1) {
            return interaction.reply({
                content: '❌ 「频道」「频道id」「删除全部」只能指定其中一个。',
                flags: MessageFlags.Ephemeral,
            });
        }
        if (singleCount === 0) {
            return interaction.reply({
                content: '❌ 请指定要删除书单的「频道」或「频道id」，或勾选「删除全部」。',
                flags: MessageFlags.Ephemeral,
            });
        }
        if (cleanedId && !/^\d{5,}$/.test(cleanedId)) {
            return interaction.reply({
                content: '❌ 「频道id」格式不对，应为纯数字。可从 `/赛事-书单列表` 复制。',
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ ephemeral: true });

        // 组织确认信息
        let confirmText;
        if (deleteAll) {
            const booklists = await listGuildBooklists(interaction.guild.id);
            if (booklists.length === 0) {
                return interaction.editReply({ content: 'ℹ️ 本服在索引页上没有任何赛事书单，无需删除。' });
            }
            const listPreview = booklists
                .slice(0, 15)
                .map(b => `• ${b.title}（${b.itemCount} 项）`)
                .join('\n');
            const more = booklists.length > 15 ? `\n…等共 ${booklists.length} 个` : '';
            confirmText =
                `⚠️ **危险操作：即将删除本服全部赛事书单**\n\n` +
                `共 **${booklists.length}** 个书单将被永久删除（含其下所有帖子记录）：\n${listPreview}${more}\n\n` +
                `删除后可用 \`/赛事-同步书单\` 重新建立。是否继续？`;
        } else {
            confirmText =
                `⚠️ **确认删除该赛事书单？**\n\n` +
                `频道：<#${singleTargetId}>（ID: \`${singleTargetId}\`）\n\n` +
                `将永久删除该书单及其下所有帖子记录。删除后可用 \`/赛事-同步书单\` 重建。是否继续？`;
        }

        const confirmBtn = new ButtonBuilder()
            .setCustomId('tournament_delete_confirm')
            .setLabel(deleteAll ? '确认删除全部' : '确认删除')
            .setStyle(ButtonStyle.Danger);
        const cancelBtn = new ButtonBuilder()
            .setCustomId('tournament_delete_cancel')
            .setLabel('取消')
            .setStyle(ButtonStyle.Secondary);
        const row = new ActionRowBuilder().addComponents(confirmBtn, cancelBtn);

        const prompt = await interaction.editReply({ content: confirmText, components: [row] });

        let choice;
        try {
            choice = await prompt.awaitMessageComponent({
                filter: i => i.user.id === interaction.user.id,
                componentType: ComponentType.Button,
                time: 30000,
            });
        } catch (_) {
            return interaction.editReply({ content: '⌛ 操作超时已取消，未删除任何书单。', components: [] });
        }

        if (choice.customId === 'tournament_delete_cancel') {
            return choice.update({ content: '✅ 已取消，未删除任何书单。', components: [] });
        }

        await choice.update({ content: '⏳ 正在删除，请稍候...', components: [] });

        if (deleteAll) {
            const stats = await deleteAllGuildBooklists(interaction.guild.id);
            const errorLines = stats.errors.length > 0
                ? `\n\n⚠️ **失败 ${stats.errors.length} 个：**\n${stats.errors.map(e => `• ${e.title}：${e.error}`).join('\n')}`
                : '';
            await interaction.editReply({
                content:
                    `🗑️ **批量删除完成**\n\n` +
                    `📦 共 **${stats.total}** 个书单\n` +
                    `✔️ 成功删除 **${stats.deleted}** 个` +
                    errorLines,
                components: [],
            });
        } else {
            try {
                await deleteBooklist(singleTargetId);
                await interaction.editReply({
                    content: `🗑️ 已删除 <#${singleTargetId}>（\`${singleTargetId}\`）的赛事书单。`,
                    components: [],
                });
            } catch (e) {
                await interaction.editReply({
                    content: `❌ 删除失败：${e.message}\n（该频道可能在索引页上没有对应书单）`,
                    components: [],
                });
            }
        }

    } catch (error) {
        console.error('[deleteTournament] 执行出错:', error);
        try {
            if (interaction.deferred) {
                await interaction.editReply({ content: `❌ 删除时出现错误：${error.message}`, components: [] });
            } else {
                await interaction.reply({ content: `❌ 删除时出现错误：${error.message}`, flags: MessageFlags.Ephemeral });
            }
        } catch (_) {}
    }
}

module.exports = { data, execute };
