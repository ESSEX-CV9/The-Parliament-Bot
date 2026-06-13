const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const {
    getContestChannel,
    updateContestChannel,
    deleteContestSubmission,
    getContestSubmissionByGlobalId
} = require('../utils/contestDatabase');
const { onSubmissionRemoved } = require('./tournamentSyncService');

/**
 * 处理删除确认
 */
async function processDeleteConfirmation(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });
        
        const parts = interaction.customId.split('_');
        const submissionId = parts[2];
        const contestChannelId = parts[3];
        
        // 快速删除，使用默认原因
        await deleteSubmissionWithReason(interaction, submissionId, contestChannelId, '主办人删除了您的投稿');
        
    } catch (error) {
        console.error('处理删除确认时出错:', error);
        
        try {
            await interaction.editReply({
                content: `❌ 删除投稿时出现错误：${error.message}`
            });
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

/**
 * 发送拒稿通知
 */
async function sendRejectionNotification(client, submission, reason) {
    try {
        const user = await client.users.fetch(submission.submitterId);
        if (!user) {
            console.log(`无法找到用户 ${submission.submitterId}`);
            return;
        }
        
        // 获取比赛信息
        const contestChannelData = await getContestChannel(submission.contestChannelId);
        const contestTitle = contestChannelData?.contestTitle || '未知比赛';
        const contestChannelLink = `<#${submission.contestChannelId}>`;
        
        // 构建作品链接 - 使用频道链接格式，不包含消息ID
        const workUrl = `https://discord.com/channels/${submission.parsedInfo.guildId}/${submission.parsedInfo.channelId}`;
        
        // 根据拒稿理由调整消息内容
        let title = '📝 投稿拒稿退回通知';
        let description = `您在 **${contestTitle}** 中的投稿作品已被主办人拒稿退回。`;
        let reasonText = reason || '无具体说明';
        
        if (reason === '主办人拒稿退回了您的投稿') {
            reasonText = '主办人进行了直接拒稿操作，未提供具体理由';
            description = `您在 **${contestTitle}** 中的投稿作品已被主办人拒稿退回。`;
        }
        
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
            .addFields(
                { name: '🏆 比赛频道', value: contestChannelLink, inline: false },
                { name: '🎨 投稿作品链接', value: workUrl, inline: false },
                { name: '🆔 投稿ID', value: `\`${submission.contestSubmissionId}\``, inline: true },
                { name: '📅 投稿时间', value: `<t:${Math.floor(new Date(submission.submittedAt).getTime() / 1000)}:f>`, inline: true },
                { name: '📝 拒稿理由', value: reasonText, inline: false }
            )
            .setColor('#FF6B6B')
            .setFooter({ 
                text: '如有疑问，请联系比赛主办人 | 您的原作品不会受到任何影响' 
            })
            .setTimestamp();
        
        await user.send({ embeds: [embed] });
        
        console.log(`拒稿通知已发送 - 用户: ${user.tag}, 投稿ID: ${submission.contestSubmissionId}, 比赛: ${contestTitle}, 理由: ${reason}`);
        
    } catch (error) {
        console.error('发送拒稿通知时出错:', error);
        
        // 如果是权限错误（用户关闭了私聊），记录特殊日志
        if (error.code === 50007) {
            console.log(`用户 ${submission.submitterId} 已关闭私聊，无法发送拒稿通知`);
        }
        
        // 不抛出错误，避免影响主流程
    }
}

/**
 * 处理拒稿模态窗口提交
 */
async function processRejectionModal(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });
        
        const parts = interaction.customId.split('_');
        const submissionId = parts[2];
        const contestChannelId = parts[3];
        
        const rejectionReason = interaction.fields.getTextInputValue('rejection_reason').trim() || '主办人拒稿退回了您的投稿';
        
        await deleteSubmissionWithReason(interaction, submissionId, contestChannelId, rejectionReason);
        
        // 删除成功后，清除用户选择
        const { displayService } = require('./displayService');
        displayService.clearUserSelection(interaction.user.id, contestChannelId);
        
    } catch (error) {
        console.error('处理拒稿模态框时出错:', error);
        
        try {
            await interaction.editReply({
                content: `❌ 处理拒稿说明时出现错误：${error.message}`
            });
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

/**
 * 删除投稿并发送通知
 */
async function deleteSubmissionWithReason(interaction, globalId, contestChannelId, reason) {
    try {
        // 通过全局ID获取投稿
        const submission = await getContestSubmissionByGlobalId(globalId);
        
        if (!submission) {
            return interaction.editReply({
                content: '❌ 未找到指定的投稿。'
            });
        }
        
        // 始终发送拒稿通知
        await sendRejectionNotification(interaction.client, submission, reason);
        
        // 删除投稿数据
        await deleteContestSubmission(globalId);
        onSubmissionRemoved(submission); // 静默从索引页书单移除
        
        // 更新赛事频道的投稿列表
        const contestChannelData = await getContestChannel(contestChannelId);
        const updatedSubmissions = contestChannelData.submissions.filter(id => id != globalId);
        await updateContestChannel(contestChannelId, {
            submissions: updatedSubmissions,
            totalSubmissions: updatedSubmissions.length
        });
        
        // 更新作品展示
        const { updateSubmissionDisplay } = require('./submissionService');
        await updateSubmissionDisplay(interaction.client, {
            ...contestChannelData,
            submissions: updatedSubmissions
        });
        
        await interaction.editReply({
            content: `✅ **投稿已拒稿退回**\n\n🆔 **投稿ID：** \`${submission.contestSubmissionId}\`\n📝 **退回理由：** ${reason}\n📨 **通知状态：** 已向投稿者发送退回通知\n\n💡 **提示：** 请点击界面上的 🔄 刷新按钮来查看最新的投稿列表。`
        });
        
        console.log(`投稿已拒稿退回 - 比赛内ID: ${submission.contestSubmissionId}, 全局ID: ${globalId}, 主办人: ${interaction.user.tag}, 理由: ${reason}`);
        
    } catch (error) {
        console.error('拒稿退回投稿时出错:', error);
        
        try {
            await interaction.editReply({
                content: `❌ 拒稿退回时出现错误：${error.message}`
            });
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

module.exports = {
    processDeleteConfirmation,
    processRejectionModal,
    deleteSubmissionWithReason
}; 