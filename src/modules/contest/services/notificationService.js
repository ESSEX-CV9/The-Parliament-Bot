const { EmbedBuilder } = require('discord.js');

/**
 * 发送审核结果私聊通知
 */
async function sendReviewNotification(client, applicationData, reviewData) {
    try {
        const user = await client.users.fetch(applicationData.applicantId);
        if (!user) {
            console.log(`无法找到用户 ${applicationData.applicantId}`);
            return;
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

        // 构建审核帖子链接
        const threadUrl = `https://discord.com/channels/${applicationData.guildId}/${applicationData.threadId}`;

        const embed = new EmbedBuilder()
            .setTitle(`${statusEmojis[reviewData.result]} 赛事申请${statusTexts[reviewData.result]}`)
            .setColor(reviewData.result === 'approved' ? '#00FF00' : 
                     reviewData.result === 'rejected' ? '#FF0000' : '#FFA500')
            .addFields(
                { name: '📋 审核帖子', value: `[点击查看审核详情](${threadUrl})`, inline: false },
                { name: '🆔 申请ID', value: `\`${applicationData.id}\``, inline: true },
                { name: '👨‍💼 审核员', value: `<@${reviewData.reviewerId}>`, inline: true },
                { name: '📅 审核时间', value: `<t:${Math.floor(new Date(reviewData.reviewedAt).getTime() / 1000)}:f>`, inline: true }
            )
            .setTimestamp();

        if (reviewData.reason) {
            embed.addFields({ name: '💬 审核意见', value: reviewData.reason, inline: false });
        }

        // 根据审核结果添加不同的说明
        if (reviewData.result === 'approved') {
            embed.setDescription('🎉 恭喜！您的赛事申请已通过审核。\n\n请前往审核帖子点击 **"✅ 确认建立频道"** 按钮来创建赛事频道。');
        } else if (reviewData.result === 'rejected') {
            embed.setDescription('😔 很抱歉，您的赛事申请未通过审核。\n\n如有疑问，请联系管理员或重新提交申请。');
        } else if (reviewData.result === 'modification_required') {
            embed.setDescription('📝 您的赛事申请需要修改。\n\n请前往审核帖子点击 **"✏️ 编辑申请"** 按钮进行修改。');
        }

        await user.send({ embeds: [embed] });
        console.log(`审核通知已发送给用户 ${user.tag} (${user.id})`);

    } catch (error) {
        console.error('发送审核通知时出错:', error);
        // 不抛出错误，避免影响主流程
    }
}

/**
 * 发送频道创建成功通知
 */
async function sendChannelCreatedNotification(client, applicationData, contestChannel) {
    try {
        const user = await client.users.fetch(applicationData.applicantId);
        if (!user) {
            console.log(`无法找到用户 ${applicationData.applicantId}`);
            return;
        }

        // 构建审核帖子链接
        const threadUrl = `https://discord.com/channels/${applicationData.guildId}/${applicationData.threadId}`;

        const embed = new EmbedBuilder()
            .setTitle('🎉 赛事频道创建成功！')
            .setDescription('您的赛事频道已成功创建，现在可以开始管理比赛了！')
            .setColor('#00FF00')
            .addFields(
                { name: '📋 审核帖子', value: `[点击查看审核详情](${threadUrl})`, inline: false },
                { name: '📍 频道位置', value: `${contestChannel}`, inline: true },
                { name: '🔗 直达链接', value: `[点击前往](${contestChannel.url})`, inline: true },
                { name: '🆔 申请ID', value: `\`${applicationData.id}\``, inline: true }
            )
            .addFields({
                name: '📋 接下来您可以：',
                value: '• 使用 `/更新赛事信息` 修改赛事详情\n• 使用 `/更新赛事标题` 修改频道名称\n• 查看参赛者的投稿作品\n• 管理赛事进程',
                inline: false
            })
            .setTimestamp();

        await user.send({ embeds: [embed] });
        console.log(`频道创建通知已发送给用户 ${user.tag} (${user.id})`);

    } catch (error) {
        console.error('发送频道创建通知时出错:', error);
        // 不抛出错误，避免影响主流程
    }
}

module.exports = {
    sendReviewNotification,
    sendChannelCreatedNotification
}; 