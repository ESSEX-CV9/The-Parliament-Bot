const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
} = require('discord.js');
const {
    checkAdminPermission,
    getPermissionDeniedMessage,
} = require('../../../core/utils/permissionManager');
const { closeManagedGuild } = require('../services/safetyManager');
const {
    parseBeijingResumeTime,
    formatBeijingDateTime,
} = require('../utils/beijingTime');

const data = new SlashCommandBuilder()
    .setName('关门')
    .setDescription('暂停服务器邀请并交由 Bot 自动续期托管')
    .addStringOption((option) => option
        .setName('恢复时间')
        .setDescription('可选，北京时间 YYYY-MM-DD HH:mm；不填则仅 /开门 才恢复')
        .setRequired(false));

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

    const botMember = interaction.guild.members.me;
    if (!botMember?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
            content: '❌ Bot 缺少“管理服务器（Manage Guild）”权限，无法暂停邀请。',
            flags: MessageFlags.Ephemeral,
        });
    }

    const resumeTimeInput = interaction.options.getString('恢复时间');
    const nowMs = Date.now();
    let resumeAt = null;

    if (resumeTimeInput) {
        try {
            resumeAt = parseBeijingResumeTime(resumeTimeInput, nowMs);
        } catch (error) {
            return interaction.reply({
                content: `❌ ${error.message}`,
                flags: MessageFlags.Ephemeral,
            });
        }
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const invitesDisabledUntil = await closeManagedGuild({
            guild: interaction.guild,
            guildId: interaction.guild.id,
            enabledBy: interaction.user.id,
            resumeAt: resumeAt?.toISOString() || null,
            nowMs,
        });

        const discordUntilTimestamp = Math.floor(invitesDisabledUntil.getTime() / 1000);
        const modeText = resumeAt
            ? `预约在 **${formatBeijingDateTime(resumeAt)}（北京时间）** 自动恢复邀请。`
            : '已启用无限期托管，直到执行 `/开门` 才恢复邀请。';

        return interaction.editReply({
            content: [
                '🔒 **已关门：服务器邀请已暂停**',
                '',
                modeText,
                `Discord 当前暂停截止：<t:${discordUntilTimestamp}:F>`,
                'Bot 会在 Discord 的 24 小时限制到期前自动续期。',
            ].join('\n'),
        });
    } catch (error) {
        console.error(`[SafetySetup] /关门 执行失败 (guild=${interaction.guild.id}):`, error);
        return interaction.editReply({
            content: `❌ 暂停邀请失败，未启用自动托管：${error.message}`,
        });
    }
}

module.exports = { data, execute };
