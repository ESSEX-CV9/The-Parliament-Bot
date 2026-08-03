const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
} = require('discord.js');
const {
    checkAdminPermission,
    getPermissionDeniedMessage,
} = require('../../../core/utils/permissionManager');
const {
    openManagedGuild,
    disableManagedGuild,
} = require('../services/safetyManager');

const data = new SlashCommandBuilder()
    .setName('开门')
    .setDescription('停止邀请暂停托管并恢复服务器邀请');

async function execute(interaction) {
    if (!interaction.inGuild()) {
        return interaction.reply({
            content: '❌ 此命令只能在服务器中使用。',
            flags: MessageFlags.Ephemeral,
        });
    }

    if (!checkAdminPermission(interaction.member)) {
        return interaction.reply({
            content: getPermissionDeniedMessage(),
            flags: MessageFlags.Ephemeral,
        });
    }

    const guildId = interaction.guild.id;
    const botMember = interaction.guild.members.me;
    if (!botMember?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const result = await disableManagedGuild({ guildId });
            const state = result.managed
                ? '自动托管已停止；当前 Discord 暂停会在原截止时间自然结束，或可由后台手动恢复。'
                : '当前服务器未由 Bot 托管，未修改 Discord 后台的安全措施。';
            return interaction.editReply({
                content: `⚠️ Bot 缺少“管理服务器（Manage Guild）”权限，无法立即恢复邀请。${state}`,
            });
        } catch (error) {
            console.error(`[SafetySetup] /开门 停止托管失败 (guild=${guildId}):`, error);
            return interaction.editReply({
                content: `❌ Bot 缺少“管理服务器（Manage Guild）”权限，且无法确认自动托管是否已停止：${error.message}`,
            });
        }
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const result = await openManagedGuild({
            guild: interaction.guild,
            guildId,
        });
        if (!result.managed) {
            return interaction.editReply({
                content: 'ℹ️ 当前服务器未由 Bot 托管，未修改 Discord 后台的安全措施。',
            });
        }
        return interaction.editReply({
            content: '🔓 **已开门：自动托管已停止，服务器邀请已恢复。**',
        });
    } catch (error) {
        console.error(`[SafetySetup] /开门 执行失败 (guild=${guildId}):`, error);
        return interaction.editReply({
            content: [
                '⚠️ 自动托管已停止，但 Discord 恢复邀请失败。',
                'Bot 不会再次续期；当前暂停将在 Discord 原截止时间自然结束。',
                `错误：${error.message}`,
            ].join('\n'),
        });
    }
}

module.exports = { data, execute };
