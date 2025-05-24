// src/events/interactionCreate.js
const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const { createFormModal } = require('../../modules/proposal/components/formModal');
const { createReviewModal } = require('../../modules/creatorReview/components/reviewModal'); 
const { processFormSubmission } = require('../../modules/proposal/services/formService');
const { processReviewSubmission } = require('../../modules/creatorReview/services/reviewService'); 
const { processVote } = require('../../modules/proposal/services/voteTracker');
// 新增法庭相关处理
const { processCourtSupport } = require('../../services/courtVoteTracker');
const { processCourtVote } = require('../../services/courtVotingSystem');

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
            } else if (interaction.customId === 'open_review_form') { 
                // 打开审核表单模态窗口
                const modal = createReviewModal();
                await interaction.showModal(modal);
            } else if (interaction.customId.startsWith('support_')) {
                // 处理支持按钮（原有的提案系统）
                await processVote(interaction);
            } else if (interaction.customId.startsWith('court_support_')) {
                // 处理法庭申请支持按钮
                await processCourtSupport(interaction);
            } else if (interaction.customId.startsWith('court_vote_support_') || 
                       interaction.customId.startsWith('court_vote_oppose_')) {
                // 处理法庭投票按钮
                await processCourtVote(interaction);
            }
            return;
        }
        
        // 处理模态窗口提交
        if (interaction.isModalSubmit()) {
            if (interaction.customId === 'form_submission') {
                // 表单提交处理
                await processFormSubmission(interaction);
            } else if (interaction.customId === 'review_submission') { 
                // 审核提交处理
                await processReviewSubmission(interaction);
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
            } else if (interaction.deferred) {
                await interaction.editReply({
                    content: '处理您的请求时出现错误。'
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