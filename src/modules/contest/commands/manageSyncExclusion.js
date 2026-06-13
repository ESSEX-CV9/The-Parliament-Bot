// src/modules/contest/commands/manageSyncExclusion.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const {
    getContestSettings,
    getSyncExclusions,
    addSyncExclusion,
    removeSyncExclusion,
    getAllContestChannels,
} = require('../utils/contestDatabase');
const { checkContestReviewPermission, getReviewPermissionDeniedMessage } = require('../utils/contestPermissions');

const data = new SlashCommandBuilder()
    .setName('赛事-同步排除')
    .setDescription('管理对账同步的排除名单：名单内的赛事在「同步书单」时会被跳过，不会被重建')
    .addStringOption(option =>
        option.setName('操作')
            .setDescription('要执行的操作')
            .setRequired(true)
            .addChoices(
                { name: '查看名单', value: 'list' },
                { name: '添加排除', value: 'add' },
                { name: '移除排除', value: 'remove' },
            ))
    .addStringOption(option =>
        option.setName('频道id')
            .setDescription('要添加/移除的赛事频道ID（添加、移除时必填）')
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
        if (!checkContestReviewPermission(interaction.member, settings)) {
            return interaction.reply({
                content: getReviewPermissionDeniedMessage(),
                flags: MessageFlags.Ephemeral,
            });
        }

        const action = interaction.options.getString('操作');
        const rawId = interaction.options.getString('频道id');
        const channelId = rawId ? rawId.trim().replace(/[<#>]/g, '') : null;
        const guildId = interaction.guild.id;
        const allChannels = getAllContestChannels();

        const titleOf = (id) => allChannels[id]?.contestTitle || '(本地无记录)';

        if (action === 'list') {
            const list = getSyncExclusions(guildId);
            if (list.length === 0) {
                return interaction.reply({
                    content: 'ℹ️ 当前排除名单为空。同步书单时不会跳过任何赛事。',
                    flags: MessageFlags.Ephemeral,
                });
            }
            const lines = list.map(id => `• **${titleOf(id)}** — 频道ID: \`${id}\``).join('\n');
            return interaction.reply({
                content: `🚫 **同步排除名单（${list.length} 项）**\n这些赛事在 \`/赛事-同步书单\` 时会被跳过：\n\n${lines}`,
                flags: MessageFlags.Ephemeral,
            });
        }

        // add / remove 都需要频道ID
        if (!channelId || !/^\d{5,}$/.test(channelId)) {
            return interaction.reply({
                content: '❌ 请提供有效的「频道id」（纯数字）。可在 `/赛事-书单列表` 里复制对应书单的频道ID。',
                flags: MessageFlags.Ephemeral,
            });
        }

        if (action === 'add') {
            const added = addSyncExclusion(guildId, channelId);
            return interaction.reply({
                content: added
                    ? `✅ 已将 **${titleOf(channelId)}**（\`${channelId}\`）加入排除名单。\n之后 \`/赛事-同步书单\` 将跳过它，不再重建其书单。\n\n💡 如需删除它已有的书单，请用 \`/赛事-删除书单 频道id:${channelId}\`。`
                    : `ℹ️ \`${channelId}\` 已在排除名单中，无需重复添加。`,
                flags: MessageFlags.Ephemeral,
            });
        }

        if (action === 'remove') {
            const removed = removeSyncExclusion(guildId, channelId);
            return interaction.reply({
                content: removed
                    ? `✅ 已将 **${titleOf(channelId)}**（\`${channelId}\`）移出排除名单。\n之后 \`/赛事-同步书单\` 会重新纳入它。`
                    : `ℹ️ \`${channelId}\` 不在排除名单中。`,
                flags: MessageFlags.Ephemeral,
            });
        }

    } catch (error) {
        console.error('[manageSyncExclusion] 执行出错:', error);
        try {
            await interaction.reply({ content: `❌ 操作时出错：${error.message}`, flags: MessageFlags.Ephemeral });
        } catch (_) {}
    }
}

module.exports = { data, execute };
