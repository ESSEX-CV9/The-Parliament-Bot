const { MessageFlags, SlashCommandBuilder, ChannelType } = require('discord.js');
const {
    checkAdminPermission,
} = require('../../../core/utils/permissionManager');
const {
    isChannelBlocked,
    blockChannel,
    unblockChannel,
} = require('../utils/mysteryChannelBlocklist');

const THREAD_TYPES = new Set([
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
]);

const data = new SlashCommandBuilder()
    .setName('神秘指令开关')
    .setDescription('在当前子区/频道内禁用或启用神秘指令')
    .addSubcommand(subcommand => subcommand
        .setName('禁用')
        .setDescription('在当前子区/频道内禁用所有神秘指令'))
    .addSubcommand(subcommand => subcommand
        .setName('启用')
        .setDescription('在当前子区/频道内重新启用神秘指令'));

/**
 * 判断用户是否有权操作当前频道的神秘指令开关。
 * - 管理员：任何频道都可以
 * - 子区主 (thread owner)：只能在自己创建的子区内
 */
function hasTogglePermission(interaction) {
    // 管理员始终有权
    if (checkAdminPermission(interaction.member)) return true;

    const channel = interaction.channel;
    // 非子区类型的频道，只有管理员能操作
    if (!channel || !THREAD_TYPES.has(channel.type)) return false;

    // 子区主可以操作自己的子区
    return channel.ownerId === interaction.user.id;
}

async function execute(interaction) {
    if (!interaction.inGuild()) {
        await interaction.reply({
            content: '❌ 此命令只能在服务器中使用。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    if (!hasTogglePermission(interaction)) {
        const channel = interaction.channel;
        const isThread = channel && THREAD_TYPES.has(channel.type);
        const hint = isThread
            ? '只有本子区的创建者或管理员才能操作此开关。'
            : '只有管理员才能在普通频道操作此开关。';
        await interaction.reply({
            content: `❌ 你没有权限操作。${hint}`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const subcommand = interaction.options.getSubcommand(false);
    const guildId = interaction.guild.id;
    const channelId = interaction.channel.id;
    const channelName = interaction.channel.name || '当前频道';

    if (subcommand === '禁用') {
        const added = blockChannel(guildId, channelId, interaction.user.id);
        if (added) {
            await interaction.reply({
                content: `🚫 已在「${channelName}」中禁用所有神秘指令。\n使用 \`/神秘指令开关 启用\` 可重新启用。`,
            });
        } else {
            await interaction.reply({
                content: `ℹ️ 「${channelName}」的神秘指令已经是禁用状态。`,
                flags: MessageFlags.Ephemeral,
            });
        }
    } else if (subcommand === '启用') {
        const removed = unblockChannel(guildId, channelId);
        if (removed) {
            await interaction.reply({
                content: `✅ 已在「${channelName}」中重新启用神秘指令。`,
            });
        } else {
            await interaction.reply({
                content: `ℹ️ 「${channelName}」的神秘指令本来就是启用状态。`,
                flags: MessageFlags.Ephemeral,
            });
        }
    } else {
        await interaction.reply({
            content: '❌ 未知的操作。',
            flags: MessageFlags.Ephemeral,
        });
    }
}

module.exports = { data, execute };
