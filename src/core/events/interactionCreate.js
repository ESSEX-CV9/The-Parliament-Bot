// src/core/events/interactionCreate.js
const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const { createFormModal } = require('../../modules/proposal/components/formModal');
const { createReviewModal } = require('../../modules/creatorReview/components/reviewModal'); 
const { processFormSubmission } = require('../../modules/proposal/services/formService');
const { processReviewSubmission } = require('../../modules/creatorReview/services/reviewService'); 
const { processVote } = require('../../modules/proposal/services/voteTracker');
// 法庭相关处理
const { processCourtSupport } = require('../../modules/court/services/courtVoteTracker');
const { processCourtVote } = require('../../modules/court/services/courtVotingSystem');
// 自助管理相关处理
const { processSelfModerationInteraction } = require('../../modules/selfModeration/services/moderationService');

// 赛事系统相关处理
const { createContestApplicationModal } = require('../../modules/contest/components/applicationModal');
const { createSubmissionModal } = require('../../modules/contest/components/submissionModal');
const { createConfirmChannelModal } = require('../../modules/contest/components/confirmChannelModal');
const { processContestApplication, processEditApplication, processEditApplicationSubmission } = require('../../modules/contest/services/applicationService');
const { processCancelApplication } = require('../../modules/contest/services/reviewService');
const { processChannelConfirmation } = require('../../modules/contest/services/channelCreationService');
const { processContestSubmission } = require('../../modules/contest/services/submissionService');
const { displayService } = require('../../modules/contest/services/displayService');
const { getContestSettings, getContestApplication } = require('../../modules/contest/utils/contestDatabase');
const { checkContestApplicationPermission, getApplicationPermissionDeniedMessage } = require('../../modules/contest/utils/contestPermissions');

const { checkFormPermission, getFormPermissionDeniedMessage } = require('../../core/utils/permissionManager');
const { getFormPermissionSettings } = require('../../core/utils/database');

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
                // 检查表单使用权限
                const formPermissionSettings = await getFormPermissionSettings(interaction.guild.id);
                const hasFormPermission = checkFormPermission(interaction.member, formPermissionSettings);
                
                if (!hasFormPermission) {
                    // 获取身份组名称用于错误消息
                    let allowedRoleNames = [];
                    if (formPermissionSettings && formPermissionSettings.allowedRoles) {
                        for (const roleId of formPermissionSettings.allowedRoles) {
                            try {
                                const role = await interaction.guild.roles.fetch(roleId);
                                if (role) allowedRoleNames.push(role.name);
                            } catch (error) {
                                // 忽略错误，继续处理其他身份组
                            }
                        }
                    }
                    
                    return interaction.reply({
                        content: getFormPermissionDeniedMessage(allowedRoleNames),
                        flags: MessageFlags.Ephemeral
                    });
                }
                
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
            } else if (interaction.customId.startsWith('selfmod_')) {
                // 处理自助管理按钮
                await processSelfModerationInteraction(interaction);
            } 
            // === 赛事系统按钮处理 ===
            else if (interaction.customId === 'contest_application') {
                // 赛事申请按钮
                const contestSettings = await getContestSettings(interaction.guild.id);
                const hasPermission = checkContestApplicationPermission(interaction.member, contestSettings);
                
                if (!hasPermission) {
                    let allowedRoleNames = [];
                    if (contestSettings && contestSettings.applicationPermissionRoles) {
                        for (const roleId of contestSettings.applicationPermissionRoles) {
                            try {
                                const role = await interaction.guild.roles.fetch(roleId);
                                if (role) allowedRoleNames.push(role.name);
                            } catch (error) {
                                // 忽略错误
                            }
                        }
                    }
                    
                    return interaction.reply({
                        content: getApplicationPermissionDeniedMessage(allowedRoleNames),
                        flags: MessageFlags.Ephemeral
                    });
                }
                
                const modal = createContestApplicationModal();
                await interaction.showModal(modal);
            } else if (interaction.customId.startsWith('contest_edit_')) {
                // 编辑申请按钮
                await processEditApplication(interaction);
            } else if (interaction.customId.startsWith('contest_confirm_')) {
                // 确认建立频道按钮
                const applicationId = interaction.customId.replace('contest_confirm_', '');
                const applicationData = await getContestApplication(applicationId);
                
                if (!applicationData) {
                    return interaction.reply({
                        content: '❌ 找不到对应的申请记录。',
                        flags: MessageFlags.Ephemeral
                    });
                }
                
                const modal = createConfirmChannelModal(applicationData);
                await interaction.showModal(modal);
            } else if (interaction.customId.startsWith('contest_cancel_')) {
                // 撤销办理按钮
                await processCancelApplication(interaction);
            } else if (interaction.customId.startsWith('contest_submit_')) {
                // 投稿按钮
                const contestChannelId = interaction.customId.replace('contest_submit_', '');
                const modal = createSubmissionModal(contestChannelId);
                await interaction.showModal(modal);
            } else if (interaction.customId.startsWith('contest_prev_') || 
                       interaction.customId.startsWith('contest_next_') || 
                       interaction.customId.startsWith('contest_refresh_')) {
                // 作品展示翻页按钮
                await displayService.handlePageNavigation(interaction);
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
            } else if (interaction.customId.startsWith('selfmod_modal_')) {
                // 自助管理模态窗口提交处理
                await processSelfModerationInteraction(interaction);
            }
            // === 赛事系统模态窗口处理 ===
            else if (interaction.customId === 'contest_application') {
                // 赛事申请表单提交
                await processContestApplication(interaction);
            } else if (interaction.customId === 'contest_edit_application') {
                // 编辑申请表单提交
                await processEditApplicationSubmission(interaction);
            } else if (interaction.customId.startsWith('contest_confirm_channel_')) {
                // 确认建立频道表单提交
                await processChannelConfirmation(interaction);
            } else if (interaction.customId.startsWith('contest_submission_')) {
                // 投稿表单提交
                await processContestSubmission(interaction);
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