// src/services/proposalChecker.js
const { getMessage, updateMessage, getAllMessages } = require('../utils/database');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

async function checkExpiredProposals(client) {
    try {
        console.log('开始检查过期提案...');
        const now = new Date();
        const messages = await getAllMessages();
        
        for (const messageId in messages) {
            const message = messages[messageId];
            
            // 跳过已处理的提案
            if (message.status !== 'pending') continue;
            
            const deadline = new Date(message.deadline);
            
            // 检查是否过期且未获得足够支持
            if (deadline < now && message.currentVotes < message.requiredVotes) {
                console.log(`提案ID ${message.shortId} 已过期且未获得足够支持`);
                
                try {
                    // 获取频道和消息
                    const channel = await client.channels.fetch(message.channelId);
                    const discordMessage = await channel.messages.fetch(messageId);
                    
                    // 创建过期消息嵌入
                    const expiredEmbed = new EmbedBuilder()
                        .setTitle(message.formData.title)
                        .setDescription(`提案人：<@${message.authorId}>\n\n当前提案未能在截止前获得足够支持，未能进入讨论阶段`)
                        .setColor('#9B59B6') // 紫色
                        .setFooter({ 
                            text: `提案ID · ${message.proposalId}`, // 过期消息不需要撤销支持的提示
                            iconURL: discordMessage.embeds[0].footer.iconURL
                        })
                        .setTimestamp();
                    
                    // 禁用的按钮
                    const disabledButton = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId(`expired_${messageId}`)
                                .setLabel(`未获得足够支持 (${message.currentVotes}/${message.requiredVotes})`)
                                .setStyle(ButtonStyle.Secondary)
                                .setDisabled(true)
                        );
                    
                    // 更新消息
                    await discordMessage.edit({
                        embeds: [expiredEmbed],
                        components: [disabledButton],
                        content: ''  // 移除撤销支持提示
                    });
                    
                    // 更新数据库状态
                    await updateMessage(messageId, {
                        status: 'expired'
                    });
                    
                    console.log(`提案ID ${message.shortId} 已标记为过期`);
                } catch (error) {
                    console.error(`更新过期提案ID ${message.shortId} 时出错:`, error);
                }
            }
        }
        
        console.log('过期提案检查完成');
    } catch (error) {
        console.error('检查过期提案时出错:', error);
    }
}

// 定时检查提案
function startProposalChecker(client) {
    console.log('启动提案检查器...');
    
    // 立即进行一次检查
    checkExpiredProposals(client);
    
    // 设置定时检查一次
    setInterval(() => {
        checkExpiredProposals(client);
    }, 20 * 60 * 1000); // 每20分钟检查一次
}

module.exports = {
    startProposalChecker,
    checkExpiredProposals
};