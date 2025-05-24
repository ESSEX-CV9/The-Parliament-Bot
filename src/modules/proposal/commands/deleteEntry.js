// src/commands/deleteEntry.js
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('deleteentry')
    .setDescription('删除表单入口消息')
    .addStringOption(option => 
        option.setName('消息id')
            .setDescription('要删除的表单入口消息ID')
            .setRequired(true))
    // .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

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
        
        console.log(`用户 ${interaction.user.tag} 尝试删除表单入口消息: ${messageId}`);
        
        // 尝试获取并删除消息
        const message = await interaction.channel.messages.fetch(messageId).catch(() => null);
        
        if (!message) {
            return interaction.reply({
                content: '❌ 找不到指定的消息，请检查消息ID是否正确。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 检查消息是否是机器人发送的表单入口
        if (message.author.id !== interaction.client.user.id) {
            return interaction.reply({
                content: '❌ 只能删除机器人发送的表单入口消息。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 检查消息是否包含表单入口按钮
        const hasFormButton = message.components.some(row => 
            row.components.some(component => 
                component.customId === 'open_form'
            )
        );
        
        if (!hasFormButton) {
            return interaction.reply({
                content: '❌ 指定的消息不是表单入口消息。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 删除消息
        await message.delete();
        
        console.log(`表单入口消息已被删除: ${messageId}, 操作者: ${interaction.user.tag}`);
        
        await interaction.reply({
            content: '✅ 表单入口已成功删除。',
            flags: MessageFlags.Ephemeral
        });
        
    } catch (error) {
        console.error('删除入口时出错:', error);
        await interaction.reply({
            content: '❌ 删除表单入口时出错，请查看控制台日志。',
            flags: MessageFlags.Ephemeral
        });
    }
}

module.exports = {
    data,
    execute,
};