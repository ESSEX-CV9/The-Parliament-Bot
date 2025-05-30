// src/modules/contest/services/reviewService.js
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { 
    getContestApplication,
    updateContestApplication 
} = require('../utils/contestDatabase');
const { sendReviewNotification } = require('./notificationService');
const { ensureContestStatusTags, updateThreadStatusTag, getTagStatusFromApplicationStatus } = require('../utils/forumTagManager');

async function processApplicationReview(interaction, applicationId, reviewResult, reason = '') {
    try {
        await interaction.deferReply({ ephemeral: true });
        
        console.log(`处理申请审核 - ID: ${applicationId}, 结果: ${reviewResult}, 审核员: ${interaction.user.tag}`);
        
        const applicationData = await getContestApplication(applicationId);
        if (!applicationData) {
            return interaction.editReply({
                content: `❌ 找不到申请ID为 \`${applicationId}\` 的申请。`
            });
        }
        
        // 检查申请状态
        if (applicationData.status === 'approved' && reviewResult === 'approved') {
            return interaction.editReply({
                content: `❌ 申请ID \`${applicationId}\` 已经审核通过了。`
            });
        }
        
        if (applicationData.status === 'rejected' && reviewResult === 'rejected') {
            return interaction.editReply({
                content: `❌ 申请ID \`${applicationId}\` 已经被拒绝了。`
            });
        }
        
        // 更新申请状态
        const reviewData = {
            reviewerId: interaction.user.id,
            result: reviewResult,
            reason: reason,
            reviewedAt: new Date().toISOString()
        };
        
        await updateContestApplication(applicationId, {
            status: reviewResult,
            reviewData: reviewData,
            updatedAt: new Date().toISOString()
        });
        
        // 准备结果消息
        const resultMessages = {
            'approved': `✅ 申请ID \`${applicationId}\` 已审核通过！申请人现在可以确认建立赛事频道了。`,
            'rejected': `❌ 申请ID \`${applicationId}\` 已被拒绝。${reason ? `\n**拒绝原因：** ${reason}` : ''}`,
            'modification_required': `⚠️ 申请ID \`${applicationId}\` 需要修改。${reason ? `\n**修改要求：** ${reason}` : ''}\n申请人可以继续编辑申请内容。`
        };
        
        // 更新审核帖子
        await interaction.editReply({
            content: '⏳ 正在更新审核帖子...'
        });
        
        try {
            await updateReviewThreadStatus(interaction.client, applicationData, reviewData);
            
            // 发送私聊通知
            await sendReviewNotification(interaction.client, applicationData, reviewData);
            
            // 更新成功，显示最终结果
            await interaction.editReply({
                content: resultMessages[reviewResult] || '✅ 审核完成。'
            });
            
        } catch (threadUpdateError) {
            console.error('更新审核帖子时出错:', threadUpdateError);
            
            // 即使帖子更新失败，也要告知用户审核已完成
            await interaction.editReply({
                content: `${resultMessages[reviewResult] || '✅ 审核完成。'}\n\n⚠️ 注意：审核帖子更新可能失败，但审核结果已保存。`
            });
        }
        
        console.log(`申请审核完成 - ID: ${applicationId}, 结果: ${reviewResult}`);
        
    } catch (error) {
        console.error('处理申请审核时出错:', error);
        
        try {
            await interaction.editReply({
                content: `❌ 处理审核时出现错误：${error.message}`
            });
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

async function updateReviewThreadStatus(client, applicationData, reviewData) {
    try {
        const thread = await client.channels.fetch(applicationData.threadId);
        const messages = await thread.messages.fetch({ limit: 10 });
        const firstMessage = messages.first();
        
        if (!firstMessage) {
            throw new Error('找不到要更新的消息');
        }
        
        // 确保论坛标签
        const tagMap = await ensureContestStatusTags(thread.parent);
        
        const statusEmojis = {
            'approved': '✅',
            'rejected': '❌',
            'modification_required': '⚠️'
        };
        
        const statusTexts = {
            'approved': '审核通过',
            'rejected': '审核拒绝',
            'modification_required': '需要修改'
        };
        
        // 构建更新的内容
        const formData = applicationData.formData;
        const updatedContent = `👤 **申请人：** <@${applicationData.applicantId}>
📅 **申请时间：** <t:${Math.floor(new Date(applicationData.createdAt).getTime() / 1000)}:f>
🆔 **申请ID：** \`${applicationData.id}\`
👨‍💼 **审核员：** <@${reviewData.reviewerId}>
📅 **审核时间：** <t:${Math.floor(new Date(reviewData.reviewedAt).getTime() / 1000)}:f>

---

🏆 **比赛标题**
${formData.title}

📝 **主题和参赛要求**
${formData.theme}

⏰ **比赛持续时间**
${formData.duration}

🎖️ **奖项设置和评价标准**
${formData.awards}

${formData.notes ? `📋 **注意事项和其他补充**\n${formData.notes}\n\n` : ''}---

${statusEmojis[reviewData.result]} **状态：** ${statusTexts[reviewData.result]}

${reviewData.reason ? `💬 **审核意见：** ${reviewData.reason}\n\n` : ''}`;
        
        // 根据审核结果显示不同按钮
        let components = [];
        
        if (reviewData.result === 'approved') {
            // 审核通过：显示确认建立和撤销按钮
            components = [
                new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`contest_confirm_${applicationData.id}`)
                            .setLabel('✅ 确认建立频道')
                            .setStyle(ButtonStyle.Success),
                        new ButtonBuilder()
                            .setCustomId(`contest_cancel_${applicationData.id}`)
                            .setLabel('❌ 撤销办理')
                            .setStyle(ButtonStyle.Danger)
                    )
            ];
        } else if (reviewData.result === 'modification_required') {
            // 需要修改：保留编辑按钮
            components = [
                new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`contest_edit_${applicationData.id}`)
                            .setLabel('✏️ 编辑申请')
                            .setStyle(ButtonStyle.Secondary)
                    )
            ];
        }
        // rejected状态不显示任何按钮
        
        await firstMessage.edit({
            content: updatedContent,
            components: components
        });
        
        // 更新标签状态
        const tagStatus = getTagStatusFromApplicationStatus(reviewData.result);
        await updateThreadStatusTag(thread, tagStatus, tagMap);
        
        // 只有最终结果才更新标题
        if (reviewData.result === 'approved') {
            await thread.setName(`【已通过】${formData.title}`);
        } else if (reviewData.result === 'rejected') {
            await thread.setName(`【未通过】${formData.title}`);
        }
        // modification_required 保持【待审核】标题，依靠标签显示状态
        
        // 发送审核记录消息（所有审核结果都发送）
        await postReviewHistoryMessage(thread, reviewData, applicationData.applicantId);
        
        console.log(`审核帖子状态已更新 - 帖子: ${thread.id}, 状态: ${reviewData.result}`);
        
    } catch (error) {
        console.error('更新审核帖子状态时出错:', error);
        
        // 检查是否是频道不存在的错误
        if (error.code === 10003) {
            console.warn(`⚠️ 审核帖子不存在或已被删除 - 帖子ID: ${applicationData.threadId}, 申请ID: ${applicationData.id}`);
            console.warn('审核结果已保存到数据库，但无法更新帖子状态');
            return; // 不抛出错误，让审核流程继续
        }
        
        // 其他错误仍然抛出
        throw error;
    }
}

/**
 * 发送审核历史消息
 */
async function postReviewHistoryMessage(thread, reviewData, applicantId) {
    try {
        // 根据审核结果设置不同的emoji和文本
        const resultConfig = {
            'approved': {
                emoji: '✅',
                text: '审核通过',
                color: '🟢',
                followUp: '💡 申请人现在可以点击上方的 **"✅ 确认建立频道"** 按钮来创建赛事频道。'
            },
            'rejected': {
                emoji: '❌',
                text: '审核拒绝',
                color: '🔴',
                followUp: '📝 如有疑问，申请人可以联系审核员了解详细情况。'
            },
            'modification_required': {
                emoji: '⚠️',
                text: '需要修改',
                color: '🟡',
                followUp: '💡 申请人可以点击上方的 **"✏️ 编辑申请"** 按钮进行修改。修改后将进入再次审核流程。'
            }
        };
        
        const config = resultConfig[reviewData.result] || resultConfig['modification_required'];
        
        const historyMessage = `<@${applicantId}> 您的赛事申请已被审核！
## 📋 审核记录       
👨‍💼 **审核员：** <@${reviewData.reviewerId}>
📅 **审核时间：** <t:${Math.floor(new Date(reviewData.reviewedAt).getTime() / 1000)}:f>
${config.emoji} **审核结果：** ${config.text}

💬 **审核意见：**
${reviewData.reason || '无具体意见'}
---
${config.followUp}`;

        await thread.send({
            content: historyMessage
        });
        
        console.log(`审核记录消息已发送 - 帖子: ${thread.id}, 结果: ${reviewData.result}`);
        
    } catch (error) {
        console.error('发送审核记录消息时出错:', error);
        // 不抛出错误，避免影响主流程
    }
}

async function processCancelApplication(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });
        
        // 从按钮ID提取申请ID
        const applicationId = interaction.customId.replace('contest_cancel_', '');
        const applicationData = await getContestApplication(applicationId);
        
        if (!applicationData) {
            return interaction.editReply({
                content: '❌ 找不到对应的申请记录。'
            });
        }
        
        // 检查权限：只有申请人可以撤销
        if (applicationData.applicantId !== interaction.user.id) {
            return interaction.editReply({
                content: '❌ 只有申请人可以撤销办理。'
            });
        }
        
        // 检查状态：只有已通过的申请可以撤销
        if (applicationData.status !== 'approved') {
            return interaction.editReply({
                content: '❌ 只有已通过的申请可以撤销办理。'
            });
        }
        
        // 更新申请状态
        await updateContestApplication(applicationId, {
            status: 'cancelled',
            updatedAt: new Date().toISOString()
        });
        
        // 尝试更新审核帖子状态
        try {
            await updateCancelledThreadStatus(interaction.client, applicationData);
            
            await interaction.editReply({
                content: `✅ 申请ID \`${applicationId}\` 已撤销办理。`
            });
        } catch (threadUpdateError) {
            console.error('更新撤销帖子时出错:', threadUpdateError);
            
            // 即使帖子更新失败，也要告知用户撤销已完成
            await interaction.editReply({
                content: `✅ 申请ID \`${applicationId}\` 已撤销办理。\n\n⚠️ 注意：审核帖子更新可能失败，但撤销状态已保存。`
            });
        }
        
        console.log(`申请已撤销 - ID: ${applicationId}, 用户: ${interaction.user.tag}`);
        
    } catch (error) {
        console.error('撤销申请时出错:', error);
        
        try {
            await interaction.editReply({
                content: `❌ 撤销申请时出现错误：${error.message}`
            });
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

async function updateCancelledThreadStatus(client, applicationData) {
    try {
        const thread = await client.channels.fetch(applicationData.threadId);
        const messages = await thread.messages.fetch({ limit: 10 });
        const firstMessage = messages.first();
        
        if (!firstMessage) {
            return;
        }
        
        // 确保论坛标签
        const tagMap = await ensureContestStatusTags(thread.parent);
        
        // 移除所有按钮
        const components = [
            new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`contest_cancelled_${applicationData.id}`)
                        .setLabel('❌ 已撤销')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true)
                )
        ];
        
        await firstMessage.edit({
            components: components
        });
        
        // 更新标签状态
        await updateThreadStatusTag(thread, 'CANCELLED', tagMap);
        
        // 不再更新标题 - 保持当前标题不变
        
    } catch (error) {
        console.error('更新撤销状态时出错:', error);
        
        // 检查是否是频道不存在的错误
        if (error.code === 10003) {
            console.warn(`⚠️ 审核帖子不存在或已被删除 - 帖子ID: ${applicationData.threadId}, 申请ID: ${applicationData.id}`);
            console.warn('撤销状态已保存到数据库，但无法更新帖子状态');
            return; // 不抛出错误
        }
        
        // 其他错误记录但不抛出，避免影响主流程
        console.warn('更新撤销状态失败，但不影响主流程');
    }
}

module.exports = {
    processApplicationReview,
    processCancelApplication
};