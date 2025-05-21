// src/events/interactionCreate.js
const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const { createFormModal } = require('../components/formModal');
const { createWithdrawModal } = require('../components/withdrawModal');
const { processFormSubmission } = require('../services/formService');
const { processVote } = require('../services/voteTracker');
const { processWithdraw } = require('../services/withdrawService');

async function interactionCreateHandler(interaction) {
    try {
        // 处理命令
        if (interaction.isChatInputCommand()) {
            const command = interaction.client.commands.get(interaction.commandName);
            
            if (!command) return;
            
            await command.execute(interaction);
            return;
        }
        
        // 处理按钮点击
        if (interaction.isButton()) {
            if (interaction.customId === 'open_form') {
                // 打开表单模态窗口
                const modal = createFormModal();
                await interaction.showModal(modal);
            } else if (interaction.customId === 'delete_entry') {
                // 检查用户是否有管理员权限
                if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                    // 删除消息
                    await interaction.message.delete();
                    await interaction.reply({
                        content: '入口已删除',
                        flags: MessageFlags.Ephemeral
                    });
                } else {
                    await interaction.reply({
                        content: '你没有权限执行此操作',
                        flags: MessageFlags.Ephemeral
                    });
                }
            } else if (interaction.customId.startsWith('support_')) {
                // 处理支持按钮
                await processVote(interaction);
            } else if (interaction.customId.startsWith('withdraw_')) {
                // 处理撤回按钮 - 仅管理员可见
                if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                    await interaction.reply({
                        content: '你没有权限执行此操作',
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }
                
                // 从按钮ID中提取消息ID
                const messageId = interaction.customId.replace('withdraw_', '');
                
                // 创建并显示撤回原因模态窗口
                const modal = createWithdrawModal(messageId);
                await interaction.showModal(modal);
            }
            return;
        }
        
        // 处理模态窗口提交
        if (interaction.isModalSubmit()) {
            if (interaction.customId === 'form_submission') {
                await processFormSubmission(interaction);
            } else if (interaction.customId.startsWith('withdraw_submission_')) {
                // 处理撤回提案模态窗口提交
                await processWithdraw(interaction);
            }
            return;
        }
    } catch (error) {
        console.error('交互处理错误:', error);
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ 
                    content: '处理您的请求时出现错误。', 
                    flags: MessageFlags.Ephemeral
                });
            }
        } catch (replyError) {
            console.error('回复错误:', replyError);
        }
    }
}

module.exports = {
    interactionCreateHandler,
};