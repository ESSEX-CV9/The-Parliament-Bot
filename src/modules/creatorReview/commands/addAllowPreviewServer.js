// src/commands/addAllowPreviewServer.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { addAllowedServer, getAllowedServers } = require('../utils/database');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('addallowpreviewserver')
    .setDescription('添加允许审核的服务器')
    .addStringOption(option => 
        option.setName('服务器id')
            .setDescription('要添加到允许列表的服务器ID')
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

        const targetGuildId = interaction.options.getString('服务器id').trim();
        
        // 验证服务器ID格式（Discord服务器ID是18-19位数字）
        if (!/^\d{17,19}$/.test(targetGuildId)) {
            return interaction.reply({
                content: '❌ 无效的服务器ID格式。服务器ID应该是17-19位的数字。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        console.log(`用户 ${interaction.user.tag} 尝试添加允许服务器: ${targetGuildId}`);
        
        // 尝试获取目标服务器信息（验证服务器是否存在且机器人在其中）
        let targetGuild = null;
        try {
            targetGuild = await interaction.client.guilds.fetch(targetGuildId);
        } catch (error) {
            console.log('无法获取目标服务器信息，可能机器人不在该服务器中');
        }
        
        // 添加到允许列表
        const added = await addAllowedServer(interaction.guild.id, targetGuildId);
        
        if (!added) {
            return interaction.reply({
                content: `❌ 服务器 \`${targetGuildId}\` 已经在允许列表中了。`,
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 获取更新后的允许列表
        const allowedServers = await getAllowedServers(interaction.guild.id);
        
        let responseContent = `✅ **成功添加允许服务器！**\n\n**添加的服务器：**\n• ID: \`${targetGuildId}\``;
        
        if (targetGuild) {
            responseContent += `\n• 名称: ${targetGuild.name}`;
            responseContent += `\n• 成员数: ${targetGuild.memberCount}`;
        } else {
            responseContent += `\n• ⚠️ 注意：机器人不在该服务器中，无法获取服务器详细信息`;
        }
        
        responseContent += `\n\n**当前允许的服务器总数：** ${allowedServers.length}`;
        
        await interaction.reply({
            content: responseContent,
            flags: MessageFlags.Ephemeral
        });
        
        console.log(`成功添加允许服务器: ${targetGuildId}, 操作者: ${interaction.user.tag}`);
        
    } catch (error) {
        console.error('添加允许服务器时出错:', error);
        await interaction.reply({
            content: `❌ 添加允许服务器时出错：${error.message}`,
            flags: MessageFlags.Ephemeral
        });
    }
}

module.exports = {
    data,
    execute,
};