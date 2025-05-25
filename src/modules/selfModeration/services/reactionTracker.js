// src\modules\selfModeration\services\reactionTracker.js
const { updateSelfModerationVote } = require('../../../core/utils/database');
const { DELETE_THRESHOLD, MUTE_DURATIONS } = require('../../../core/config/timeconfig');

/**
 * 检查消息是否存在
 * @param {Client} client - Discord客户端
 * @param {string} channelId - 频道ID
 * @param {string} messageId - 消息ID
 * @returns {boolean} 消息是否存在
 */
async function checkMessageExists(client, channelId, messageId) {
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) {
            console.log(`频道 ${channelId} 不存在`);
            return false;
        }
        
        const message = await channel.messages.fetch(messageId);
        return !!message;
        
    } catch (error) {
        // 如果获取消息失败，通常意味着消息已被删除
        console.log(`消息 ${messageId} 不存在或无法访问: ${error.message}`);
        return false;
    }
}

/**
 * 获取消息的⚠️反应用户列表
 * @param {Client} client - Discord客户端
 * @param {string} channelId - 频道ID
 * @param {string} messageId - 消息ID
 * @returns {Set<string>} 用户ID集合
 */
async function getShitReactionUsers(client, channelId, messageId) {
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) {
            console.error(`找不到频道: ${channelId}`);
            return new Set();
        }
        
        const message = await channel.messages.fetch(messageId);
        if (!message) {
            console.error(`找不到消息: ${messageId}`);
            return new Set();
        }
        
        // 查找⚠️反应
        const shitReaction = message.reactions.cache.find(reaction => {
            return reaction.emoji.name === '⚠️' || 
                   reaction.emoji.name === '⚠' ||
                   reaction.emoji.name === 'warning' ||
                   reaction.emoji.name === ':warning:' ||
                   reaction.emoji.unicode === '⚠️';
        });
        
        if (!shitReaction) {
            console.log(`消息 ${messageId} 没有⚠️反应`);
            return new Set();
        }
        
        // 获取所有添加了⚠️反应的用户
        const users = await shitReaction.users.fetch();
        const userIds = new Set();
        
        users.forEach(user => {
            if (!user.bot) { // 排除机器人
                userIds.add(user.id);
            }
        });
        
        console.log(`消息 ${messageId} 的⚠️反应用户数量: ${userIds.size}`);
        return userIds;
        
    } catch (error) {
        console.error('获取⚠️反应用户时出错:', error);
        return new Set();
    }
}

/**
 * 获取目标消息和投票公告的⚠️反应数量（去重后）
 * @param {Client} client - Discord客户端
 * @param {object} voteData - 投票数据
 * @returns {object} {uniqueUsers: Set, totalCount: number, targetMessageExists: boolean}
 */
async function getDeduplicatedReactionCount(client, voteData) {
    try {
        const { 
            guildId, 
            targetChannelId, 
            targetMessageId, 
            voteAnnouncementChannelId, 
            voteAnnouncementMessageId,
            type
        } = voteData;
        
        // 检查目标消息是否存在
        const targetMessageExists = await checkMessageExists(client, targetChannelId, targetMessageId);
        console.log(`目标消息 ${targetMessageId} 是否存在: ${targetMessageExists}`);
        
        // 初始化用户集合
        const allUsers = new Set();
        
        // 如果目标消息存在，获取其反应用户
        if (targetMessageExists) {
            const targetUsers = await getShitReactionUsers(client, targetChannelId, targetMessageId);
            console.log(`目标消息反应用户: ${targetUsers.size}`);
            targetUsers.forEach(userId => allUsers.add(userId));
        } else {
            console.log(`目标消息不存在，跳过目标消息反应统计`);
        }
        
        // 获取投票公告的反应用户（投票公告应该始终存在）
        if (voteAnnouncementMessageId && voteAnnouncementChannelId) {
            const announcementUsers = await getShitReactionUsers(client, voteAnnouncementChannelId, voteAnnouncementMessageId);
            console.log(`投票公告反应用户: ${announcementUsers.size}`);
            announcementUsers.forEach(userId => allUsers.add(userId));
        }
        
        console.log(`去重后总反应用户数: ${allUsers.size}`);
        
        return {
            uniqueUsers: allUsers,
            totalCount: allUsers.size,
            targetMessageExists
        };
        
    } catch (error) {
        console.error('获取去重后反应数量时出错:', error);
        return {
            uniqueUsers: new Set(),
            totalCount: 0,
            targetMessageExists: false
        };
    }
}

/**
 * 获取目标消息的⚠️反应数量（兼容旧函数）
 * @param {Client} client - Discord客户端
 * @param {string} guildId - 服务器ID
 * @param {string} channelId - 频道ID
 * @param {string} messageId - 消息ID
 * @returns {number} ⚠️反应数量
 */
async function getShitReactionCount(client, guildId, channelId, messageId) {
    try {
        const users = await getShitReactionUsers(client, channelId, messageId);
        return users.size;
    } catch (error) {
        console.error('获取⚠️反应数量时出错:', error);
        return 0;
    }
}


/**
 * 更新投票的反应数量（使用去重逻辑）
 * @param {Client} client - Discord客户端
 * @param {object} voteData - 投票数据
 * @returns {object|null} 更新后的投票数据
 */
async function updateVoteReactionCountWithDeduplication(client, voteData) {
    try {
        const { guildId, targetMessageId, type } = voteData;
        
        // 获取去重后的反应数量
        const reactionResult = await getDeduplicatedReactionCount(client, voteData);
        const newCount = reactionResult.totalCount;
        const targetMessageExists = reactionResult.targetMessageExists;
        
        // 更新数据库
        const updated = await updateSelfModerationVote(guildId, targetMessageId, type, {
            lastReactionCount: newCount,
            currentReactionCount: newCount,
            lastChecked: new Date().toISOString(),
            uniqueUserCount: newCount,
            targetMessageExists: targetMessageExists // 记录目标消息是否存在
        });
        
        console.log(`更新投票 ${guildId}_${targetMessageId}_${type} 反应数量: ${newCount}, 目标消息存在: ${targetMessageExists}`);
        return updated;
        
    } catch (error) {
        console.error('更新投票反应数量时出错:', error);
        return null;
    }
}

/**
 * 批量检查多个投票的反应数量（使用去重逻辑）
 * @param {Client} client - Discord客户端
 * @param {Array} votes - 投票数组
 * @returns {Array} 更新后的投票数组
 */
async function batchCheckReactions(client, votes) {
    const updatedVotes = [];
    
    for (const vote of votes) {
        try {
            // 使用新的去重反应计数方法
            const reactionResult = await getDeduplicatedReactionCount(client, vote);
            const currentCount = reactionResult.totalCount;
            
            // 如果反应数量有变化，更新数据库
            if (currentCount !== vote.currentReactionCount) {
                const updatedVote = await updateVoteReactionCountWithDeduplication(client, vote);
                if (updatedVote) {
                    updatedVotes.push(updatedVote);
                } else {
                    // 如果更新失败，至少更新内存中的数据
                    vote.currentReactionCount = currentCount;
                    updatedVotes.push(vote);
                }
            } else {
                updatedVotes.push(vote);
            }
            
        } catch (error) {
            console.error(`检查投票 ${vote.guildId}_${vote.targetMessageId}_${vote.type} 的反应时出错:`, error);
            updatedVotes.push(vote);
        }
    }
    
    return updatedVotes;
}

/**
 * 检查反应数量是否达到阈值
 * @param {number} reactionCount - 反应数量
 * @param {string} type - 投票类型 ('delete' 或 'mute')
 * @returns {object} {reached: boolean, threshold: number, action: string}
 */
function checkReactionThreshold(reactionCount, type) {
    if (type === 'delete') {
        return {
            reached: reactionCount >= DELETE_THRESHOLD,
            threshold: DELETE_THRESHOLD,
            action: '删除消息'
        };
    } else if (type === 'mute') {
        // 使用禁言的最低阈值
        const MUTE_BASE_THRESHOLD = MUTE_DURATIONS.LEVEL_1.threshold;
        return {
            reached: reactionCount >= MUTE_BASE_THRESHOLD,
            threshold: MUTE_BASE_THRESHOLD,
            action: '禁言用户'
        };
    }
    
    return {
        reached: false,
        threshold: 0,
        action: '未知操作'
    };
}

/**
 * 获取反应数量变化的描述
 * @param {number} oldCount - 旧的反应数量
 * @param {number} newCount - 新的反应数量
 * @returns {string} 变化描述
 */
function getReactionChangeDescription(oldCount, newCount) {
    if (newCount > oldCount) {
        return `⚠️反应增加了 ${newCount - oldCount} 个 (${oldCount} → ${newCount})`;
    } else if (newCount < oldCount) {
        return `⚠️反应减少了 ${oldCount - newCount} 个 (${oldCount} → ${newCount})`;
    } else {
        return `⚠️反应数量没有变化 (${newCount})`;
    }
}

module.exports = {
    getShitReactionCount,
    getShitReactionUsers,
    getDeduplicatedReactionCount,
    updateVoteReactionCountWithDeduplication,
    checkMessageExists,
    checkReactionThreshold,
    batchCheckReactions,
    getReactionChangeDescription
};