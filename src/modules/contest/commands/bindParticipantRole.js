// src/modules/contest/commands/bindParticipantRole.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getContestChannel } = require('../utils/contestDatabase');
const { checkContestRoleBindingPermission, getManagePermissionDeniedMessage } = require('../utils/contestPermissions');
const { bindParticipantRole } = require('../services/participantRoleService');

const data = new SlashCommandBuilder()
    .setName('赛事-绑定比赛身份组')
    .setDescription('为当前比赛绑定一个参赛者专属的装饰身份组')
    .addRoleOption(option =>
        option.setName('身份组')
            .setDescription('要绑定的装饰性身份组（必须没有任何权限）')
            .setRequired(true));

async function execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    // 1. 检查是否在赛事频道中
    const contestChannelData = await getContestChannel(interaction.channel.id);
    if (!contestChannelData) {
        return interaction.editReply({
            content: '❌ 此指令只能在赛事频道中使用。',
        });
    }

    // 2. 检查权限
    const hasPermission = checkContestRoleBindingPermission(interaction.member, contestChannelData);
    if (!hasPermission) {
        return interaction.editReply({
            content: getManagePermissionDeniedMessage(),
        });
    }

    const role = interaction.options.getRole('身份组');

    try {
        await bindParticipantRole(interaction, role);
    } catch (error) {
        console.error('Error binding participant role:', error);
        await interaction.editReply({ content: '❌ 绑定身份组时发生未知错误。' });
    }
}

module.exports = {
    data,
    execute,
};