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
        
        // 验证链接，传递contestChannelId参数
        const validationResult = await validateSubmissionLink(
            interaction.client,
            submissionLink,
            interaction.user.id,
            interaction.guild.id,
            contestChannelId
        );
        
        if (!validationResult.success) {
            return interaction.editReply({
                content: `❌ ${validationResult.error}`
            });
        }
        
        // 如果是外部服务器投稿，显示警告
        if (validationResult.isExternal) {
            await interaction.editReply({
                content: '⚠️ **外部服务器投稿警告**\n\n您提交的是外部服务器的链接。机器人无法验证外部服务器的内容，请确保：\n• 链接内容真实有效\n• 作品确实为您本人创作\n• 如有问题您将承担相应责任\n\n正在保存投稿信息...'
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
        
        // 生成比赛内的独立投稿ID
        const contestSubmissionId = getNextSubmissionId(contestChannelId);
        
        const submissionData = {
            contestSubmissionId: contestSubmissionId, // 比赛内的独立ID
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
            isValid: true,
            isExternal: validationResult.isExternal || false
        };
        
        const savedSubmission = await saveContestSubmission(submissionData);
        
        // 更新赛事频道的投稿列表（使用全局ID）
        const updatedSubmissions = [...contestChannelData.submissions, savedSubmission.globalId];
        await updateContestChannel(contestChannelId, {
            submissions: updatedSubmissions,
            totalSubmissions: updatedSubmissions.length
        });
        
        // 更新作品展示
        await updateSubmissionDisplay(interaction.client, contestChannelData);
        
        const externalWarning = validationResult.isExternal ? '\n\n⚠️ **注意：** 这是外部服务器投稿，机器人无法验证内容。' : '';
        
        await interaction.editReply({
            content: `✅ **投稿成功！**\n\n🎨 **作品：** ${validationResult.preview.title}\n📝 **投稿ID：** \`${contestSubmissionId}\`\n\n您的作品已添加到展示列表中。${externalWarning}`
        });
        
        console.log(`投稿成功 - 比赛内ID: ${contestSubmissionId}, 全局ID: ${savedSubmission.globalId}, 用户: ${interaction.user.tag}, 频道: ${contestChannelId}, 外部: ${validationResult.isExternal}`);
        
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
            .sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt)); // 按时间正序，先投稿的在前
        
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