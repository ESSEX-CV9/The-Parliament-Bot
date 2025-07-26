// src/modules/proposal/services/proposalEditService.js
const { MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { 
    getProposalApplication,
    updateProposalApplication 
} = require('../utils/proposalDatabase');
const { 
    checkProposalEditPermission,
    getEditPermissionDeniedMessage 
} = require('../utils/proposalPermissions');
const { createProposalEditModal } = require('../components/proposalEditModal');
const { 
    ensureProposalStatusTags,
    updateProposalThreadStatusTag,
    getTagStatusFromProposalStatus 
} = require('../utils/forumTagManager');

async function processEditProposal(interaction) {
    try {
        // 从按钮ID中提取议案ID
        const proposalId = interaction.customId.replace('proposal_edit_', '');
        const applicationData = await getProposalApplication(proposalId);
        
        if (!applicationData) {
            return interaction.reply({
                content: '❌ 找不到对应的议案记录。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 检查权限：只有议案作者可以编辑
        if (!checkProposalEditPermission(interaction.user.id, applicationData)) {
            return interaction.reply({
                content: getEditPermissionDeniedMessage(),
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 检查状态：只有待审核或要求修改的议案可以编辑
        if (!['pending', 'modification_required'].includes(applicationData.status)) {
            return interaction.reply({
                content: '❌ 当前议案状态不允许编辑。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        const modal = createProposalEditModal(applicationData);
        
        // 直接显示模态窗口，不要先 defer
        await interaction.showModal(modal);
        
    } catch (error) {
        console.error('处理编辑议案时出错:', error);
        
        // 如果还没有回复过，则回复错误信息
        if (!interaction.replied && !interaction.deferred) {
            try {
                await interaction.reply({
                    content: `❌ 处理编辑请求时出现错误：${error.message}`,
                    flags: MessageFlags.Ephemeral
                });
            } catch (replyError) {
                console.error('回复错误信息失败:', replyError);
            }
        }
    }
}

async function processEditProposalSubmission(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });
        
        // 从模态窗口ID中提取议案ID
        const proposalId = interaction.customId.replace('proposal_edit_submission_', '');
        const applicationData = await getProposalApplication(proposalId);
        
        if (!applicationData) {
            return interaction.editReply({
                content: '❌ 找不到对应的议案记录。'
            });
        }
        
        // 检查权限：只有议案作者可以编辑
        if (!checkProposalEditPermission(interaction.user.id, applicationData)) {
            return interaction.editReply({
                content: getEditPermissionDeniedMessage()
            });
        }
        
        // 检查状态：只有待审核或要求修改的议案可以编辑
        if (!['pending', 'modification_required'].includes(applicationData.status)) {
            return interaction.editReply({
                content: '❌ 当前议案状态不允许编辑。'
            });
        }
        
        // 获取修改后的表单数据
        const updatedFormData = {
            title: interaction.fields.getTextInputValue('title'),
            reason: interaction.fields.getTextInputValue('reason'),
            motion: interaction.fields.getTextInputValue('motion'),
            implementation: interaction.fields.getTextInputValue('implementation'),
            executor: interaction.fields.getTextInputValue('executor')
        };
        
        // 更新数据库中的议案数据
        const newStatus = applicationData.status === 'modification_required' ? 'pending_recheck' : 'pending';
        
        await updateProposalApplication(proposalId, {
            formData: updatedFormData,
            status: newStatus,
            updatedAt: new Date().toISOString()
        });
        
        // 更新审核帖子内容
        await updateReviewThreadAfterEdit(interaction.client, proposalId, updatedFormData, newStatus);
        
        // 回复用户
        const statusMessage = newStatus === 'pending_recheck' ? 
            '议案已更新，等待管理员再次审核。' : 
            '议案已更新，等待管理员审核。';
            
        await interaction.editReply({
            content: `✅ **议案编辑成功！**\n\n📋 **议案ID：** \`${proposalId}\`\n\n${statusMessage}`
        });
        
        console.log(`议案编辑完成 - ID: ${proposalId}, 新状态: ${newStatus}, 用户: ${interaction.user.tag}`);
        
    } catch (error) {
        console.error('处理编辑议案提交时出错:', error);
        
        try {
            await interaction.editReply({
                content: `❌ 处理编辑提交时出现错误：${error.message}`
            });
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

async function updateReviewThreadAfterEdit(client, proposalId, updatedFormData, newStatus) {
    try {
        const applicationData = await getProposalApplication(proposalId);
        if (!applicationData || !applicationData.threadId) {
            return;
        }
        
        const thread = await client.channels.fetch(applicationData.threadId);
        const firstMessage = await thread.fetchStarterMessage();
        
        if (!firstMessage) {
            return;
        }
        
        // 确保论坛标签
        const tagMap = await ensureProposalStatusTags(thread.parent);
        
        // 构建更新的内容
        const statusText = newStatus === 'pending_recheck' ? '等待再次审核' : '等待审核';
        const updatedContent = `👤 **提案人：** <@${applicationData.authorId}>
📅 **提交时间：** <t:${Math.floor(new Date(applicationData.createdAt).getTime() / 1000)}:f>
📅 **最后编辑：** <t:${Math.floor(Date.now() / 1000)}:f>
🆔 **议案ID：** \`${proposalId}\`

---

🏷️ **议案标题**
${updatedFormData.title}

📝 **提案原因**
${updatedFormData.reason}

📋 **议案动议**
${updatedFormData.motion}

🔧 **执行方案**
${updatedFormData.implementation}

👨‍💼 **议案执行人**
${updatedFormData.executor}

---

⏳ **状态：** ${statusText}

管理员可使用 \`/审核议案 ${proposalId}\` 进行审核。`;
        
        // 创建编辑按钮
        const editButton = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`proposal_edit_${proposalId}`)
                    .setLabel('✏️ 编辑议案')
                    .setStyle(ButtonStyle.Secondary)
            );
        
        await firstMessage.edit({
            content: updatedContent,
            components: [editButton]
        });
        
        // 更新标签状态
        const tagStatus = getTagStatusFromProposalStatus(newStatus);
        await updateProposalThreadStatusTag(thread, tagStatus, tagMap);
        
        // 更新标题（如果需要再次审核）
        if (newStatus === 'pending_recheck') {
            await thread.setName(`【待再审】${updatedFormData.title}`);
        } else {
            await thread.setName(`【待审核】${updatedFormData.title}`);
        }
        
        // 发送编辑记录消息
        await thread.send({
            content: `📝 **议案已更新**\n\n<@${applicationData.authorId}> 已编辑议案内容。\n更新时间：<t:${Math.floor(Date.now() / 1000)}:f>\n\n${newStatus === 'pending_recheck' ? '由于之前要求修改，议案将进入再次审核流程。' : '议案已重新提交，等待管理员审核。'}`
        });
        
        console.log(`审核帖子已更新 - 议案ID: ${proposalId}, 新状态: ${newStatus}`);
        
    } catch (error) {
        console.error('更新审核帖子时出错:', error);
        // 不抛出错误，避免影响主流程
    }
}

module.exports = {
    processEditProposal,
    processEditProposalSubmission
}; 