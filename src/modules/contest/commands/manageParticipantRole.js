// src/modules/contest/commands/manageParticipantRole.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getContestChannel } = require('../utils/contestDatabase');
const { checkContestManagePermission, getManagePermissionDeniedMessage } = require('../utils/contestPermissions');
const { openRoleManagementPanel } = require('../services/participantRoleService');

const data = new SlashCommandBuilder()
    .setName('管理比赛身份组')
    .setDescription('打开参赛者身份组的管理面板');

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
    const hasPermission = checkContestManagePermission(interaction.member, contestChannelData);
    if (!hasPermission) {
        return interaction.editReply({
            content: getManagePermissionDeniedMessage(),
        });
    }

    try {
        await openRoleManagementPanel(interaction);
    } catch (error) {
        console.error('Error opening role management panel:', error);
        await interaction.editReply({ content: '❌ 打开管理面板时发生未知错误。' });
    }
}

module.exports = {
    data,
    execute,
};