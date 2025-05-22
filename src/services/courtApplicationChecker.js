// src/services/courtApplicationChecker.js
const { getAllCourtApplications, updateCourtApplication } = require('../utils/database');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getCheckIntervals } = require('../config/timeconfig');

async function checkExpiredCourtApplications(client) {
    try {
        const checkStartTime = new Date();
        console.log(`\n=== 开始检查过期法庭申请 ===`);
        console.log(`检查时间: ${checkStartTime.toISOString()}`);
        
        const now = new Date();
        const applications = await getAllCourtApplications();
        
        let totalChecked = 0;
        let totalExpired = 0;
        
        for (const messageId in applications) {
            const application = applications[messageId];
            
            // 跳过已处理的申请
            if (application.status !== 'pending') continue;
            
            totalChecked++;
            
            const deadline = new Date(application.deadline);
            
            // 检查是否过期且未获得足够支持
            if (deadline < now && application.currentSupports < application.requiredSupports) {
                totalExpired++;
                
                console.log(`法庭申请ID ${application.courtId} 已过期且未获得足够支持 (${application.currentSupports}/${application.requiredSupports})`);
                
                try {
                    // 获取频道和消息
                    const channel = await client.channels.fetch(application.channelId);
                    const discordMessage = await channel.messages.fetch(messageId);
                    
                    // 获取申请者和目标用户
                    const applicant = await client.users.fetch(application.applicantId).catch(() => null);
                    const targetUser = await client.users.fetch(application.targetUserId).catch(() => null);
                    
                    // 构建处罚描述
                    let punishmentDescription = '';
                    if (application.punishmentType === 'timeout') {
                        punishmentDescription = `禁言 ${application.timeoutDays} 天`;
                        if (application.warningDays) {
                            punishmentDescription += ` + 被警告 ${application.warningDays} 天`;
                        }
                    } else {
                        punishmentDescription = '封禁';
                    }
                    
                    // 创建过期消息嵌入
                    const expiredEmbed = new EmbedBuilder()
                        .setTitle(`对 ${targetUser ? targetUser.displayName : '未知用户'} 的处罚申请`)
                        .setDescription(`**申请人：** ${applicant ? `<@${applicant.id}>` : '未知用户'}\n**处罚对象：** ${targetUser ? `<@${targetUser.id}>` : '未知用户'}\n\n**处罚类型**\n${punishmentDescription}\n\n**处罚理由**\n${application.reason}\n\n❌ **申请已过期** - 未能在截止前获得足够支持，申请无效`)
                        .setColor('#9B59B6') // 紫色
                        .setFooter({ 
                            text: `法庭申请ID ${application.courtId} | 已过期`,
                            iconURL: discordMessage.embeds[0].footer.iconURL
                        })
                        .setTimestamp();

                    // 添加附加图片
                    if (application.attachment) {
                        expiredEmbed.setImage(application.attachment.url);
                    }
                    
                    // 禁用的按钮
                    const disabledButton = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId(`court_expired_${messageId}`)
                                .setLabel(`申请已过期`)
                                .setStyle(ButtonStyle.Secondary)
                                .setDisabled(true)
                        );
                    
                    // 更新消息
                    await discordMessage.edit({
                        embeds: [expiredEmbed],
                        components: [disabledButton],
                        content: ''
                    });
                    
                    // 更新数据库状态
                    await updateCourtApplication(messageId, {
                        status: 'expired'
                    });
                    
                    console.log(`法庭申请ID ${application.courtId} 已标记为过期`);
                } catch (error) {
                    console.error(`更新过期法庭申请ID ${application.courtId} 时出错:`, error);
                }
            }
        }
        
        console.log(`总检查法庭申请数: ${totalChecked}`);
        console.log(`总过期法庭申请数: ${totalExpired}`);
        console.log(`=== 过期法庭申请检查完成 ===\n`);
        
    } catch (error) {
        console.error('检查过期法庭申请时出错:', error);
    }
}

// 启动法庭申请检查器
function startCourtApplicationChecker(client) {
    console.log('启动法庭申请检查器...');
    
    // 立即进行一次检查
    checkExpiredCourtApplications(client);
    
    // 设置定时检查（每30分钟检查一次）
    const intervals = getCheckIntervals();
    setInterval(() => {
        checkExpiredCourtApplications(client);
    }, intervals.courtApplicationCheck); 
}

module.exports = {
    startCourtApplicationChecker,
    checkExpiredCourtApplications
};