// src/services/courtService.js
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { saveCourtApplication, getNextCourtId } = require('../utils/database');
const { getCourtApplicationDeadline } = require('../config/timeconfig');


async function processCourtApplication(interaction, applicationData, courtSettings) {
    try {
        // 获取申请频道
        const applicationChannel = await interaction.client.channels.fetch(courtSettings.applicationChannelId);
        
        if (!applicationChannel) {
            throw new Error('找不到申请频道');
        }

        // 获取申请者和目标用户信息
        const applicant = interaction.user;
        const targetUser = await interaction.client.users.fetch(applicationData.targetUserId);
        
        // 获取下一个法庭ID
        const courtId = getNextCourtId();
        
        // 计算截止日期（2天后）
        const deadlineDate = getCourtApplicationDeadline();
        const deadlineTimestamp = Math.floor(deadlineDate.getTime() / 1000);
        
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
        
        // 创建嵌入消息
        const embed = new EmbedBuilder()
            .setTitle(`对 ${targetUser.displayName} 的处罚申请`)
            .setDescription(`**申请人：** ${applicant}\n**处罚对象：** ${targetUser}\n**截止时间：** <t:${deadlineTimestamp}:f>\n\n**处罚类型**\n${punishmentDescription}\n\n**处罚理由**\n${applicationData.reason}`)
            .setColor('#FF6B6B') // 红色调
            .setFooter({ 
                text: `匿名投票 | 法庭申请ID ${courtId}`,
                iconURL: interaction.guild.iconURL()
            })
            .setTimestamp();

        // 添加附加图片
        if (applicationData.attachment) {
            embed.setImage(applicationData.attachment.url);
        }
        
        // 发送消息到申请频道
        const message = await applicationChannel.send({
            embeds: [embed],
            components: []
        });

        // 创建支持按钮（匿名投票，不显示人数）
        const buttonRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`court_support_${message.id}`)
                    .setLabel('支持申请')
                    .setStyle(ButtonStyle.Primary)
            );

        // 编辑消息添加按钮
        await message.edit({
            embeds: [embed],
            components: [buttonRow]
        });
        
        // 保存到数据库
        const courtApplicationData = {
            messageId: message.id,
            channelId: applicationChannel.id,
            courtId: courtId,
            applicantId: applicant.id,
            targetUserId: applicationData.targetUserId,
            punishmentType: applicationData.punishmentType,
            timeoutDays: applicationData.timeoutDays,
            warningDays: applicationData.warningDays,
            reason: applicationData.reason,
            attachment: applicationData.attachment,
            requiredSupports: courtSettings.requiredSupports,
            currentSupports: 0,
            supporters: [],
            forumChannelId: courtSettings.forumChannelId,
            deadline: deadlineDate.toISOString(),
            status: 'pending',
            guildId: applicationData.guildId,
            timestamp: applicationData.timestamp
        };

        await saveCourtApplication(courtApplicationData);

        console.log(`成功创建法庭申请消息 ID: ${message.id}, 法庭ID: ${courtId}, 截止日期: ${deadlineDate.toISOString()}`);
        
    } catch (error) {
        console.error('处理法庭申请时出错:', error);
        throw error;
    }
}

module.exports = {
    processCourtApplication
};