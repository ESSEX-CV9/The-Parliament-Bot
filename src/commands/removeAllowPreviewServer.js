// src/commands/removeAllowPreviewServer.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { removeAllowedServer, getAllowedServers } = require('../utils/database');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('removeallowpreviewserver')
    .setDescription('移除允许审核的服务器')
    .addStringOption(option => 
        option.setName('服务器id')
            .setDescription('要从允许列表移除的服务器ID')
            .setRequired(true));

async function execute(interaction) {
    try {
        // 检查是否在服务器中使用
        if (!interaction.guild) {
            return interaction.reply({
                content: '❌ 此指令只能在服务器中使用，不能在私信中使用。',
                flags: MessageFlags.Ephemeral
            });
        }

        // 检查用户权限
        const hasPermission = checkAdminPermission(interaction.member);
        
        if (!hasPermission) {
            return interaction.reply({
                content: getPermissionDeniedMessage(),
                flags: MessageFlags.Ephemeral
            });
        }

        // 立即defer以防止超时
        await interaction.deferReply({ ephemeral: true });

        const targetGuildId = interaction.options.getString('服务器id').trim();
        
        // 验证服务器ID格式
        if (!/^\d{17,19}$/.test(targetGuildId)) {
            return interaction.editReply({
                content: '❌ 无效的服务器ID格式。服务器ID应该是17-19位的数字。'
            });
        }
        
        console.log(`用户 ${interaction.user.tag} 尝试移除允许服务器: ${targetGuildId}`);
        
        // 从允许列表移除
        const removed = await removeAllowedServer(interaction.guild.id, targetGuildId);
        
        if (!removed) {
            return interaction.editReply({
                content: `❌ 服务器 \`${targetGuildId}\` 不在允许列表中。`
            });
        }
        
        // 获取更新后的允许列表
        const allowedServers = await getAllowedServers(interaction.guild.id);
        
        await interaction.editReply({
            content: `✅ **成功移除允许服务器！**\n\n**移除的服务器ID：** \`${targetGuildId}\`\n**当前允许的服务器总数：** ${allowedServers.length}`
        });
        
        console.log(`成功移除允许服务器: ${targetGuildId}, 操作者: ${interaction.user.tag}`);
        
    } catch (error) {
        console.error('移除允许服务器时出错:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: `❌ 移除允许服务器时出错：${error.message}`,
                flags: MessageFlags.Ephemeral
            });
        } else {
            await interaction.editReply({
                content: `❌ 移除允许服务器时出错：${error.message}`
            });
        }
    }
}

module.exports = {
    data,
    execute,
};