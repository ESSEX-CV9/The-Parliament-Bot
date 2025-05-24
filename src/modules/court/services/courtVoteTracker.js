// src/services/courtVoteTracker.js
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getCourtApplication, updateCourtApplication } = require('../../../core/utils/database');
const { createCourtForum } = require('./courtForumPoster');

async function processCourtSupport(interaction) {
    try {
        // 立即回复延迟消息，防止交互超时
        await interaction.deferReply({ ephemeral: true });
        
        // 从按钮ID中提取消息ID
        const messageId = interaction.customId.replace('court_support_', '');
        console.log(`处理法庭支持投票: 按钮ID=${interaction.customId}, 提取的消息ID=${messageId}`);
        
        // 从数据库获取申请数据
        const applicationData = await getCourtApplication(messageId);
        console.log(`查询法庭申请数据: ID=${messageId}, 结果=`, applicationData);
        
        if (!applicationData) {
            console.error(`在数据库中找不到法庭申请ID: ${messageId}`);
            return interaction.editReply({ 
                content: '在数据库中找不到此申请。这可能是因为机器人重启或数据丢失。'
            });
        }
        
        // 如果申请已经发布到论坛或被撤回，不允许再更改投票
        if (applicationData.status === 'posted') {
            return interaction.editReply({ 
                content: '此申请已经发布到论坛，不能再更改支持状态。'
            });
        }
        
        if (applicationData.status === 'withdrawn') {
            return interaction.editReply({ 
                content: '此申请已被撤回，不能再更改支持状态。'
            });
        }

        if (applicationData.status === 'expired') {
            return interaction.editReply({ 
                content: '此申请已过期，不能再更改支持状态。'
            });
        }
        
        // 检查用户是否已经投票
        const userIndex = applicationData.supporters.indexOf(interaction.user.id);
        let replyContent = '';
        
        if (userIndex !== -1) {
            // 用户已投票，撤销投票
            applicationData.currentSupports -= 1;
            applicationData.supporters.splice(userIndex, 1);
            replyContent = '您已撤销对此申请的支持！';
        } else {
            // 用户未投票，添加投票
            applicationData.currentSupports += 1;
            applicationData.supporters.push(interaction.user.id);
            replyContent = '您的支持已记录！';
        }
        
        // 更新按钮 - 匿名投票，不显示具体人数
        const updatedButton = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`court_support_${messageId}`)
                    .setLabel('支持申请')
                    .setStyle(ButtonStyle.Primary)
            );
        
        await interaction.message.edit({
            components: [updatedButton]
        });
        
        // 更新数据库
        await updateCourtApplication(messageId, {
            currentSupports: applicationData.currentSupports,
            supporters: applicationData.supporters
        });
        
        // 检查是否达到所需支持数
        if (applicationData.currentSupports >= applicationData.requiredSupports) {
            try {
                // 通知用户正在处理
                await interaction.editReply({
                    content: '您的支持已记录！申请正在发布到论坛...'
                });
                
                // 创建论坛帖子和投票器
                const forumResult = await createCourtForum(interaction.client, applicationData);
                
                // 获取申请者和目标用户
                const applicant = await interaction.client.users.fetch(applicationData.applicantId);
                const targetUser = await interaction.client.users.fetch(applicationData.targetUserId);
                
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
                
                // 创建通过后的嵌入消息
                const passedEmbed = new EmbedBuilder()
                    .setTitle(`对 ${targetUser.displayName} 的处罚申请`)
                    .setDescription(`**申请人：** ${applicant}\n**处罚对象：** ${targetUser}\n\n**处罚类型**\n${punishmentDescription}\n\n**处罚理由**\n${applicationData.reason}\n\n✅ **此申请已经满足所需支持数，已创建辩诉帖** ${forumResult.url}`)
                    .setColor('#00FF00') // 绿色表示通过
                    .setFooter({ 
                        text: `法庭申请ID ${applicationData.courtId} | 已发布到论坛`,
                        iconURL: interaction.guild.iconURL()
                    })
                    .setTimestamp();

                // 添加附加图片
                if (applicationData.attachment) {
                    passedEmbed.setImage(applicationData.attachment.url);
                }
                
                // 更新消息，表示已发布到论坛
                const disabledButton = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`court_complete_${messageId}`)
                            .setLabel(`已发布到论坛 ✅`)
                            .setStyle(ButtonStyle.Success)
                            .setDisabled(true)
                    );
                
                await interaction.message.edit({
                    embeds: [passedEmbed],
                    components: [disabledButton]
                });
                
                // 更新数据库中的状态，包括论坛帖子信息
                await updateCourtApplication(messageId, {
                    status: 'posted',
                    forumThreadUrl: forumResult.url,
                    forumThreadId: forumResult.threadId,
                    voteMessageId: forumResult.voteMessageId
                });
                
                // 更新回复
                replyContent = '您的支持已记录！申请已成功发布到论坛，辩诉程序正式开始。';
            } catch (error) {
                console.error('发布到论坛时出错:', error);
                replyContent = '您的支持已记录，但发布到论坛时出现错误。请联系管理员。';
                
                // 如果创建论坛帖子失败，恢复按钮状态
                const errorButton = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`court_support_${messageId}`)
                            .setLabel(`支持申请 - 发布失败`)
                            .setStyle(ButtonStyle.Danger)
                    );
                
                await interaction.message.edit({
                    components: [errorButton]
                });
            }
        }
        
        // 最终更新回复
        await interaction.editReply({ 
            content: replyContent
        });
    } catch (error) {
        console.error('处理法庭支持投票时出错:', error);
        
        // 尝试优雅地处理错误
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ 
                    content: '处理您的请求时出现错误。', 
                    ephemeral: true 
                });
            } else {
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
    processCourtSupport
};