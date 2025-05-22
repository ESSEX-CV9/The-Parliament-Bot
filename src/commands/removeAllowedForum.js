// src/commands/removeAllowedForum.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { removeAllowedForum, getAllowedForums } = require('../utils/database');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('removeallowedforum')
    .setDescription('移除允许审核的论坛频道')
    .addStringOption(option => 
        option.setName('服务器id')
            .setDescription('目标服务器ID')
            .setRequired(true))
    .addStringOption(option => 
        option.setName('论坛频道id')
            .setDescription('要从白名单移除的论坛频道ID')
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

        const targetServerId = interaction.options.getString('服务器id').trim();
        const forumChannelId = interaction.options.getString('论坛频道id').trim();
        
        // 验证ID格式
        if (!/^\d{17,19}$/.test(targetServerId)) {
            return interaction.reply({
                content: '❌ 无效的服务器ID格式。服务器ID应该是17-19位的数字。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        if (!/^\d{17,19}$/.test(forumChannelId)) {
            return interaction.reply({
                content: '❌ 无效的频道ID格式。频道ID应该是17-19位的数字。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        console.log(`用户 ${interaction.user.tag} 尝试移除允许论坛: 服务器=${targetServerId}, 论坛=${forumChannelId}`);
        
        // 从允许列表移除
        const removed = await removeAllowedForum(interaction.guild.id, targetServerId, forumChannelId);
        
        if (!removed) {
            return interaction.reply({
                content: `❌ 论坛频道 \`${forumChannelId}\` 不在服务器 \`${targetServerId}\` 的允许列表中。`,
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 获取更新后的允许论坛列表
        const allowedForums = await getAllowedForums(interaction.guild.id, targetServerId);
        
        await interaction.reply({
            content: `✅ **成功移除允许论坛频道！**\n\n**移除的论坛：**\n• 服务器ID: \`${targetServerId}\`\n• 频道ID: \`${forumChannelId}\`\n\n**该服务器剩余允许的论坛总数：** ${allowedForums.length}`,
            flags: MessageFlags.Ephemeral
        });
        
        console.log(`成功移除允许论坛: 服务器=${targetServerId}, 论坛=${forumChannelId}, 操作者=${interaction.user.tag}`);
        
    } catch (error) {
        console.error('移除允许论坛时出错:', error);
        await interaction.reply({
            content: `❌ 移除允许论坛时出错：${error.message}`,
            flags: MessageFlags.Ephemeral
        });
    }
}

module.exports = {
    data,
    execute,
};