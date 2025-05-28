// src/modules/contest/services/reviewService.js
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { 
    getContestApplication,
    updateContestApplication 
} = require('../utils/contestDatabase');

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
        
        // 更新审核帖子
        await interaction.editReply({
            content: '⏳ 正在更新审核帖子...'
        });
        
        await updateReviewThreadStatus(interaction.client, applicationData, reviewData);
        
        // 根据审核结果给出不同回复
        const resultMessages = {
            'approved': `✅ 申请ID \`${applicationId}\` 已审核通过！申请人现在可以确认建立赛事频道了。`,
            'rejected': `❌ 申请ID \`${applicationId}\` 已被拒绝。${reason ? `\n**拒绝原因：** ${reason}` : ''}`,
            'modification_required': `⚠️ 申请ID \`${applicationId}\` 需要修改。${reason ? `\n**修改要求：** ${reason}` : ''}\n申请人可以继续编辑申请内容。`
        };
        
        await interaction.editReply({
            content: resultMessages[reviewResult] || '✅ 审核完成。'
        });
        
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
        const firstMessage = messages.last();
        
        if (!firstMessage) {
            throw new Error('找不到要更新的消息');
        }
        
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
        
        // 更新帖子标题
        const statusPrefixes = {
            'approved': '【已通过】',
            'rejected': '【已拒绝】',
            'modification_required': '【需修改】'
        };
        
        await thread.setName(`${statusPrefixes[reviewData.result]}${formData.title}`);
        
        console.log(`审核帖子状态已更新 - 帖子: ${thread.id}, 状态: ${reviewData.result}`);
        
    } catch (error) {
        console.error('更新审核帖子状态时出错:', error);
        throw error;
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
        
        // 更新审核帖子状态
        await updateCancelledThreadStatus(interaction.client, applicationData);
        
        await interaction.editReply({
            content: `✅ 申请ID \`${applicationId}\` 已撤销办理。`
        });
        
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
        const firstMessage = messages.last();
        
        if (!firstMessage) {
            return;
        }
        
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
        
        // 更新帖子标题
        await thread.setName(`【已撤销】${applicationData.formData.title}`);
        
    } catch (error) {
        console.error('更新撤销状态时出错:', error);
    }
}

module.exports = {
    processApplicationReview,
    processCancelApplication
};