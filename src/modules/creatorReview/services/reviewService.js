// src\modules\creatorReview\services\reviewService.js
const { MessageFlags, ChannelType } = require('discord.js');
const { getReviewSettings, isServerAllowed, isForumAllowed } = require('../../../core/utils/database');

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

/**
 * 获取帖子首楼不重复反应用户数
 * @param {ThreadChannel} thread - 论坛帖子频道
 * @returns {number} 不重复反应用户数
 */
async function getThreadFirstMessageReactions(thread) {
    try {
        // 获取帖子的起始消息（首楼）
        const starterMessage = await thread.fetchStarterMessage();
        
        if (!starterMessage) {
            console.log(`帖子 ${thread.name} 中没有找到起始消息`);
            return 0;
        }
        
        // 收集所有不重复的反应用户
        const uniqueUsers = new Set();
        
        if (starterMessage.reactions && starterMessage.reactions.cache) {
            // 遍历所有反应类型
            for (const reaction of starterMessage.reactions.cache.values()) {
                try {
                    // 获取该反应的所有用户
                    const users = await reaction.users.fetch();
                    
                    // 将用户ID添加到Set中（自动去重）
                    users.forEach(user => {
                        if (!user.bot) { // 排除机器人
                            uniqueUsers.add(user.id);
                        }
                    });
                } catch (error) {
                    console.error(`获取反应用户失败 (${reaction.emoji.name}):`, error);
                }
            }
        }
        
        const uniqueUserCount = uniqueUsers.size;
        console.log(`帖子 ${thread.name} 首楼不重复反应用户数: ${uniqueUserCount}`);
        return uniqueUserCount;
    } catch (error) {
        console.error('获取帖子首楼不重复反应用户数失败:', error);
        return 0;
    }
}

/**
 * 获取论坛帖子的作者（分批处理以避免API限制）
 * @param {ThreadChannel} channel - 论坛帖子频道
 * @returns {User|null} 帖子作者
 */
async function getThreadAuthor(channel) {
    try {
        let oldestMessage = null;
        let oldestTimestamp = Date.now();
        let lastMessageId = null;
        let hasMoreMessages = true;
        let fetchCount = 0;
        const maxFetches = 5; // 最多获取5批消息，避免无限循环
        
        while (hasMoreMessages && fetchCount < maxFetches) {
            const fetchOptions = {
                limit: 100, // Discord API 最大限制
                cache: false
            };
            
            // 如果不是第一次获取，设置 before 参数
            if (lastMessageId) {
                fetchOptions.before = lastMessageId;
            }
            
            console.log(`第 ${fetchCount + 1} 次获取消息，选项:`, fetchOptions);
            
            const messages = await channel.messages.fetch(fetchOptions);
            
            if (messages.size === 0) {
                hasMoreMessages = false;
                break;
            }
            
            // 找到这批消息中最早的
            messages.forEach(message => {
                if (message.createdTimestamp < oldestTimestamp) {
                    oldestTimestamp = message.createdTimestamp;
                    oldestMessage = message;
                }
            });
            
            // 设置下次获取的起点
            const messagesArray = Array.from(messages.values());
            lastMessageId = messagesArray[messagesArray.length - 1].id;
            
            // 如果这批消息少于100条，说明没有更多消息了
            if (messages.size < 100) {
                hasMoreMessages = false;
            }
            
            fetchCount++;
            
            console.log(`获取了 ${messages.size} 条消息，当前最早消息时间: ${new Date(oldestTimestamp).toISOString()}`);
        }
        
        if (oldestMessage) {
            console.log(`找到最早消息作者: ${oldestMessage.author.tag}, 创建时间: ${oldestMessage.createdAt}`);
            return oldestMessage.author;
        }
        
        console.log('未找到任何消息');
        return null;
        
    } catch (error) {
        console.error('获取帖子作者时出错:', error);
        return null;
    }
}

/**
 * 处理用户提交的创作者审核。
 * @param {import('discord.js').ModalSubmitInteraction} interaction - 提交交互对象。
 */
async function processReviewSubmission(interaction) {
    try {
        // 立即defer回复以避免超时
        await interaction.deferReply({ ephemeral: true });
        
        // 获取表单数据
        const postLink = interaction.fields.getTextInputValue('post_link').trim();
        
        console.log(`用户 ${interaction.user.tag} 提交审核:`, { postLink });
        
        // 从数据库获取审核设置
        const reviewSettings = await getReviewSettings(interaction.guild.id);
        
        if (!reviewSettings) {
            return interaction.editReply({ 
                content: '找不到审核设置。请联系管理员设置审核入口。'
            });
        }
        
        // 解析帖子链接
        const linkData = parseDiscordLink(postLink);
        
        if (!linkData) {
            return interaction.editReply({ 
                content: '❌ 无效的Discord帖子链接格式。\n\n支持的格式：\n• `https://discord.com/channels/服务器ID/频道ID` (帖子整体)\n• `https://discord.com/channels/服务器ID/频道ID/消息ID` (帖子首条消息)'
            });
        }
        
        // 检查服务器是否在允许列表中
        const isAllowed = await isServerAllowed(interaction.guild.id, linkData.guildId);
        if (!isAllowed) {
            return interaction.editReply({ 
                content: '❌ 目前机器人只能审核当前服务器的帖子。'
            });
        }
        
        // 获取目标服务器
        let targetGuild;
        try {
            targetGuild = await interaction.client.guilds.fetch(linkData.guildId);
        } catch (error) {
            console.error('获取目标服务器失败:', error);
            return interaction.editReply({ 
                content: '❌ 无法访问目标服务器，机器人可能不在该服务器中。'
            });
        }
        
        // 获取频道
        let targetChannel;
        try {
            targetChannel = await interaction.client.channels.fetch(linkData.channelId);
        } catch (error) {
            console.error('获取频道失败:', error);
            return interaction.editReply({ 
                content: '❌ 无法访问指定的频道，请检查链接是否正确或机器人是否有权限访问该频道。'
            });
        }
        
        // 检查是否为论坛帖子
        if (!isForumThread(targetChannel)) {
            return interaction.editReply({ 
                content: '❌ 指定的链接不是论坛帖子。只能审核论坛帖子。'
            });
        }
        
        // 检查论坛频道是否在允许列表中
        const forumChannelId = targetChannel.parent.id; // 获取父论坛频道ID
        const forumAllowed = await isForumAllowed(interaction.guild.id, linkData.guildId, forumChannelId);

        if (!forumAllowed) {
            return interaction.editReply({ 
                content: `❌ 该论坛频道不在允许审核范围内。\n\n**论坛信息：**\n• 服务器：${targetGuild.name}\n• 论坛：${targetChannel.parent.name}\n\n请联系管理员将该论坛频道添加到允许列表中。`
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
                return interaction.editReply({ 
                    content: '❌ 无法找到指定的消息，请检查链接是否正确。'
                });
            }
        } else {
            // 如果没有消息ID，获取帖子的原始作者
            try {
                // 方法1：尝试获取论坛帖子的 starterMessage（原始消息）
                if (targetChannel.starterMessage) {
                    threadAuthor = targetChannel.starterMessage.author;
                    console.log(`通过starterMessage获取作者: ${threadAuthor.tag}`);
                } else {
                    // 方法2：分批获取消息以找到最早的消息
                    threadAuthor = await getThreadAuthor(targetChannel);
                    
                    if (!threadAuthor) {
                        return interaction.editReply({ 
                            content: '❌ 无法找到帖子的作者信息。'
                        });
                    }
                }
            } catch (error) {
                console.error('获取帖子作者失败:', error);
                return interaction.editReply({ 
                    content: '❌ 无法获取帖子作者信息，请检查链接是否正确。'
                });
            }
        }

        console.log(`帖子作者: ${threadAuthor.tag} (${threadAuthor.id}), 提交者: ${interaction.user.tag} (${interaction.user.id})`);

        // 检查帖子作者是否为提交者
        if (threadAuthor.id !== interaction.user.id) {
            return interaction.editReply({ 
                content: '❌ 您只能提交自己发表的帖子进行审核。'
            });
        }
        
        // 检查帖子是否已发布满72小时
        const REQUIRED_POST_AGE_HOURS = 72;
        const postCreatedAt = targetChannel.createdTimestamp;
        const postAgeMs = Date.now() - postCreatedAt;
        const postAgeHours = postAgeMs / (1000 * 60 * 60);
        
        if (postAgeHours < REQUIRED_POST_AGE_HOURS) {
            const remainingMs = (REQUIRED_POST_AGE_HOURS * 60 * 60 * 1000) - postAgeMs;
            const remainingHours = Math.floor(remainingMs / (1000 * 60 * 60));
            const remainingMinutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
            
            return interaction.editReply({ 
                content: `❌ **审核未通过 — 帖子发布时间不足**\n\n您的帖子需要发布满 **${REQUIRED_POST_AGE_HOURS} 小时**后才能提交审核。\n\n**帖子信息：**\n• 服务器：${targetGuild.name}\n• 帖子：${targetChannel.name}\n• 发布时间：<t:${Math.floor(postCreatedAt / 1000)}:F>\n• 距离可提交还需：**${remainingHours} 小时 ${remainingMinutes} 分钟**\n• 链接：[点击查看](${postLink})\n\n请在帖子满 ${REQUIRED_POST_AGE_HOURS} 小时后再次提交。`
            });
        }
        
        console.log(`帖子年龄检查通过: 已发布 ${postAgeHours.toFixed(1)} 小时 (要求 ${REQUIRED_POST_AGE_HOURS} 小时)`);
        
        // 计算不重复用户反应数
        const totalReactions = await getThreadFirstMessageReactions(targetChannel);
        const requiredReactions = reviewSettings.requiredReactions;
        
        console.log(`帖子反应统计: 当前不重复用户数=${totalReactions}, 需要=${requiredReactions}`);
        console.log(`帖子信息: 服务器=${targetGuild.name}, 频道=${targetChannel.name}, 作者=${threadAuthor.tag}`);
        
        // 检查是否达到要求
        if (totalReactions < requiredReactions) {
            return interaction.editReply({ 
                content: `❌ **审核未通过**\n\n您的帖子当前有 **${totalReactions}** 个独特用户的反应，需要达到 **${requiredReactions}** 个独特用户的反应才能通过审核。\n\n**帖子信息：**\n• 服务器：${targetGuild.name}\n• 帖子：${targetChannel.name}\n• 链接：[点击查看](${postLink})\n\n请继续努力获取更多独特用户的反应后再次提交。`
            });
        }
        
        // 获取奖励身份组
        const rewardRole = interaction.guild.roles.cache.get(reviewSettings.rewardRoleId);
        
        if (!rewardRole) {
            console.error('找不到奖励身份组:', reviewSettings.rewardRoleId);
            return interaction.editReply({ 
                content: '❌ 系统配置错误：找不到奖励身份组。请联系管理员。'
            });
        }
        
        // 检查用户是否已有该身份组
        if (interaction.member.roles.cache.has(rewardRole.id)) {
            return interaction.editReply({ 
                content: `❌ 您已经拥有 ${rewardRole} 身份组了。`
            });
        }
        
        // 为用户添加身份组
        try {
            await interaction.member.roles.add(rewardRole);
            
            console.log(`成功为用户 ${interaction.user.tag} 添加身份组 ${rewardRole.name}`);
            
            await interaction.editReply({ 
                content: `✅ **审核通过！**\n\n🎉 恭喜您！您的帖子已获得 **${totalReactions}** 个独特用户的反应，成功通过审核。\n\n您已获得 ${rewardRole} 身份组！\n\n**帖子信息：**\n• 服务器：${targetGuild.name}\n• 帖子：${targetChannel.name}\n• 不重复反应用户数：${totalReactions}/${requiredReactions}\n• 帖子链接：[点击查看](${postLink})`
            });
            
        } catch (error) {
            console.error('添加身份组失败:', error);
            return interaction.editReply({ 
                content: `❌ 审核通过，但添加身份组时出错。请联系管理员手动添加身份组。\n\n错误信息：${error.message}`
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
            } else {
                await interaction.editReply({ 
                    content: '❌ 处理您的审核提交时出现错误，请稍后重试。'
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
    getThreadFirstMessageReactions,
    isForumThread,
    getThreadAuthor
};