// src/commands/deleteReviewEntry.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('deletereviewentry')
    .setDescription('删除审核入口消息')
    .addStringOption(option => 
        option.setName('消息id')
            .setDescription('要删除的审核入口消息ID')
            .setRequired(true));

async function execute(interaction) {
    try {
        // 检查用户权限
        const hasPermission = checkAdminPermission(interaction.member);
        
        if (!hasPermission) {
            return interaction.reply({
                content: getPermissionDeniedMessage(),
                flags: MessageFlags.Ephemeral
            });
        }
        
        const messageId = interaction.options.getString('消息id');
        
        console.log(`用户 ${interaction.user.tag} 尝试删除审核入口消息: ${messageId}`);
        
        // 尝试获取并删除消息
        const message = await interaction.channel.messages.fetch(messageId).catch(() => null);
        
        if (!message) {
            return interaction.reply({
                content: '❌ 找不到指定的消息，请检查消息ID是否正确。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 检查消息是否是机器人发送的审核入口
        if (message.author.id !== interaction.client.user.id) {
            return interaction.reply({
                content: '❌ 只能删除机器人发送的审核入口消息。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 检查消息是否包含审核入口按钮
        const hasReviewButton = message.components.some(row => 
            row.components.some(component => 
                component.customId === 'open_review_form'
            )
        );
        
        if (!hasReviewButton) {
            return interaction.reply({
                content: '❌ 指定的消息不是审核入口消息。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 删除消息
        await message.delete();
        
        console.log(`审核入口消息已被删除: ${messageId}, 操作者: ${interaction.user.tag}`);
        
        await interaction.reply({
            content: '✅ 审核入口已成功删除。',
            flags: MessageFlags.Ephemeral
        });
        
    } catch (error) {
        console.error('删除审核入口时出错:', error);
        await interaction.reply({
            content: '❌ 删除审核入口时出错，请查看控制台日志。',
            flags: MessageFlags.Ephemeral
        });
    }
}

module.exports = {
    data,
    execute,
};