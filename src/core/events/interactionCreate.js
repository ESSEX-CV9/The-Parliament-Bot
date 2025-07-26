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
const { handleSelfRoleButton, handleSelfRoleSelect } = require('../../modules/selfRole/services/selfRoleService');
const { processApprovalVote } = require('../../modules/selfRole/services/approvalService');
const {
    handleAddRoleButton,
    handleRemoveRoleButton,
    handleListRolesButton,
    handleRoleSelectForAdd,
    handleModalSubmit,
    handleRoleSelectForRemove,
    handleRoleListPageChange
} = require('../../modules/selfRole/services/adminPanelService');

// 投票系统相关处理
const { createVoteSetupModal, handleVoteSetupSubmit } = require('../../modules/voting/components/voteSetupModal');
const { handleVoteButton } = require('../../modules/voting/components/voteButtons');
const { handleNotificationButton } = require('../../modules/voting/components/notificationButtons');

// 选举系统相关处理
const { 
    handleRegistrationButton,
    handleFirstChoiceSelection,
    handleSecondChoiceSelection,
    handleIntroductionModal,
    handleEditRegistration,
    handleWithdrawRegistration
} = require('../../modules/election/components/registrationComponents');

// 管理员编辑候选人相关处理
const {
    handleAdminStatusChange,
    handleReasonModal,
    handleAdminEditInfo
} = require('../../modules/election/components/adminEditComponents');

// 赛事系统相关处理
const { createContestApplicationModal } = require('../../modules/contest/components/applicationModal');
const { createSubmissionModal } = require('../../modules/contest/components/submissionModal');
const { createConfirmChannelModal } = require('../../modules/contest/components/confirmChannelModal');
const { 
    processContestApplication,
    processEditApplication,
    processEditApplicationSubmission,
    processChannelConfirmation
} = require('../../modules/contest/services/applicationService');
const { processContestSubmission } = require('../../modules/contest/services/submissionService');
const { processCancelApplication } = require('../../modules/contest/services/reviewService');
const { displayService } = require('../../modules/contest/services/displayService');
const { getContestApplication, getContestSettings } = require('../../modules/contest/utils/contestDatabase');
const { checkContestApplicationPermission, getApplicationPermissionDeniedMessage } = require('../../modules/contest/utils/contestPermissions');
const { processSubmissionManagement, processSubmissionAction, processDeleteConfirmation, processRejectionModal } = require('../../modules/contest/services/submissionManagementService');
const { createRejectionModal } = require('../../modules/contest/components/rejectionModal');

// 议案编辑相关处理
const { processEditProposal, processEditProposalSubmission } = require('../../modules/proposal/services/proposalEditService');

const { checkFormPermission, getFormPermissionDeniedMessage } = require('../../core/utils/permissionManager');
const { getFormPermissionSettings } = require('../../core/utils/database');

const { 
    handleAnonymousVoteStart,
    handleAnonymousVoteSelect,
    handleAnonymousVoteConfirm,
    handleAnonymousVoteCancel,
    handleVotingPagination,
    handleVoteComplete
} = require('../../modules/election/components/anonymousVotingComponents');

async function interactionCreateHandler(interaction) {
    try {
        // 处理自动补全
        if (interaction.isAutocomplete()) {
            const command = interaction.client.commands.get(interaction.commandName);
            if (!command) return;

            try {
                await command.autocomplete(interaction);
            } catch (error) {
                console.error('自动补全时出错:', error);
            }
            return;
        }

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
            // === 投票系统按钮处理 ===
            else if (interaction.customId === 'vote_setup') {
                // 投票设置按钮
                const modal = createVoteSetupModal();
                await interaction.showModal(modal);
            } else if (interaction.customId.startsWith('vote_') && !interaction.customId.startsWith('vote_setup')) {
                // 处理投票按钮
                await handleVoteButton(interaction);
            }
            // === 通知身份组系统按钮处理 ===
            else if (interaction.customId === 'notification_roles_entry') {
                // 通知身份组入口按钮
                await handleNotificationButton(interaction);
            }
            // === 选举系统按钮处理 ===
            else if (interaction.customId.startsWith('election_register_')) {
                // 选举报名按钮
                await handleRegistrationButton(interaction);
            } else if (interaction.customId.startsWith('election_edit_registration_')) {
                // 编辑报名按钮
                await handleEditRegistration(interaction);
            } else if (interaction.customId.startsWith('election_withdraw_registration_')) {
                // 撤回报名按钮
                await handleWithdrawRegistration(interaction);
            } else if (interaction.customId.startsWith('election_start_anonymous_vote_')) {
                // 开始匿名投票按钮
                await handleAnonymousVoteStart(interaction);
            } else if (interaction.customId.startsWith('election_anonymous_vote_select_')) {
                // 匿名投票选择菜单
                await handleAnonymousVoteSelect(interaction);
            } else if (interaction.customId.startsWith('election_anonymous_vote_confirm_')) {
                // 确认匿名投票按钮
                await handleAnonymousVoteConfirm(interaction);
            } else if (interaction.customId.startsWith('election_anonymous_vote_cancel_')) {
                // 取消匿名投票按钮
                await handleAnonymousVoteCancel(interaction);
            } else if (interaction.customId.startsWith('election_vote_prev_') || 
                       interaction.customId.startsWith('election_vote_next_')) {
                // 投票分页按钮
                await handleVotingPagination(interaction);
            } else if (interaction.customId.startsWith('election_vote_complete_')) {
                // 完成选择按钮
                await handleVoteComplete(interaction);
            } else if (interaction.customId.startsWith('appeal_registration_')) {
                // 申诉报名按钮
                const { handleAppealRegistration } = require('../../modules/election/components/appealComponents');
                await handleAppealRegistration(interaction);
            } else if (interaction.customId.startsWith('withdraw_registration_')) {
                // 放弃参选按钮
                const { handleWithdrawRegistration } = require('../../modules/election/components/appealComponents');
                await handleWithdrawRegistration(interaction);
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
            } else if (interaction.customId.startsWith('proposal_edit_')) {
                // 编辑议案按钮
                await processEditProposal(interaction);
            } else if (interaction.customId.startsWith('contest_confirm_')) {
                // 确认建立频道按钮 - 显示选择界面
                const applicationId = interaction.customId.replace('contest_confirm_', '');
                const applicationData = await getContestApplication(applicationId);
                
                if (!applicationData) {
                    return interaction.reply({
                        content: '❌ 找不到对应的申请记录。',
                        flags: MessageFlags.Ephemeral
                    });
                }
                
                // 检查权限：只有申请人可以确认建立频道
                if (applicationData.applicantId !== interaction.user.id) {
                    return interaction.reply({
                        content: '❌ 只有申请人才能确认建立频道。',
                        flags: MessageFlags.Ephemeral
                    });
                }
                
                // 获取外部服务器列表
                const contestSettings = await getContestSettings(interaction.guild.id);
                const allowedExternalServers = contestSettings?.allowedExternalServers || [];
                
                const { createConfirmChannelSelection } = require('../../modules/contest/components/confirmChannelSelection');
                const { embed, components } = createConfirmChannelSelection(applicationData, allowedExternalServers);
                
                await interaction.reply({
                    embeds: [embed],
                    components: components,
                    ephemeral: true
                });
            } else if (interaction.customId.startsWith('proceed_channel_creation_')) {
                // 继续设置频道详情按钮
                const customIdParts = interaction.customId.replace('proceed_channel_creation_', '').split('_');
                const applicationId = customIdParts[0];
                const allowExternalServers = customIdParts[1] === 'true';
                
                const applicationData = await getContestApplication(applicationId);
                
                if (!applicationData) {
                    return interaction.reply({
                        content: '❌ 找不到对应的申请记录。',
                        flags: MessageFlags.Ephemeral
                    });
                }
                
                // 检查权限：只有申请人可以确认建立频道
                if (applicationData.applicantId !== interaction.user.id) {
                    return interaction.reply({
                        content: '❌ 只有申请人才能确认建立频道。',
                        flags: MessageFlags.Ephemeral
                    });
                }
                
                const modal = createConfirmChannelModal(applicationData, allowExternalServers);
                await interaction.showModal(modal);
            } else if (interaction.customId.startsWith('cancel_channel_creation_')) {
                // 取消建立频道
                await interaction.update({
                    content: '❌ 已取消建立频道。',
                    embeds: [],
                    components: []
                });
            } else if (interaction.customId.startsWith('contest_cancel_')) {
                // 撤销办理按钮
                await processCancelApplication(interaction);
            } else if (interaction.customId.startsWith('contest_submit_')) {
                // 投稿按钮
                const contestChannelId = interaction.customId.replace('contest_submit_', '');
                const modal = createSubmissionModal(contestChannelId);
                await interaction.showModal(modal);
            } else if (interaction.customId.startsWith('contest_manage_')) {
                // 稿件管理按钮
                await processSubmissionManagement(interaction);
            } else if (interaction.customId.startsWith('manage_prev_') || 
                       interaction.customId.startsWith('manage_next_')) {
                // 稿件管理翻页按钮
                const parts = interaction.customId.split('_');
                const action = parts[1]; // prev 或 next
                const contestChannelId = parts[2];
                const page = parseInt(parts[3]);
                
                // 重新获取投稿数据并显示指定页面
                const { getSubmissionsByChannel } = require('../../modules/contest/utils/contestDatabase');
                const submissions = await getSubmissionsByChannel(contestChannelId);
                const validSubmissions = submissions.filter(sub => sub.isValid)
                    .sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt));
                
                const { showSubmissionManagementPage } = require('../../modules/contest/services/submissionManagementService');
                await showSubmissionManagementPage(interaction, validSubmissions, page, contestChannelId);
            } else if (interaction.customId.startsWith('manage_close_')) {
                // 关闭稿件管理界面
                await interaction.update({
                    content: '✅ 稿件管理界面已关闭。',
                    embeds: [],
                    components: []
                });
            } else if (interaction.customId.startsWith('confirm_delete_')) {
                // 确认删除投稿
                await processDeleteConfirmation(interaction);
            } else if (interaction.customId.startsWith('quick_delete_')) {
                // 快速删除投稿
                await processDeleteConfirmation(interaction);
            } else if (interaction.customId.startsWith('show_rejection_modal_')) {
                // 显示拒稿说明模态窗口
                const parts = interaction.customId.split('_');
                const submissionId = parts[3];
                const contestChannelId = parts[4];
                
                const modal = createRejectionModal(submissionId, contestChannelId);
                await interaction.showModal(modal);
            } else if (interaction.customId.startsWith('c_all_')) {
                // 查看所有投稿作品按钮（新的短ID格式）
                await displayService.handleViewAllSubmissions(interaction);
            } else if (interaction.customId.startsWith('c_ipp5_') || 
                       interaction.customId.startsWith('c_ipp10_') || 
                       interaction.customId.startsWith('c_ipp20_')) {
                // 每页显示数量设置按钮（新的短ID格式）
                await displayService.handleItemsPerPageChange(interaction);
            } else if (interaction.customId.startsWith('c_ff_') || 
                       interaction.customId.startsWith('c_fp_') || 
                       interaction.customId.startsWith('c_fn_') || 
                       interaction.customId.startsWith('c_fl_') || 
                       interaction.customId.startsWith('c_fref_')) {
                // 完整作品列表翻页按钮（新的短ID格式）
                await displayService.handleFullPageNavigation(interaction);
            } else if (interaction.customId.startsWith('c_fpj_')) {
                // 页面跳转按钮（新的短ID格式）
                await displayService.handlePageJumpButton(interaction);
            } else if (interaction.customId.startsWith('c_ref_')) {
                // 刷新按钮（新的短ID格式）
                await displayService.handlePageNavigation(interaction);
            } else if (interaction.customId.startsWith('contest_view_all_')) {
                // 查看所有投稿作品按钮（旧格式）
                await displayService.handleViewAllSubmissions(interaction);
            } else if (interaction.customId.startsWith('contest_items_per_page_')) {
                // 每页显示数量设置按钮（旧格式）
                await displayService.handleItemsPerPageChange(interaction);
            } else if (interaction.customId.startsWith('contest_full_first_') || 
                       interaction.customId.startsWith('contest_full_prev_') || 
                       interaction.customId.startsWith('contest_full_next_') || 
                       interaction.customId.startsWith('contest_full_last_') || 
                       interaction.customId.startsWith('contest_full_refresh_')) {
                // 完整作品列表翻页按钮（旧格式）
                await displayService.handleFullPageNavigation(interaction);
            } else if (interaction.customId.startsWith('contest_full_page_jump_')) {
                // 页面跳转按钮（旧格式）
                await displayService.handlePageJumpButton(interaction);
            } else if (interaction.customId.startsWith('contest_prev_') || 
                       interaction.customId.startsWith('contest_next_') || 
                       interaction.customId.startsWith('contest_refresh_')) {
                // 作品展示翻页按钮（旧格式）
                await displayService.handlePageNavigation(interaction);
            }
            
            // 新增管理操作按钮处理
            if (interaction.customId.startsWith('manage_quick_delete_') ||
                interaction.customId.startsWith('manage_delete_with_reason_') ||
                interaction.customId.startsWith('manage_delete_page_')) {
                await displayService.handleManagementAction(interaction);
            }
            
            // 新增：获奖管理相关按钮
            if (interaction.customId.startsWith('award_set_')) {
                // 设置获奖作品按钮
                const contestChannelId = interaction.customId.replace('award_set_', '');
                await displayService.handleSetAward(interaction, contestChannelId);
            } else if (interaction.customId.startsWith('award_remove_')) {
                // 移除获奖作品按钮
                const contestChannelId = interaction.customId.replace('award_remove_', '');
                await displayService.handleRemoveAward(interaction, contestChannelId);
            } else if (interaction.customId.startsWith('contest_finish_')) {
                // 完赛按钮
                const contestChannelId = interaction.customId.replace('contest_finish_', '');
                await displayService.handleFinishContest(interaction, contestChannelId);
            } else if (interaction.customId.startsWith('c_td_')) {
                // 导出参赛作品链接
                const contestChannelId = interaction.customId.replace('c_td_', '');
                await displayService.handleDumpFullSubmissionsList(interaction, contestChannelId);
            } else if (interaction.customId.startsWith('finish_contest_close_')) {
                // 关闭完赛清单按钮
                await interaction.update({
                    content: '✅ 已关闭获奖清单预览。\n\n您可以继续管理比赛，或稍后重新查看完赛选项。',
                    embeds: [],
                    components: []
                });
            } else if (interaction.customId.startsWith('finish_contest_confirm_')) {
                // 确认完赛按钮（第一次确认，现在显示二次确认）
                const contestChannelId = interaction.customId.replace('finish_contest_confirm_', '');
                await displayService.handleFinishContestConfirm(interaction, contestChannelId);
            
            // 新增：最终确认相关按钮
            } else if (interaction.customId.startsWith('final_confirm_proceed_')) {
                // 最终确认完赛按钮（真正的完赛操作）
                const contestChannelId = interaction.customId.replace('final_confirm_proceed_', '');
                await displayService.handleFinalConfirmProceed(interaction, contestChannelId);
            } else if (interaction.customId.startsWith('final_confirm_cancel_')) {
                // 取消最终确认按钮
                const contestChannelId = interaction.customId.replace('final_confirm_cancel_', '');
                await displayService.handleFinalConfirmCancel(interaction, contestChannelId);
            } else if (interaction.customId === 'self_role_apply_button') {
                await handleSelfRoleButton(interaction);
            } else if (interaction.customId.startsWith('self_role_approve_') || interaction.customId.startsWith('self_role_reject_')) {
                await processApprovalVote(interaction);
            } else if (interaction.customId === 'admin_add_role_button') {
                await handleAddRoleButton(interaction);
            } else if (interaction.customId === 'admin_remove_role_button') {
                await handleRemoveRoleButton(interaction);
            } else if (interaction.customId === 'admin_list_roles_button') {
                await handleListRolesButton(interaction);
            } else if (interaction.customId.startsWith('admin_roles_page_')) {
                await handleRoleListPageChange(interaction);
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
            // === 投票系统模态窗口处理 ===
            else if (interaction.customId === 'vote_setup_modal') {
                // 投票设置模态窗口提交
                await handleVoteSetupSubmit(interaction);
            }
            // === 选举系统模态窗口处理 ===
            else if (interaction.customId.startsWith('election_introduction_modal_')) {
                // 选举自我介绍模态窗口提交
                await handleIntroductionModal(interaction);
            } else if (interaction.customId.startsWith('appeal_modal_')) {
                // 申诉报名模态窗口提交
                const { handleAppealModal } = require('../../modules/election/components/appealComponents');
                await handleAppealModal(interaction);
            } else if (interaction.customId.startsWith('admin_reason_')) {
                // 管理员原因输入模态窗口提交
                await handleReasonModal(interaction);
            } else if (interaction.customId.startsWith('admin_edit_info_')) {
                // 管理员编辑候选人信息模态窗口提交
                await handleAdminEditInfo(interaction);
            }
            // === 赛事系统模态窗口处理 ===
            else if (interaction.customId === 'contest_application') {
                // 赛事申请表单提交
                await processContestApplication(interaction);
            } else if (interaction.customId === 'contest_edit_application') {
                // 编辑申请表单提交
                await processEditApplicationSubmission(interaction);
            } else if (interaction.customId.startsWith('proposal_edit_submission_')) {
                // 编辑议案表单提交
                await processEditProposalSubmission(interaction);
            } else if (interaction.customId.startsWith('contest_confirm_channel_')) {
                // 确认建立频道表单提交
                await processChannelConfirmation(interaction);
            } else if (interaction.customId.startsWith('contest_submission_')) {
                // 投稿表单提交
                await processContestSubmission(interaction);
            } else if (interaction.customId.startsWith('rejection_reason_')) {
                // 拒稿说明模态窗口提交
                await processRejectionModal(interaction);
            } else if (interaction.customId.startsWith('contest_page_jump_')) {
                // 页面跳转模态窗口提交
                await displayService.handlePageJumpSubmission(interaction);
            }
            // 新增：获奖作品设置模态框
            if (interaction.customId.startsWith('award_modal_')) {
                await displayService.handleAwardModalSubmission(interaction);
            } else if (interaction.customId.startsWith('admin_add_role_modal_')) {
                await handleModalSubmit(interaction);
            }
            return;
        }
        
        // 处理选择菜单
        if (interaction.isStringSelectMenu()) {
            if (interaction.customId.startsWith('submission_action_')) {
                // 稿件管理操作选择
                await processSubmissionAction(interaction);
            } else if (interaction.customId === 'notification_roles_select') {
                await handleNotificationButton(interaction);
            } else if (interaction.customId.startsWith('election_select_first_choice_')) {
                // 选举第一志愿选择
                await handleFirstChoiceSelection(interaction);
            } else if (interaction.customId.startsWith('election_select_second_choice_')) {
                // 选举第二志愿选择
                await handleSecondChoiceSelection(interaction);
            } else if (interaction.customId.startsWith('election_anonymous_vote_select_')) {
                // 匿名投票候选人选择菜单
                await handleAnonymousVoteSelect(interaction);
            } else if (interaction.customId.startsWith('admin_status_change_')) {
                // 管理员状态变更选择菜单
                await handleAdminStatusChange(interaction);
            } else if (interaction.customId.startsWith('external_server_select_')) {
                // 外部服务器投稿选择
                const applicationId = interaction.customId.replace('external_server_select_', '');
                const allowExternalServers = interaction.values[0] === 'yes';
                
                // 更新按钮状态
                const updatedComponents = [...interaction.message.components];
                const buttonRow = updatedComponents[1];
                buttonRow.components[0].data.disabled = false; // 启用继续按钮
                
                // 存储选择到按钮的customId中（临时方案）
                buttonRow.components[0].data.custom_id = `proceed_channel_creation_${applicationId}_${allowExternalServers}`;
                
                const selectionText = allowExternalServers ? '是 - 允许外部服务器投稿' : '否 - 仅允许本服务器投稿';
                
                await interaction.update({
                    embeds: [{
                        ...interaction.message.embeds[0].data,
                        description: `**赛事名称：** ${interaction.message.embeds[0].data.description.split('\n')[0].replace('**赛事名称：** ', '')}\n\n✅ **外部服务器投稿：** ${selectionText}\n\n请点击下方按钮继续设置频道详情。`                    }],
                    components: updatedComponents
                });
            } else if (interaction.customId.startsWith('manage_select_submission_')) {
                // 投稿选择下拉菜单（在展示界面中的管理功能）
                await displayService.handleSubmissionSelect(interaction);
            } else if (interaction.customId === 'self_role_select_menu') {
                await handleSelfRoleSelect(interaction);
            } else if (interaction.customId === 'admin_add_role_select') {
                await handleRoleSelectForAdd(interaction);
            } else if (interaction.customId === 'admin_remove_role_select') {
                await handleRoleSelectForRemove(interaction);
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
