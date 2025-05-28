// src/modules/contest/services/submissionService.js
const { EmbedBuilder } = require('discord.js');
const { 
    getContestChannel,
    updateContestChannel,
    getNextSubmissionId,
    saveContestSubmission,
    getSubmissionsByChannel 
} = require('../utils/contestDatabase');
const { validateSubmissionLink, checkDuplicateSubmission } = require('./linkParser');

async function processContestSubmission(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });
        
        // 从模态窗口customId中提取频道ID
        const contestChannelId = interaction.customId.replace('contest_submission_', '');
        
        console.log(`处理投稿 - 频道: ${contestChannelId}, 用户: ${interaction.user.tag}`);
        console.log(`模态窗口customId: ${interaction.customId}`);
        
        // 验证是否为有效的赛事频道
        const contestChannelData = await getContestChannel(contestChannelId);
        console.log(`查询到的赛事频道数据:`, contestChannelData);
        
        if (!contestChannelData) {
            console.log(`未找到赛事频道数据 - 频道ID: ${contestChannelId}`);
            return interaction.editReply({
                content: '❌ 无效的赛事频道。'
            });
        }
        
        // 获取提交的链接和稿件说明
        const submissionLink = interaction.fields.getTextInputValue('submission_link').trim();
        const submissionDescription = interaction.fields.getTextInputValue('submission_description')?.trim() || '';
        
        await interaction.editReply({
            content: '⏳ 正在验证投稿链接...'
        });
        
        // 验证链接
        const validationResult = await validateSubmissionLink(
            interaction.client,
            submissionLink,
            interaction.user.id,
            interaction.guild.id
        );
        
        if (!validationResult.success) {
            return interaction.editReply({
                content: `❌ ${validationResult.error}`
            });
        }
        
        // 检查是否重复投稿
        const duplicateCheck = await checkDuplicateSubmission(
            contestChannelId,
            validationResult.parsedInfo.messageId,
            interaction.user.id
        );
        
        if (duplicateCheck.isDuplicate) {
            return interaction.editReply({
                content: `❌ ${duplicateCheck.error}`
            });
        }
        
        await interaction.editReply({
            content: '⏳ 正在保存投稿信息...'
        });
        
        // 保存投稿数据
        const submissionId = getNextSubmissionId();
        const submissionData = {
            id: submissionId,
            contestChannelId: contestChannelId,
            submitterId: interaction.user.id,
            originalUrl: submissionLink,
            linkType: validationResult.parsedInfo.linkType,
            parsedInfo: {
                guildId: validationResult.parsedInfo.guildId,
                channelId: validationResult.parsedInfo.channelId,
                messageId: validationResult.parsedInfo.messageId
            },
            cachedPreview: validationResult.preview,
            submissionDescription: submissionDescription,
            submittedAt: new Date().toISOString(),
            isValid: true
        };
        
        await saveContestSubmission(submissionData);
        
        // 更新赛事频道的投稿列表
        const updatedSubmissions = [...contestChannelData.submissions, submissionId];
        await updateContestChannel(contestChannelId, {
            submissions: updatedSubmissions,
            totalSubmissions: updatedSubmissions.length
        });
        
        // 更新作品展示
        await updateSubmissionDisplay(interaction.client, contestChannelData);
        
        await interaction.editReply({
            content: `✅ **投稿成功！**\n\n🎨 **作品：** ${validationResult.preview.title}\n📝 **投稿ID：** \`${submissionId}\`\n\n您的作品已添加到展示列表中。`
        });
        
        console.log(`投稿成功 - ID: ${submissionId}, 用户: ${interaction.user.tag}, 频道: ${contestChannelId}`);
        
    } catch (error) {
        console.error('处理投稿时出错:', error);
        
        try {
            await interaction.editReply({
                content: `❌ 处理投稿时出现错误：${error.message}\n请稍后重试。`
            });
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

async function updateSubmissionDisplay(client, contestChannelData) {
    try {
        const contestChannel = await client.channels.fetch(contestChannelData.channelId);
        const displayMessage = await contestChannel.messages.fetch(contestChannelData.displayMessage);
        
        if (!displayMessage) {
            console.error(`找不到展示消息: ${contestChannelData.displayMessage}`);
            return;
        }
        
        // 获取所有有效投稿
        const submissions = await getSubmissionsByChannel(contestChannelData.channelId);
        const validSubmissions = submissions.filter(sub => sub.isValid)
            .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt)); // 按时间倒序
        
        const totalSubmissions = validSubmissions.length;
        const itemsPerPage = contestChannelData.itemsPerPage || 6;
        const totalPages = Math.max(1, Math.ceil(totalSubmissions / itemsPerPage));
        const currentPage = Math.min(contestChannelData.currentPage || 1, totalPages);
        
        // 更新当前页码
        if (contestChannelData.currentPage !== currentPage) {
            await updateContestChannel(contestChannelData.channelId, {
                currentPage: currentPage
            });
        }
        
        const { displayService } = require('./displayService');
        await displayService.updateDisplayMessage(
            displayMessage,
            validSubmissions,
            currentPage,
            itemsPerPage,
            contestChannelData.channelId
        );
        
        console.log(`作品展示已更新 - 频道: ${contestChannelData.channelId}, 作品数: ${totalSubmissions}`);
        
    } catch (error) {
        console.error('更新作品展示时出错:', error);
    }
}

module.exports = {
    processContestSubmission,
    updateSubmissionDisplay
};