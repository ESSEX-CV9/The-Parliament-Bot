const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { 
    getContestChannel,
    getSubmissionsByChannel,
    updateContestSubmission,
    deleteContestSubmission,
    updateContestChannel,
    getContestSubmissionByGlobalId
} = require('../utils/contestDatabase');

/**
 * 处理稿件管理按钮点击
 */
async function processSubmissionManagement(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });
        
        // 从按钮ID中提取频道ID
        const contestChannelId = interaction.customId.replace('contest_manage_', '');
        
        console.log(`处理稿件管理 - 频道: ${contestChannelId}, 用户: ${interaction.user.tag}`);
        
        // 验证是否为有效的赛事频道
        const contestChannelData = await getContestChannel(contestChannelId);
        if (!contestChannelData) {
            return interaction.editReply({
                content: '❌ 无效的赛事频道。'
            });
        }
        
        // 检查权限：只有主办人可以管理稿件
        if (contestChannelData.applicantId !== interaction.user.id) {
            return interaction.editReply({
                content: '❌ 只有比赛主办人可以管理稿件。'
            });
        }
        
        // 获取所有有效投稿
        const submissions = await getSubmissionsByChannel(contestChannelId);
        const validSubmissions = submissions.filter(sub => sub.isValid)
            .sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt)); // 按时间正序，先投稿的在前
        
        if (validSubmissions.length === 0) {
            return interaction.editReply({
                content: '📝 当前没有任何投稿作品。'
            });
        }
        
        // 显示稿件管理界面
        await showSubmissionManagementPage(interaction, validSubmissions, 1, contestChannelId);
        
    } catch (error) {
        console.error('处理稿件管理时出错:', error);
        
        try {
            await interaction.editReply({
                content: `❌ 处理稿件管理时出现错误：${error.message}`
            });
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

/**
 * 显示稿件管理页面
 */
async function showSubmissionManagementPage(interaction, submissions, page, contestChannelId) {
    const itemsPerPage = 5; // 每页显示5个投稿
    const totalPages = Math.max(1, Math.ceil(submissions.length / itemsPerPage));
    const currentPage = Math.min(page, totalPages);
    
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, submissions.length);
    const pageSubmissions = submissions.slice(startIndex, endIndex);
    
    // 构建投稿列表embed
    const embed = new EmbedBuilder()
        .setTitle('🗂️ 稿件管理')
        .setDescription(`共 ${submissions.length} 个投稿作品`)
        .setColor('#FFA500')
        .setFooter({ text: `第 ${currentPage} 页 / 共 ${totalPages} 页` })
        .setTimestamp();
    
    let description = '';
    for (let i = 0; i < pageSubmissions.length; i++) {
        const submission = pageSubmissions[i];
        const preview = submission.cachedPreview;
        const submissionNumber = startIndex + i + 1;
        const submittedTime = Math.floor(new Date(submission.submittedAt).getTime() / 1000);
        
        // 构建作品链接
        const workUrl = `https://discord.com/channels/${submission.parsedInfo.guildId}/${submission.parsedInfo.channelId}/${submission.parsedInfo.messageId}`;
        
        description += `**${submissionNumber}.** ${workUrl}\n`;
        description += `👤 作者：<@${submission.submitterId}>\n`;
        description += `📅 投稿时间：<t:${submittedTime}:R>\n`;
        description += `🆔 投稿ID：\`${submission.contestSubmissionId}\`\n`;
        
        if (i < pageSubmissions.length - 1) {
            description += '\n---\n\n';
        }
    }
    
    embed.setDescription(description);
    
    // 构建操作按钮
    const components = [];
    
    // 删除投稿选择菜单
    if (pageSubmissions.length > 0) {
        const selectOptions = pageSubmissions.map(submission => {
            // 获取帖子标题的前20字
            const title = submission.cachedPreview.title || '无标题';
            const shortTitle = title.length > 20 ? `${title.substring(0, 20)}...` : title;
            
            return {
                label: shortTitle,
                description: `作者: ${submission.submitterId} | ID: ${submission.contestSubmissionId}`,
                value: `delete_${submission.globalId}`
            };
        });
        
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`submission_action_${contestChannelId}`)
            .setPlaceholder('选择要删除的投稿...')
            .addOptions(selectOptions);
        
        components.push(new ActionRowBuilder().addComponents(selectMenu));
    }
    
    // 翻页按钮
    if (totalPages > 1) {
        const navigationButtons = new ActionRowBuilder();
        
        if (currentPage > 1) {
            navigationButtons.addComponents(
                new ButtonBuilder()
                    .setCustomId(`manage_prev_${contestChannelId}_${currentPage - 1}`)
                    .setLabel('◀️ 上一页')
                    .setStyle(ButtonStyle.Secondary)
            );
        }
        
        if (currentPage < totalPages) {
            navigationButtons.addComponents(
                new ButtonBuilder()
                    .setCustomId(`manage_next_${contestChannelId}_${currentPage + 1}`)
                    .setLabel('下一页 ▶️')
                    .setStyle(ButtonStyle.Secondary)
            );
        }
        
        if (navigationButtons.components.length > 0) {
            components.push(navigationButtons);
        }
    }
    
    // 关闭按钮
    const closeButton = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`manage_close_${contestChannelId}`)
                .setLabel('❌ 关闭')
                .setStyle(ButtonStyle.Danger)
        );
    
    components.push(closeButton);
    
    await interaction.editReply({
        embeds: [embed],
        components: components
    });
}

/**
 * 处理投稿操作选择
 */
async function processSubmissionAction(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });
        
        const [action, globalId] = interaction.values[0].split('_');
        const contestChannelId = interaction.customId.replace('submission_action_', '');
        
        if (action === 'delete') {
            // 显示删除确认和拒稿说明输入
            await showDeleteConfirmation(interaction, globalId, contestChannelId);
        }
        
    } catch (error) {
        console.error('处理投稿操作时出错:', error);
        
        try {
            await interaction.editReply({
                content: `❌ 处理操作时出现错误：${error.message}`
            });
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

/**
 * 显示删除确认界面
 */
async function showDeleteConfirmation(interaction, globalId, contestChannelId) {
    // 通过全局ID获取投稿
    const submission = await getContestSubmissionByGlobalId(globalId);
    
    if (!submission) {
        return interaction.editReply({
            content: '❌ 未找到指定的投稿。'
        });
    }
    
    // 构建作品链接
    const workUrl = `https://discord.com/channels/${submission.parsedInfo.guildId}/${submission.parsedInfo.channelId}/${submission.parsedInfo.messageId}`;
    
    const embed = new EmbedBuilder()
        .setTitle('🗑️ 删除投稿确认')
        .setDescription(`**投稿ID：** \`${submission.contestSubmissionId}\`\n**作者：** <@${submission.submitterId}>\n**作品：** ${submission.cachedPreview.title || '无标题'}\n\n请选择删除方式：`)
        .setColor('#FF6B6B')
        .setTimestamp();
    
    const buttons = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`show_rejection_modal_${globalId}_${contestChannelId}`)
                .setLabel('📝 填写拒稿理由')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`quick_delete_${globalId}_${contestChannelId}`)
                .setLabel('🗑️ 直接删除')
                .setStyle(ButtonStyle.Danger)
        );
    
    await interaction.editReply({
        embeds: [embed],
        components: [buttons]
    });
}

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
        if (!user) return;
        
        // 构建作品链接
        const workUrl = `https://discord.com/channels/${submission.parsedInfo.guildId}/${submission.parsedInfo.channelId}/${submission.parsedInfo.messageId}`;
        
        const embed = new EmbedBuilder()
            .setTitle('📝 投稿被删除通知')
            .setDescription(`您的投稿作品已被主办人删除。`)
            .addFields(
                { name: '🔗 作品链接', value: workUrl, inline: false },
                { name: '📅 投稿时间', value: `<t:${Math.floor(new Date(submission.submittedAt).getTime() / 1000)}:f>`, inline: true },
                { name: '🗑️ 删除原因', value: reason || '无具体说明', inline: false }
            )
            .setColor('#FF6B6B')
            .setTimestamp();
        
        await user.send({ embeds: [embed] });
        
        console.log(`拒稿通知已发送 - 用户: ${user.tag}, 投稿ID: ${submission.contestSubmissionId}`);
        
    } catch (error) {
        console.error('发送拒稿通知时出错:', error);
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
        
        const rejectionReason = interaction.fields.getTextInputValue('rejection_reason').trim() || '主办人删除了您的投稿';
        
        await deleteSubmissionWithReason(interaction, submissionId, contestChannelId, rejectionReason);
        
    } catch (error) {
        console.error('处理拒稿模态窗口时出错:', error);
        
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
        
        // 发送拒稿通知
        if (reason !== '主办人删除了您的投稿') {
            await sendRejectionNotification(interaction.client, submission, reason);
        }
        
        // 删除投稿数据
        await deleteContestSubmission(globalId);
        
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
            content: `✅ **投稿已删除**\n\n🆔 **投稿ID：** \`${submission.contestSubmissionId}\`\n📝 **理由：** ${reason}`
        });
        
        console.log(`投稿已删除 - 比赛内ID: ${submission.contestSubmissionId}, 全局ID: ${globalId}, 主办人: ${interaction.user.tag}, 原因: ${reason}`);
        
    } catch (error) {
        console.error('删除投稿时出错:', error);
        
        try {
            await interaction.editReply({
                content: `❌ 删除投稿时出现错误：${error.message}`
            });
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

module.exports = {
    processSubmissionManagement,
    processSubmissionAction,
    processDeleteConfirmation,
    showSubmissionManagementPage,
    processRejectionModal,
    deleteSubmissionWithReason
}; 