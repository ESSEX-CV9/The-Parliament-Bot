// src/services/reviewService.js
const { MessageFlags, ChannelType } = require('discord.js');
const { getReviewSettings, isServerAllowed } = require('../utils/database');

/**
 * 解析Discord帖子链接
 * @param {string} link - Discord帖子链接
 * @returns {object|null} 解析结果包含 guildId, channelId, messageId (可选)
 */
function parseDiscordLink(link) {
    // 支持两种格式:
    // 1. https://discord.com/channels/{guild_id}/{channel_id} (帖子整体)
    // 2. https://discord.com/channels/{guild_id}/{channel_id}/{message_id} (帖子首条消息)
    const regexWithMessage = /https:\/\/(discord|discordapp)\.com\/channels\/(\d+)\/(\d+)\/(\d+)/;
    const regexWithoutMessage = /https:\/\/(discord|discordapp)\.com\/channels\/(\d+)\/(\d+)$/;
    
    let match = link.match(regexWithMessage);
    if (match) {
        return {
            guildId: match[2],
            channelId: match[3],
            messageId: match[4],
            hasMessageId: true
        };
    }
    
    match = link.match(regexWithoutMessage);
    if (match) {
        return {
            guildId: match[2],
            channelId: match[3],
            messageId: null,
            hasMessageId: false
        };
    }
    
    return null;
}

/**
 * 检查频道是否为论坛帖子
 * @param {Channel} channel - Discord频道对象
 * @returns {boolean} 是否为论坛帖子
 */
function isForumThread(channel) {
    // 检查频道类型是否为论坛帖子
    return channel.type === ChannelType.PublicThread && 
           channel.parent && 
           channel.parent.type === ChannelType.GuildForum;
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

/**
 * 获取帖子的总反应数（包括所有消息的反应）
 * @param {ThreadChannel} thread - 论坛帖子频道
 * @returns {number} 总反应数
 */
async function getThreadTotalReactions(thread) {
    try {
        let totalReactions = 0;
        
        // 获取帖子中的所有消息
        const messages = await thread.messages.fetch({ limit: 100 });
        
        messages.forEach(message => {
            if (message.reactions && message.reactions.cache) {
                message.reactions.cache.forEach(reaction => {
                    totalReactions += reaction.count;
                });
            }
        });
        
        return totalReactions;
    } catch (error) {
        console.error('获取帖子总反应数失败:', error);
        return 0;
    }
}

async function processReviewSubmission(interaction) {
    try {
        // 获取表单数据
        const postLink = interaction.fields.getTextInputValue('post_link').trim();

        console.log(`用户 ${interaction.user.tag} 提交审核:`, { postLink });
        
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
                content: '❌ 无效的Discord帖子链接格式。\n\n支持的格式：\n• `https://discord.com/channels/服务器ID/频道ID` (帖子整体)\n• `https://discord.com/channels/服务器ID/频道ID/消息ID` (帖子首条消息)',
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 检查服务器是否在允许列表中
        const isAllowed = await isServerAllowed(interaction.guild.id, linkData.guildId);
        if (!isAllowed) {
            return interaction.reply({ 
                content: '❌ 目前机器人只能审核当前服务器的帖子。',
                // content: '❌ 该服务器的帖子不在允许审核范围内。请联系管理员将该服务器添加到允许列表中。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 获取目标服务器
        let targetGuild;
        try {
            targetGuild = await interaction.client.guilds.fetch(linkData.guildId);
        } catch (error) {
            console.error('获取目标服务器失败:', error);
            return interaction.reply({ 
                content: '❌ 无法访问目标服务器，机器人可能不在该服务器中。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 获取频道
        let targetChannel;
        try {
            targetChannel = await interaction.client.channels.fetch(linkData.channelId);
        } catch (error) {
            console.error('获取频道失败:', error);
            return interaction.reply({ 
                content: '❌ 无法访问指定的频道，请检查链接是否正确或机器人是否有权限访问该频道。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 检查是否为论坛帖子
        if (!isForumThread(targetChannel)) {
            return interaction.reply({ 
                content: '❌ 指定的链接不是论坛帖子。只能审核论坛帖子。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 获取帖子作者
        let threadAuthor;
        if (linkData.hasMessageId) {
            // 如果有消息ID，检查该消息的作者
            try {
                const targetMessage = await targetChannel.messages.fetch(linkData.messageId);
                threadAuthor = targetMessage.author;
            } catch (error) {
                console.error('获取消息失败:', error);
                return interaction.reply({ 
                    content: '❌ 无法找到指定的消息，请检查链接是否正确。',
                    flags: MessageFlags.Ephemeral
                });
            }
        } else {
            // 如果没有消息ID，获取帖子的第一条消息作者
            try {
                const messages = await targetChannel.messages.fetch({ limit: 1 });
                const firstMessage = messages.first();
                if (!firstMessage) {
                    return interaction.reply({ 
                        content: '❌ 无法找到帖子的首条消息。',
                        flags: MessageFlags.Ephemeral
                    });
                }
                threadAuthor = firstMessage.author;
            } catch (error) {
                console.error('获取帖子首条消息失败:', error);
                return interaction.reply({ 
                    content: '❌ 无法获取帖子信息，请检查链接是否正确。',
                    flags: MessageFlags.Ephemeral
                });
            }
        }
        
        // 检查帖子作者是否为提交者
        if (threadAuthor.id !== interaction.user.id) {
            return interaction.reply({ 
                content: '❌ 您只能提交自己发表的帖子进行审核。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 计算总反应数
        const totalReactions = await getThreadTotalReactions(targetChannel);
        const requiredReactions = reviewSettings.requiredReactions;
        
        console.log(`帖子反应统计: 当前=${totalReactions}, 需要=${requiredReactions}`);
        console.log(`帖子信息: 服务器=${targetGuild.name}, 频道=${targetChannel.name}, 作者=${threadAuthor.tag}`);
        
        // 检查是否达到要求
        if (totalReactions < requiredReactions) {
            return interaction.reply({ 
                content: `❌ **审核未通过**\n\n您的作品当前反应数为 **${totalReactions}**，需要达到 **${requiredReactions}** 个反应才能通过审核。\n\n**作品信息：**\n• 作品：${postLink}\n\n请继续努力获取更多反应后再次提交。`,
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
                content: `✅ **审核通过！**\n\n🎉 恭喜您！您的作品已达到 **${totalReactions}** 个反应，成功通过审核。\n\n您已获得 ${rewardRole} 身份组！\n\n**作品信息：**\n• 服务器：${targetGuild.name}\n• 作品：${postLink}\n• 反应数：${totalReactions}/${requiredReactions}`,
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
    getTotalReactions,
    getThreadTotalReactions,
    isForumThread
};