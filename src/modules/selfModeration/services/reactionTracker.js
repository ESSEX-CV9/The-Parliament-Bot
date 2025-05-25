// src\modules\selfModeration\services\reactionTracker.js
const { updateSelfModerationVote } = require('../../../core/utils/database');
const { DELETE_THRESHOLD, MUTE_DURATIONS } = require('../../../core/config/timeconfig');

/**
 * 获取目标消息的⚠️反应数量
 * @param {Client} client - Discord客户端
 * @param {string} guildId - 服务器ID
 * @param {string} channelId - 频道ID
 * @param {string} messageId - 消息ID
 * @returns {number} ⚠️反应数量
 */
async function getShitReactionCount(client, guildId, channelId, messageId) {
    try {
        // 获取频道
        const channel = await client.channels.fetch(channelId);
        if (!channel) {
            console.error(`找不到频道: ${channelId}`);
            return 0;
        }
        
        // 获取消息
        const message = await channel.messages.fetch(messageId);
        if (!message) {
            console.error(`找不到消息: ${messageId}`);
            return 0;
        }
        
        // 查找⚠️反应
        const shitReaction = message.reactions.cache.find(reaction => reaction.emoji.name === '⚠️');
        
        if (!shitReaction) {
            console.log(`消息 ${messageId} 没有⚠️反应`);
            return 0;
        }
        
        const count = shitReaction.count;
        console.log(`消息 ${messageId} 的⚠️反应数量: ${count}`);
        return count;
        
    } catch (error) {
        console.error('获取⚠️反应数量时出错:', error);
        return 0;
    }
}

/**
 * 更新投票的反应数量
 * @param {string} guildId - 服务器ID
 * @param {string} targetMessageId - 目标消息ID
 * @param {string} type - 投票类型
 * @param {number} newCount - 新的反应数量
 * @returns {object|null} 更新后的投票数据
 */
async function updateVoteReactionCount(guildId, targetMessageId, type, newCount) {
    try {
        const updated = await updateSelfModerationVote(guildId, targetMessageId, type, {
            lastReactionCount: newCount,
            currentReactionCount: newCount,
            lastChecked: new Date().toISOString()
        });
        
        return updated;
        
    } catch (error) {
        console.error('更新投票反应数量时出错:', error);
        return null;
    }
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
 * 批量检查多个投票的反应数量
 * @param {Client} client - Discord客户端
 * @param {Array} votes - 投票数组
 * @returns {Array} 更新后的投票数组
 */
async function batchCheckReactions(client, votes) {
    const updatedVotes = [];
    
    for (const vote of votes) {
        try {
            const { guildId, targetChannelId, targetMessageId, type } = vote;
            
            // 获取当前反应数量
            const currentCount = await getShitReactionCount(client, guildId, targetChannelId, targetMessageId);
            
            // 如果反应数量有变化，更新数据库
            if (currentCount !== vote.currentReactionCount) {
                const updatedVote = await updateVoteReactionCount(guildId, targetMessageId, type, currentCount);
                if (updatedVote) {
                    updatedVotes.push(updatedVote);
                } else {
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
    updateVoteReactionCount,
    checkReactionThreshold,
    batchCheckReactions,
    getReactionChangeDescription
};