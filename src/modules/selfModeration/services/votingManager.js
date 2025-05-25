// src\modules\selfModeration\services\votingManager.js
const { getSelfModerationVote, saveSelfModerationVote, updateSelfModerationVote } = require('../../../core/utils/database');
const { getSelfModerationVoteEndTime } = require('../../../core/config/timeconfig');

/**
 * 创建或合并自助管理投票
 * @param {object} voteData - 投票数据
 * @returns {object} 投票结果 {isNewVote: boolean, voteData: object, message: string}
 */
async function createOrMergeVote(voteData) {
    try {
        const { guildId, targetMessageId, type, initiatorId, channelId } = voteData;
        
        // 检查是否已存在相同的投票
        const existingVote = await getSelfModerationVote(guildId, targetMessageId, type);
        
        if (existingVote) {
            // 检查是否是同一个发起人
            if (existingVote.initiatorId === initiatorId) {
                return {
                    isNewVote: false,
                    voteData: existingVote,
                    message: '您已经对这个消息发起过相同的投票了。'
                };
            }
            
            // 不同发起人，合并投票（更新发起人列表）
            const updatedInitiators = existingVote.initiators || [existingVote.initiatorId];
            if (!updatedInitiators.includes(initiatorId)) {
                updatedInitiators.push(initiatorId);
            }
            
            const updatedVote = await updateSelfModerationVote(guildId, targetMessageId, type, {
                initiators: updatedInitiators,
                lastUpdated: new Date().toISOString()
            });
            
            return {
                isNewVote: false,
                voteData: updatedVote,
                message: '已合并到现有的投票中。'
            };
        }
        
        // 创建新投票
        const newVoteData = {
            ...voteData,
            initiators: [initiatorId],
            startTime: new Date().toISOString(),
            endTime: getSelfModerationVoteEndTime().toISOString(),
            status: 'active',
            currentReactionCount: 0,
            lastReactionCount: 0,
            executed: false,
            executedActions: [] // 记录已执行的惩罚
        };
        
        const savedVote = await saveSelfModerationVote(newVoteData);
        
        return {
            isNewVote: true,
            voteData: savedVote,
            message: '投票已启动。'
        };
        
    } catch (error) {
        console.error('创建或合并投票时出错:', error);
        throw error;
    }
}

/**
 * 检查是否存在冲突的投票类型
 * @param {string} guildId - 服务器ID
 * @param {string} targetMessageId - 目标消息ID
 * @param {string} currentType - 当前投票类型
 * @returns {object|null} 冲突的投票信息或null
 */
async function checkConflictingVote(guildId, targetMessageId, currentType) {
    try {
        const otherType = currentType === 'delete' ? 'mute' : 'delete';
        const conflictingVote = await getSelfModerationVote(guildId, targetMessageId, otherType);
        
        if (conflictingVote && conflictingVote.status === 'active') {
            return conflictingVote;
        }
        
        return null;
        
    } catch (error) {
        console.error('检查冲突投票时出错:', error);
        return null;
    }
}

/**
 * 获取投票状态描述
 * @param {object} voteData - 投票数据
 * @returns {string} 状态描述
 */
function getVoteStatusDescription(voteData) {
    const { type, status, currentReactionCount, executed, executedActions } = voteData;
    const actionName = type === 'delete' ? '删除消息' : '禁言用户';
    
    if (status === 'completed') {
        if (executed) {
            return `✅ ${actionName}投票已完成并执行`;
        } else {
            return `⏰ ${actionName}投票已完成但未达到执行条件`;
        }
    } else if (status === 'active') {
        return `🗳️ ${actionName}投票进行中 (当前⚠️数量: ${currentReactionCount})`;
    } else {
        return `❓ 投票状态未知`;
    }
}

/**
 * 格式化投票信息
 * @param {object} voteData - 投票数据
 * @returns {string} 格式化的投票信息
 */
function formatVoteInfo(voteData) {
    const { type, initiators, startTime, endTime, targetMessageUrl } = voteData;
    const actionName = type === 'delete' ? '删除搬屎消息' : '禁言搬屎用户';
    const initiatorsText = initiators.map(id => `<@${id}>`).join(', ');
    
    const startTimestamp = Math.floor(new Date(startTime).getTime() / 1000);
    const endTimestamp = Math.floor(new Date(endTime).getTime() / 1000);
    
    return `**${actionName}**\n` +
           `发起人: ${initiatorsText}\n` +
           `目标消息: ${targetMessageUrl}\n` +
           `开始时间: <t:${startTimestamp}:f>\n` +
           `结束时间: <t:${endTimestamp}:f>`;
}

module.exports = {
    createOrMergeVote,
    checkConflictingVote,
    getVoteStatusDescription,
    formatVoteInfo
};