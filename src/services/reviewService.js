// src/services/reviewService.js
const { MessageFlags } = require('discord.js');
const { getReviewSettings } = require('../utils/database');

/**
 * 解析Discord帖子链接
 * @param {string} link - Discord帖子链接
 * @returns {object|null} 解析结果包含 guildId, channelId, messageId
 */
function parseDiscordLink(link) {
    // Discord消息链接格式: https://discord.com/channels/{guild_id}/{channel_id}/{message_id}
    // 或者 https://discordapp.com/channels/{guild_id}/{channel_id}/{message_id}
    const regex = /https:\/\/(discord|discordapp)\.com\/channels\/(\d+)\/(\d+)\/(\d+)/;
    const match = link.match(regex);
    
    if (!match) {
        return null;
    }
    
    return {
        guildId: match[2],
        channelId: match[3],
        messageId: match[4]
    };
}

/**
 * 获取消息的总反应数
 * @param {Message} message - Discord消息对象
 * @returns {number} 总反应数
 */
function getTotalReactions(message) {
    if (!message.reactions || !message.reactions.cache) {
        return 0;
    }
    
    let totalReactions = 0;
    message.reactions.cache.forEach(reaction => {
        totalReactions += reaction.count;
    });
    
    return totalReactions;
}

async function processReviewSubmission(interaction) {
    try {
        // 获取表单数据
        const postLink = interaction.fields.getTextInputValue('post_link').trim();
        const description = interaction.fields.getTextInputValue('description') || '';
        
        console.log(`用户 ${interaction.user.tag} 提交审核:`, { postLink, description });
        
        // 从数据库获取审核设置
        const reviewSettings = await getReviewSettings(interaction.guild.id);
        
        if (!reviewSettings) {
            return interaction.reply({ 
                content: '找不到审核设置。请联系管理员设置审核入口。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 解析帖子链接
        const linkData = parseDiscordLink(postLink);
        
        if (!linkData) {
            return interaction.reply({ 
                content: '❌ 无效的Discord帖子链接格式。\n\n请确保链接格式类似于：\n`https://discord.com/channels/123456789/123456789/123456789`',
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 检查是否为当前服务器的帖子
        if (linkData.guildId !== interaction.guild.id) {
            return interaction.reply({ 
                content: '❌ 只能提交当前服务器的帖子进行审核。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 获取频道和消息
        let targetChannel, targetMessage;
        
        try {
            targetChannel = await interaction.client.channels.fetch(linkData.channelId);
        } catch (error) {
            console.error('获取频道失败:', error);
            return interaction.reply({ 
                content: '❌ 无法访问指定的频道，请检查链接是否正确或机器人是否有权限访问该频道。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        try {
            targetMessage = await targetChannel.messages.fetch(linkData.messageId);
        } catch (error) {
            console.error('获取消息失败:', error);
            return interaction.reply({ 
                content: '❌ 无法找到指定的帖子，请检查链接是否正确。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 检查帖子作者是否为提交者
        if (targetMessage.author.id !== interaction.user.id) {
            return interaction.reply({ 
                content: '❌ 您只能提交自己发表的帖子进行审核。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 计算总反应数
        const totalReactions = getTotalReactions(targetMessage);
        const requiredReactions = reviewSettings.requiredReactions;
        
        console.log(`帖子反应统计: 当前=${totalReactions}, 需要=${requiredReactions}`);
        
        // 检查是否达到要求
        if (totalReactions < requiredReactions) {
            return interaction.reply({ 
                content: `❌ **审核未通过**\n\n您的帖子当前反应数为 **${totalReactions}**，需要达到 **${requiredReactions}** 个反应才能通过审核。\n\n请继续努力获取更多反应后再次提交。`,
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 获取奖励身份组
        const rewardRole = interaction.guild.roles.cache.get(reviewSettings.rewardRoleId);
        
        if (!rewardRole) {
            console.error('找不到奖励身份组:', reviewSettings.rewardRoleId);
            return interaction.reply({ 
                content: '❌ 系统配置错误：找不到奖励身份组。请联系管理员。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 检查用户是否已有该身份组
        if (interaction.member.roles.cache.has(rewardRole.id)) {
            return interaction.reply({ 
                content: `❌ 您已经拥有 ${rewardRole} 身份组了。`,
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 为用户添加身份组
        try {
            await interaction.member.roles.add(rewardRole);
            
            console.log(`成功为用户 ${interaction.user.tag} 添加身份组 ${rewardRole.name}`);
            
            await interaction.reply({ 
                content: `✅ **审核通过！**\n\n🎉 恭喜您！您的帖子已达到 **${totalReactions}** 个反应，成功通过审核。\n\n您已获得 ${rewardRole} 身份组！\n\n**帖子信息：**\n• 频道：<#${targetChannel.id}>\n• 反应数：${totalReactions}/${requiredReactions}\n• 帖子链接：[点击查看](${postLink})`,
                flags: MessageFlags.Ephemeral
            });
            
        } catch (error) {
            console.error('添加身份组失败:', error);
            return interaction.reply({ 
                content: `❌ 审核通过，但添加身份组时出错。请联系管理员手动添加身份组。\n\n错误信息：${error.message}`,
                flags: MessageFlags.Ephemeral
            });
        }
        
    } catch (error) {
        console.error('处理审核提交时出错:', error);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ 
                    content: '❌ 处理您的审核提交时出现错误，请稍后重试。',
                    flags: MessageFlags.Ephemeral
                });
            }
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

module.exports = {
    processReviewSubmission,
    parseDiscordLink,
    getTotalReactions
};