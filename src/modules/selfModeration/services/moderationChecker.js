// src\modules\selfModeration\services\moderationChecker.js
const { getAllSelfModerationVotes, updateSelfModerationVote, deleteSelfModerationVote } = require('../../../core/utils/database');
const { getCheckIntervals } = require('../../../core/config/timeconfig');
const { batchCheckReactions, checkReactionThreshold } = require('./reactionTracker');
const { executeDeleteMessage, executeMuteUser, checkAndDeleteUserMessage } = require('./punishmentExecutor');
const { EmbedBuilder } = require('discord.js');
const { formatMessageLink } = require('../utils/messageParser'); 

/**
 * 检查所有活跃的自助管理投票
 * @param {Client} client - Discord客户端
 */
async function checkActiveModerationVotes(client) {
    try {
        console.log(`\n=== 开始检查自助管理投票 ===`);
        const checkStartTime = new Date();
        console.log(`检查时间: ${checkStartTime.toISOString()}`);
        
        const allVotes = await getAllSelfModerationVotes();
        const activeVotes = Object.values(allVotes).filter(vote => vote.status === 'active');
        
        console.log(`找到 ${activeVotes.length} 个活跃的投票`);
        
        if (activeVotes.length === 0) {
            console.log(`=== 自助管理投票检查完成（无活跃投票） ===\n`);
            return;
        }
        
        // 批量检查反应数量
        const updatedVotes = await batchCheckReactions(client, activeVotes);
        
        // 处理每个投票
        for (const vote of updatedVotes) {
            await processIndividualVote(client, vote);
        }
        
        console.log(`=== 自助管理投票检查完成 ===\n`);
        
    } catch (error) {
        console.error('检查自助管理投票时出错:', error);
    }
}

/**
 * 处理单个投票
 * @param {Client} client - Discord客户端
 * @param {object} vote - 投票数据
 */
async function processIndividualVote(client, vote) {
    try {
        const { guildId, targetMessageId, type, endTime, currentReactionCount, executed, targetMessageExists } = vote;
        const now = new Date();
        const voteEndTime = new Date(endTime);
        
        // 检查是否过期
        const isExpired = now >= voteEndTime;
        
        // 如果是删除投票且目标消息不存在，直接标记为完成
        if (type === 'delete' && targetMessageExists === false) {
            console.log(`删除投票 ${guildId}_${targetMessageId} 的目标消息已不存在，标记为完成`);
            await updateSelfModerationVote(guildId, targetMessageId, type, {
                status: 'completed',
                completedAt: new Date().toISOString(),
                completionReason: 'target_message_deleted'
            });
            
            // 发送消息已被删除的通知
            await editVoteAnnouncementToTargetDeleted(client, vote);
            return;
        }
        
        // 检查是否达到执行阈值
        const thresholdCheck = checkReactionThreshold(currentReactionCount, type);
        
        console.log(`处理投票: ${guildId}_${targetMessageId}_${type}`);
        console.log(`- 反应数量: ${currentReactionCount}`);
        console.log(`- 是否过期: ${isExpired}`);
        console.log(`- 是否达到阈值: ${thresholdCheck.reached}`);
        console.log(`- 是否已执行: ${executed}`);
        console.log(`- 目标消息存在: ${targetMessageExists}`);
        
        // 如果达到阈值且未执行过，执行惩罚
        if (thresholdCheck.reached && !executed) {
            await executePunishment(client, vote);
        }
        // 如果投票过期，处理过期逻辑
        else if (isExpired) {
            await handleExpiredVote(client, vote);
        }
        
    } catch (error) {
        console.error(`处理投票 ${vote.guildId}_${vote.targetMessageId}_${vote.type} 时出错:`, error);
    }
}

/**
 * 发送目标消息已被删除的通知
 * @param {Client} client - Discord客户端
 * @param {object} vote - 投票数据
 */
/**
 * 编辑投票公告为目标消息已删除通知
 * @param {Client} client - Discord客户端
 * @param {object} vote - 投票数据
 */
async function editVoteAnnouncementToTargetDeleted(client, vote) {
    try {
        const { 
            channelId, 
            type, 
            targetMessageUrl, 
            currentReactionCount, 
            voteAnnouncementMessageId,
            voteAnnouncementChannelId,
            initiatorId,
            targetUserId
        } = vote;
        
        // 只有删除消息投票才需要这个通知
        if (type !== 'delete') return;
        
        // 获取投票公告所在的频道
        const announcementChannel = await client.channels.fetch(voteAnnouncementChannelId || channelId);
        if (!announcementChannel) return;
        
        // 获取投票公告消息
        if (!voteAnnouncementMessageId) {
            console.log('没有找到投票公告消息ID，无法编辑');
            return;
        }
        
        const announcementMessage = await announcementChannel.messages.fetch(voteAnnouncementMessageId);
        if (!announcementMessage) {
            console.log('投票公告消息不存在，无法编辑');
            return;
        }
        
        let description = `**删除消息**投票的目标消息已被提前删除，投票自动结束。\n\n**原目标消息：** ${formatMessageLink(targetMessageUrl)}\n**消息作者：** <@${targetUserId}>\n**发起人：** <@${initiatorId}>\n**最终⚠️数量：** ${currentReactionCount}（去重后）\n**状态：** 目标已删除，投票终止`;
        
        description += `\n\n💡 反应统计包含目标消息和投票公告的所有⚠️反应（同一用户只计算一次）`;
        
        const embed = new EmbedBuilder()
            .setTitle('📝 目标消息已被删除')
            .setDescription(description)
            .setColor('#808080')
            .setTimestamp()
            .setFooter({
                text: '投票因目标消息被删除而终止'
            });
        
        // 编辑原投票公告消息
        await announcementMessage.edit({ embeds: [embed] });
        console.log(`已编辑投票公告消息 ${voteAnnouncementMessageId} 为目标消息删除通知`);
        
    } catch (error) {
        console.error('编辑投票公告为目标删除通知时出错:', error);
    }
}

/**
 * 执行惩罚
 * @param {Client} client - Discord客户端
 * @param {object} vote - 投票数据
 */
async function executePunishment(client, vote) {
    try {
        const { guildId, targetMessageId, type, channelId } = vote;
        
        let result;
        if (type === 'delete') {
            result = await executeDeleteMessage(client, vote);
        } else if (type === 'mute') {
            result = await executeMuteUser(client, vote);
        }
        
        // 发送执行结果通知
        if (result) {
            await sendPunishmentNotification(client, vote, result);
        }
        
    } catch (error) {
        console.error(`执行惩罚时出错:`, error);
    }
}

/**
 * 处理过期的投票
 * @param {Client} client - Discord客户端
 * @param {object} vote - 投票数据
 */
async function handleExpiredVote(client, vote) {
    try {
        const { guildId, targetMessageId, type, channelId, currentReactionCount, executed } = vote;
        
        // 更新投票状态为已完成
        await updateSelfModerationVote(guildId, targetMessageId, type, {
            status: 'completed',
            completedAt: new Date().toISOString()
        });
        
        // 发送投票结束通知
        await editVoteAnnouncementToExpired(client, vote); // 重新启用时，取消注释这行：
        
        // 如果是禁言投票且已执行过禁言，需要删除用户消息
        if (type === 'mute' && executed) {
            setTimeout(() => {
                checkAndDeleteUserMessage(client, vote);
            }, 5000); // 延迟5秒删除消息
        }
        
        console.log(`投票 ${guildId}_${targetMessageId}_${type} 已过期`);
        
    } catch (error) {
        console.error(`处理过期投票时出错:`, error);
    }
}

/**
 * 发送惩罚执行通知
 * @param {Client} client - Discord客户端
 * @param {object} vote - 投票数据
 * @param {object} result - 执行结果
 */
async function sendPunishmentNotification(client, vote, result) {
    try {
        const { channelId, type, currentReactionCount, targetMessageUrl, voteAnnouncementMessageId } = vote;
        const channel = await client.channels.fetch(channelId);
        if (!channel) return;
        
        let embed;
        if (type === 'delete' && result.success) {
            let description = `由于⚠️反应数量达到 **${currentReactionCount}** 个（去重后），以下消息已被删除：\n\n**原消息链接：** ${targetMessageUrl}\n**消息作者：** <@${result.messageInfo.authorId}>\n**执行时间：** <t:${Math.floor(Date.now() / 1000)}:f>`;
            
            if (voteAnnouncementMessageId) {
                description += `\n\n💡 反应统计包含目标消息和投票公告的所有⚠️反应（同一用户只计算一次）`;
            }
            
            embed = new EmbedBuilder()
                .setTitle('🗑️ 搬屎消息已删除')
                .setDescription(description)
                .setColor('#FF0000')
                .setTimestamp();
        } else if (type === 'mute' && result.success) {
            let description;
            if (result.alreadyMuted) {
                description = `<@${result.userId}> 已经被禁言，当前禁言时长：**${result.currentDuration}**\n\n⚠️反应数量：${currentReactionCount}（去重后）`;
            } else {
                const endTimestamp = Math.floor(result.endTime.getTime() / 1000);
                description = `由于⚠️反应数量达到 **${currentReactionCount}** 个（去重后），<@${result.userId}> 已在此频道被禁言：\n\n**禁言时长：** ${result.additionalDuration}\n**总禁言时长：** ${result.totalDuration}\n**解禁时间：** <t:${endTimestamp}:f>\n**目标消息：** ${targetMessageUrl}`;
            }
            
            if (voteAnnouncementMessageId) {
                description += `\n\n💡 反应统计包含目标消息和投票公告的所有⚠️反应（同一用户只计算一次）`;
            }
            
            embed = new EmbedBuilder()
                .setTitle(result.alreadyMuted ? '🔇 用户已处于禁言状态' : '🔇 搬屎用户已被禁言')
                .setDescription(description)
                .setColor(result.alreadyMuted ? '#FFA500' : '#FF8C00')
                .setTimestamp();
        } else {
            // 执行失败
            embed = new EmbedBuilder()
                .setTitle('❌ 惩罚执行失败')
                .setDescription(`执行${type === 'delete' ? '删除消息' : '禁言用户'}时出现错误：\n\`\`\`${result.error}\`\`\``)
                .setColor('#8B0000')
                .setTimestamp();
        }
        
        await channel.send({ embeds: [embed] });
        
    } catch (error) {
        console.error('发送惩罚通知时出错:', error);
    }
}

/**
 * 发送投票过期通知
 * @param {Client} client - Discord客户端
 * @param {object} vote - 投票数据
 */
async function editVoteAnnouncementToExpired(client, vote) {
    try {
        const { 
            channelId, 
            type, 
            currentReactionCount, 
            targetMessageUrl, 
            voteAnnouncementMessageId,
            voteAnnouncementChannelId,
            initiatorId,
            targetUserId
        } = vote;
        
        // 获取投票公告所在的频道
        const announcementChannel = await client.channels.fetch(voteAnnouncementChannelId || channelId);
        if (!announcementChannel) return;
        
        // 获取投票公告消息
        if (!voteAnnouncementMessageId) {
            console.log('没有找到投票公告消息ID，无法编辑');
            return;
        }
        
        const announcementMessage = await announcementChannel.messages.fetch(voteAnnouncementMessageId);
        if (!announcementMessage) {
            console.log('投票公告消息不存在，无法编辑');
            return;
        }
        
        const actionName = type === 'delete' ? '删除消息' : '禁言用户';
        const thresholdCheck = checkReactionThreshold(currentReactionCount, type);
        
        let description = `**${actionName}**投票已结束\n\n**目标消息：** ${formatMessageLink(targetMessageUrl)}\n**消息作者：** <@${targetUserId}>\n**发起人：** <@${initiatorId}>\n**最终⚠️数量：** ${currentReactionCount}（去重后）\n**所需数量：** ${thresholdCheck.threshold}\n\n${currentReactionCount >= thresholdCheck.threshold ? '✅ 已达到执行条件并执行' : '❌ 未达到执行条件，投票结束'}`;
        
        description += `\n\n💡 反应统计包含目标消息和投票公告的所有⚠️反应（同一用户只计算一次）`;
        
        const embed = new EmbedBuilder()
            .setTitle('⏰ 投票时间已结束')
            .setDescription(description)
            .setColor(currentReactionCount >= thresholdCheck.threshold ? '#00FF00' : '#808080')
            .setTimestamp()
            .setFooter({
                text: '投票已结束'
            });
        
        // 编辑原投票公告消息
        await announcementMessage.edit({ embeds: [embed] });
        console.log(`已编辑投票公告消息 ${voteAnnouncementMessageId} 为投票结束通知`);
        
    } catch (error) {
        console.error('编辑投票公告为过期通知时出错:', error);
    }
}

/**
 * 启动自助管理检查器
 * @param {Client} client - Discord客户端
 */
function startSelfModerationChecker(client) {
    console.log('启动自助管理检查器...');
    
    // 立即进行一次检查
    checkActiveModerationVotes(client);
    
    const intervals = getCheckIntervals();
    setInterval(() => {
        checkActiveModerationVotes(client);
    }, intervals.selfModerationCheck);
}

module.exports = {
    startSelfModerationChecker,
    checkActiveModerationVotes
};