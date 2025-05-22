// src/services/proposalChecker.js
const { getMessage, updateMessage, getAllMessages, getAllCheckChannelSettings } = require('../utils/database');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

async function checkExpiredProposals(client) {
    try {
        const checkStartTime = new Date();
        console.log(`\n=== 开始检查过期提案 ===`);
        console.log(`检查时间: ${checkStartTime.toISOString()}`);
        
        const now = new Date();
        const messages = await getAllMessages();
        
        // 按服务器分组统计
        const guildStats = {};
        const expiredProposalsByGuild = {};
        
        let totalChecked = 0;
        let totalExpired = 0;
        
        for (const messageId in messages) {
            const message = messages[messageId];
            
            // 跳过已处理的提案
            if (message.status !== 'pending') continue;
            
            totalChecked++;
            
            // 获取服务器ID（从频道ID推断，或者从消息数据中获取）
            let guildId = null;
            try {
                const channel = await client.channels.fetch(message.channelId);
                guildId = channel.guild.id;
            } catch (error) {
                console.error(`无法获取频道 ${message.channelId} 的服务器信息:`, error);
                continue;
            }
            
            // 初始化服务器统计
            if (!guildStats[guildId]) {
                guildStats[guildId] = {
                    guildName: null,
                    totalChecked: 0,
                    expired: 0
                };
                expiredProposalsByGuild[guildId] = [];
            }
            
            guildStats[guildId].totalChecked++;
            
            // 获取服务器名称
            if (!guildStats[guildId].guildName) {
                try {
                    const guild = await client.guilds.fetch(guildId);
                    guildStats[guildId].guildName = guild.name;
                } catch (error) {
                    guildStats[guildId].guildName = `未知服务器 (${guildId})`;
                }
            }
            
            const deadline = new Date(message.deadline);
            
            // 检查是否过期且未获得足够支持
            if (deadline < now && message.currentVotes < message.requiredVotes) {
                totalExpired++;
                guildStats[guildId].expired++;
                
                // 收集过期提案信息
                const createdTimestamp = Math.floor(new Date(message.timestamp || Date.now()).getTime() / 1000);
                const deadlineTimestamp = Math.floor(deadline.getTime() / 1000);
                
                expiredProposalsByGuild[guildId].push({
                    title: message.formData.title,
                    proposalId: message.proposalId,
                    createdTimestamp,
                    deadlineTimestamp,
                    messageId
                });
                
                console.log(`提案ID ${message.proposalId} 已过期且未获得足够支持 (${message.currentVotes}/${message.requiredVotes})`);
                
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
                            text: `提案ID · ${message.proposalId}`,
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
                        content: ''
                    });
                    
                    // 更新数据库状态
                    await updateMessage(messageId, {
                        status: 'expired'
                    });
                    
                    console.log(`提案ID ${message.proposalId} 已标记为过期`);
                } catch (error) {
                    console.error(`更新过期提案ID ${message.proposalId} 时出错:`, error);
                }
            }
        }
        
        // 控制台输出总体统计
        console.log(`总检查提案数: ${totalChecked}`);
        console.log(`总过期提案数: ${totalExpired}`);
        
        // 为每个服务器输出详细统计
        for (const guildId in guildStats) {
            const stats = guildStats[guildId];
            console.log(`\n服务器: ${stats.guildName} (${guildId})`);
            console.log(`  检查提案数: ${stats.totalChecked}`);
            console.log(`  过期提案数: ${stats.expired}`);
        }
        
        console.log(`=== 过期提案检查完成 ===\n`);
        
        // 发送检查报告到指定频道
        await sendCheckReports(client, checkStartTime, guildStats, expiredProposalsByGuild);
        
    } catch (error) {
        console.error('检查过期提案时出错:', error);
    }
}

async function sendCheckReports(client, checkTime, guildStats, expiredProposalsByGuild) {
    try {
        // 获取所有检查频道设置
        const allCheckSettings = await getAllCheckChannelSettings();
        
        for (const guildId in allCheckSettings) {
            const checkSettings = allCheckSettings[guildId];
            
            // 跳过禁用的设置
            if (!checkSettings.enabled) continue;
            
            try {
                // 获取检查报告频道
                const checkChannel = await client.channels.fetch(checkSettings.checkChannelId);
                if (!checkChannel) continue;
                
                // 获取该服务器的统计数据
                const stats = guildStats[guildId] || { 
                    guildName: checkChannel.guild.name, 
                    totalChecked: 0, 
                    expired: 0 
                };
                const expiredProposals = expiredProposalsByGuild[guildId] || [];
                
                // 构建检查报告描述内容
                const checkTimestamp = Math.floor(checkTime.getTime() / 1000);
                let descriptionContent = `*<t:${checkTimestamp}:f>*\n`; // 添加斜体时间戳到描述开头
                descriptionContent += `📊 **过期提案检查报告**\n\n`;
                descriptionContent += `**🔍 检查统计**\n`;
                descriptionContent += `> 总检查提案数: **${stats.totalChecked}**\n`;
                descriptionContent += `> 过期提案数: **${stats.expired}**\n\n`;
                
                // 构建过期提案列表
                let expiredProposalsContent = '';
                if (expiredProposals.length > 0) {
                    expiredProposalsContent = `**📋 本次检查的过期提案:**\n\n`;
                    for (const proposal of expiredProposals) {
                        expiredProposalsContent += `> **${proposal.title}**\n`;
                        expiredProposalsContent += `> 发布时间: <t:${proposal.createdTimestamp}:f> | 截止时间: <t:${proposal.deadlineTimestamp}:f>\n\n`;
                    }
                } else {
                    expiredProposalsContent = `**📋 本次检查的过期提案:**\n\n> 本次检查没有发现过期提案 ✅\n`;
                }
                
                // 创建嵌入消息
                const reportEmbed = new EmbedBuilder()
                    .setTitle(`过期提案检查 - ${stats.guildName}`)
                    .setDescription(descriptionContent + expiredProposalsContent)
                    .setColor('#90EE90') // 浅绿色
                    .setFooter({ 
                        text: `自动检查系统 | 每20分钟检查一次`,
                        iconURL: checkChannel.guild.iconURL()
                    })
                    .setTimestamp(checkTime);
                
                // 如果有过期提案，添加一个字段来突出显示
                if (expiredProposals.length > 0) {
                    reportEmbed.addFields({
                        name: '⚠️ 注意',
                        value: `发现 **${expiredProposals.length}** 个过期提案已被自动处理`,
                        inline: false
                    });
                }
                
                // 发送报告（移除单独的content时间戳）
                await checkChannel.send({
                    embeds: [reportEmbed]
                });
                
                console.log(`已发送检查报告到服务器 ${stats.guildName} 的检查频道`);
                
            } catch (error) {
                console.error(`发送检查报告到服务器 ${guildId} 时出错:`, error);
            }
        }
        
    } catch (error) {
        console.error('发送检查报告时出错:', error);
    }
}

// 定时检查提案
function startProposalChecker(client) {
    console.log('启动提案检查器...');
    
    // 立即进行一次检查
    checkExpiredProposals(client);
    
    // 设置定时检查
    setInterval(() => {
        checkExpiredProposals(client);
    }, 20 * 60 * 1000); // 每20分钟检查一次
}

module.exports = {
    startProposalChecker,
    checkExpiredProposals
};