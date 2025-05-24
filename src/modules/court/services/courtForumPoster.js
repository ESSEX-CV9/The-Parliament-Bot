// src\modules\court\services\courtForumPoster.js
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { saveCourtVote } = require('../../../core/utils/database');
const { getCourtVoteEndTime, getCourtVotePublicTime } = require('../../../core/config/timeconfig');

async function createCourtForum(client, applicationData) {
    try {
        // 获取论坛频道
        const forumChannel = await client.channels.fetch(applicationData.forumChannelId);
        
        if (!forumChannel || forumChannel.type !== 15) { // 15 = GUILD_FORUM
            console.error('无效的论坛频道');
            throw new Error('无效的论坛频道');
        }
        
        // 获取申请者和目标用户信息
        const applicant = await client.users.fetch(applicationData.applicantId).catch(() => null);
        const targetUser = await client.users.fetch(applicationData.targetUserId).catch(() => null);
        
        const applicantMention = applicant ? `<@${applicant.id}>` : "未知用户";
        const targetMention = targetUser ? `<@${targetUser.id}>` : "未知用户";
        
        // 构建处罚描述
        let punishmentDescription = '';
        if (applicationData.punishmentType === 'timeout') {
            punishmentDescription = `禁言 ${applicationData.timeoutDays} 天`;
            if (applicationData.warningDays) {
                punishmentDescription += ` + 被警告 ${applicationData.warningDays} 天`;
            }
        } else {
            punishmentDescription = '封禁';
        }
        
        // 获取当前时间戳（Discord格式）
        const currentTimestamp = Math.floor(Date.now() / 1000);
        
        // 构建辩诉帖内容
        let postContent = `***申请人: ${applicantMention}***
***被处罚者: ${targetMention}***

> ## 处罚类型
${punishmentDescription}

> ## 处罚理由
${applicationData.reason}`;

        // 如果有附加图片，添加到内容中
        if (applicationData.attachment) {
            postContent += `\n\n> ## 附加证据\n[查看图片](${applicationData.attachment.url})`;
        }

        postContent += `\n\n*辩诉帖创建时间: <t:${currentTimestamp}:f>*

**📋 辩诉规则：**
- 24小时内，双方当事人可以在此帖各自发言5条
- 如有当事人发言超过5条并恶意刷楼，可举报要求处理
- 投票器将在下方自动创建，24小时后结束投票
- 12小时后开始公开票数进度`;
        
        // 创建论坛帖子
        const thread = await forumChannel.threads.create({
            name: `对 ${targetUser ? targetUser.displayName : '未知用户'} 的处罚申请 - ${applicationData.courtId}`,
            message: {
                content: postContent,
            },
            appliedTags: []
        });
        
        console.log(`成功创建法庭论坛帖子: ${thread.id}`);
        
        // 创建投票器消息（第二楼）
        const voteResult = await createVotingSystem(thread, applicationData, targetUser);
        
        // 返回帖子信息
        return {
            threadId: thread.id,
            url: `https://discord.com/channels/${forumChannel.guild.id}/${thread.id}`,
            thread: thread,
            voteMessageId: voteResult.voteMessageId
        };
        
    } catch (error) {
        console.error('创建法庭论坛帖子时出错:', error);
        throw error;
    }
}

async function createVotingSystem(thread, applicationData, targetUser) {
    try {
        // 计算投票截止时间（24小时后）
        const voteEndTime = getCourtVoteEndTime(); 
        const voteEndTimestamp = Math.floor(voteEndTime.getTime() / 1000);
        
        // 计算公开时间（12小时后）
        const publicTime = getCourtVotePublicTime();
        
        // 构建处罚描述
        let punishmentDescription = '';
        if (applicationData.punishmentType === 'timeout') {
            punishmentDescription = `禁言 ${applicationData.timeoutDays} 天`;
            if (applicationData.warningDays) {
                punishmentDescription += ` + 被警告 ${applicationData.warningDays} 天`;
            }
        } else {
            punishmentDescription = '封禁';
        }
        
        // 创建投票器嵌入
        const voteEmbed = new EmbedBuilder()
            .setTitle('议会辩诉投票')
            .setDescription(`**投票截止时间:** <t:${voteEndTimestamp}:f>\n\n` +
                           `**辩诉主题:**\n对 ${targetUser ? `<@${targetUser.id}>` : '未知用户'} 执行 ${punishmentDescription}\n\n` +
                           `**投票结果** *(12小时后公开)*\n` +
                           `支持处罚: 🔒 票 (🔒%)\n` +
                           `反对处罚: 🔒 票 (🔒%)\n\n` +
                           `总投票人数: 🔒\n\n` +
                           `**投票结果:**\n` +
                           `支持率 >= 50% 获得多数，执行惩罚`)
            .setColor('#FFD700') // 金色
            .setFooter({ 
                text: `法庭申请ID ${applicationData.courtId} | 匿名投票`,
                iconURL: thread.guild.iconURL()
            })
            .setTimestamp();
        
        // 创建投票按钮
        const voteButtons = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`court_vote_support_${thread.id}`)
                    .setLabel('支持处罚')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(`court_vote_oppose_${thread.id}`)
                    .setLabel('反对处罚')
                    .setStyle(ButtonStyle.Secondary)
            );
        
        // 发送投票消息
        const voteMessage = await thread.send({
            embeds: [voteEmbed],
            components: [voteButtons]
        });
        
        // 保存投票数据到数据库
        const voteData = {
            threadId: thread.id,
            voteMessageId: voteMessage.id,
            courtApplicationId: applicationData.messageId,
            courtId: applicationData.courtId,
            applicantId: applicationData.applicantId,
            targetUserId: applicationData.targetUserId,
            punishmentType: applicationData.punishmentType,
            timeoutDays: applicationData.timeoutDays,
            warningDays: applicationData.warningDays,
            supportVotes: 0,
            opposeVotes: 0,
            supportVoters: [],
            opposeVoters: [],
            voteEndTime: voteEndTime.toISOString(),
            publicTime: publicTime.toISOString(),
            isPublic: false,
            status: 'active',
            guildId: applicationData.guildId,
            createdAt: new Date().toISOString()
        };
        
        await saveCourtVote(voteData);
        
        console.log(`成功创建投票器: 消息ID ${voteMessage.id}, 帖子ID ${thread.id}`);
        
        return {
            voteMessageId: voteMessage.id,
            voteData: voteData
        };
        
    } catch (error) {
        console.error('创建投票系统时出错:', error);
        throw error;
    }
}

module.exports = {
    createCourtForum,
    createVotingSystem
};