// src\modules\selfModeration\services\punishmentExecutor.js
const { updateSelfModerationVote } = require('../../../core/utils/database');
const { calculateAdditionalMuteDuration, formatDuration } = require('../utils/timeCalculator');
const { MUTE_DURATIONS } = require('../../../core/config/timeconfig');
const { archiveDeletedMessage } = require('./archiveService');
const { getRecentSeriousMuteCount, appendSeriousMuteEvent } = require('./seriousMuteHistory');

/**
 * 执行删除消息惩罚
 * @param {Client} client - Discord客户端
 * @param {object} voteData - 投票数据
 * @returns {object} 执行结果
 */
async function executeDeleteMessage(client, voteData) {
    try {
        const { guildId, targetChannelId, targetMessageId, currentReactionCount, targetMessageExists } = voteData;
        
        console.log(`开始执行删除消息: ${targetMessageId}, 反应数量: ${currentReactionCount}, 消息存在: ${targetMessageExists}`);
        
        // 如果目标消息不存在，标记为已完成但不执行删除
        if (targetMessageExists === false) {
            console.log(`目标消息 ${targetMessageId} 已不存在，跳过删除操作`);
            
            await updateSelfModerationVote(guildId, targetMessageId, 'delete', {
                status: 'completed',
                executed: false,
                executedAt: new Date().toISOString(),
                completionReason: 'target_message_already_deleted',
                executedActions: [{
                    type: 'delete',
                    timestamp: new Date().toISOString(),
                    reactionCount: currentReactionCount,
                    result: 'target_already_deleted'
                }]
            });
            
            return {
                success: true,
                action: 'delete',
                alreadyDeleted: true,
                reactionCount: currentReactionCount
            };
        }
        
        // 删除消息并归档
        const deleteResult = await deleteAndArchiveMessage(client, voteData);
        
        // 更新投票状态
        await updateSelfModerationVote(guildId, targetMessageId, 'delete', {
            status: 'completed',
            executed: deleteResult.success,
            executedAt: new Date().toISOString(),
            archived: deleteResult.archived,
            executedActions: [{
                type: 'delete',
                timestamp: new Date().toISOString(),
                reactionCount: currentReactionCount,
                messageInfo: deleteResult.messageInfo,
                archived: deleteResult.archived
            }]
        });
        
        return deleteResult;
        
    } catch (error) {
        console.error('执行删除消息时出错:', error);
        
        // 更新投票状态为失败
        try {
            await updateSelfModerationVote(voteData.guildId, voteData.targetMessageId, 'delete', {
                status: 'failed',
                error: error.message,
                failedAt: new Date().toISOString()
            });
        } catch (updateError) {
            console.error('更新失败状态时出错:', updateError);
        }
        
        return {
            success: false,
            action: 'delete',
            error: error.message
        };
    }
}

/**
 * 删除消息并归档的通用函数
 * @param {Client} client - Discord客户端
 * @param {object} voteData - 投票数据
 * @returns {object} 执行结果
 */
async function deleteAndArchiveMessage(client, voteData) {
    try {
        const { guildId, targetChannelId, targetMessageId, currentReactionCount } = voteData;
        
        // 获取频道和消息
        const channel = await client.channels.fetch(targetChannelId);
        if (!channel) {
            throw new Error(`找不到频道: ${targetChannelId}`);
        }
        
        const message = await channel.messages.fetch(targetMessageId);
        if (!message) {
            // 消息在执行过程中被删除了
            console.log(`消息 ${targetMessageId} 在执行过程中被删除`);
            return {
                success: true,
                action: 'delete',
                alreadyDeleted: true,
                reactionCount: currentReactionCount,
                archived: false
            };
        }
        
        // 在删除前先进行归档
        const messageInfo = {
            content: message.content,
            author: message.author.tag,
            authorId: message.author.id,
            messageId: message.id,
            url: `https://discord.com/channels/${guildId}/${targetChannelId}/${targetMessageId}`,
            attachments: message.attachments.map(att => ({
                name: att.name,
                url: att.url,
                size: att.size
            })),
            embeds: message.embeds
        };
        
        // 尝试归档消息
        let archiveResult = false;
        try {
            archiveResult = await archiveDeletedMessage(client, messageInfo, voteData);
            if (archiveResult) {
                console.log(`消息 ${targetMessageId} 已成功归档`);
            }
        } catch (archiveError) {
            console.error('归档消息失败，但继续执行删除:', archiveError);
        }
        
        // 删除消息前先检查消息是否还存在
        const messageStillExists = await channel.messages.fetch(targetMessageId).catch(() => null);
        if (!messageStillExists) {
            console.log(`消息 ${targetMessageId} 已被删除，跳过删除操作`);
            return {
                success: true,
                action: 'delete',
                alreadyDeleted: true,
                messageInfo,
                reactionCount: currentReactionCount,
                archived: archiveResult
            };
        }
        
        // 删除消息
        await messageStillExists.delete();
        console.log(`成功删除消息: ${targetMessageId}，归档状态: ${archiveResult}`);
        
        return {
            success: true,
            action: 'delete',
            messageInfo,
            reactionCount: currentReactionCount,
            archived: archiveResult
        };
        
    } catch (error) {
        console.error('删除并归档消息时出错:', error);
        return {
            success: false,
            action: 'delete',
            error: error.message,
            archived: false
        };
    }
}

/**
 * 获取适合设置权限的频道
 * @param {Channel} channel - 原始频道
 * @returns {Channel|null} 可以设置权限的频道
 */
function getPermissionChannel(channel) {
    if (!channel) return null;
    
    // 如果频道支持权限覆盖，直接使用
    if (channel.permissionOverwrites) {
        console.log(`频道 ${channel.id} 支持权限覆盖`);
        return channel;
    }
    
    // 如果是线程，尝试使用父频道
    if (channel.isThread && channel.isThread() && channel.parent) {
        console.log(`频道 ${channel.id} 是线程，尝试使用父频道 ${channel.parent.id}`);
        if (channel.parent.permissionOverwrites) {
            console.log(`父频道 ${channel.parent.id} 支持权限覆盖`);
            return channel.parent;
        }
    }
    
    console.log(`频道 ${channel.id} 和其父频道都不支持权限覆盖`);
    return null;
}

/**
 * 执行禁言用户惩罚（只禁言，不删除消息）
 * @param {Client} client - Discord客户端
 * @param {object} voteData - 投票数据
 * @returns {object} 执行结果
 */
async function executeMuteUser(client, voteData) {
    try {
        const { guildId, targetChannelId, targetMessageId, targetUserId, currentReactionCount, executedActions = [], targetMessageExists } = voteData;
        
        console.log(`开始执行禁言用户: ${targetUserId}, 反应数量: ${currentReactionCount}, 目标消息存在: ${targetMessageExists}`);
        
        // 计算禁言时长
        const recordType = voteData.type || 'mute';

        let muteInfo;
        let effectiveReactionCount = currentReactionCount;

        if (recordType === 'serious_mute') {
            // 严肃禁言 A1 规则（仅在本函数内部计算时长，执行链路复用现有实现）
            const count = (voteData.currentReactionCount ?? voteData.reactionCount ?? voteData.deduplicatedCount ?? 0);
            const prev = await getRecentSeriousMuteCount(guildId, targetUserId);
            const base0 = MUTE_DURATIONS.LEVEL_1.threshold;
            const base = Math.ceil(base0 * 1.5);
            const multiplier = Math.max(1, Math.floor(count / base));
            const levelIndex = prev + multiplier;
            const table = [10, 20, 30, 60, 120, 240, 360, 480, 600];
            const targetTotalMinutes = levelIndex >= 10 ? 720 : table[levelIndex - 1];
            const currentExecuted = getCurrentMuteDuration(executedActions);
            const additional = Math.max(0, targetTotalMinutes - currentExecuted);

            effectiveReactionCount = count;

            if (additional <= 0) {
                console.log(`[SeriousMute] 用户 ${targetUserId} 无需追加禁言：已执行 ${currentExecuted} 分钟，目标 ${targetTotalMinutes} 分钟`);
                return {
                    success: true,
                    action: 'mute',
                    alreadyMuted: true,
                    currentDuration: formatDuration(currentExecuted),
                    reactionCount: count,
                    targetMessageExists
                };
            }

            muteInfo = {
                additionalDuration: additional,
                totalDuration: targetTotalMinutes,
                newLevel: `A1_${levelIndex}`,
                serious: { levelIndex }
            };
        } else {
            const currentMuteDuration = getCurrentMuteDuration(executedActions);
            const calc = calculateAdditionalMuteDuration(currentReactionCount, currentMuteDuration);

            if (calc.additionalDuration <= 0) {
                console.log(`用户 ${targetUserId} 不需要额外禁言时间`);
                return {
                    success: true,
                    action: 'mute',
                    alreadyMuted: true,
                    currentDuration: formatDuration(currentMuteDuration),
                    reactionCount: currentReactionCount,
                    targetMessageExists
                };
            }

            muteInfo = calc;
        }
        
        // 获取服务器和用户
        const guild = await client.guilds.fetch(guildId);
        if (!guild) {
            throw new Error(`找不到服务器: ${guildId}`);
        }
        
        const member = await guild.members.fetch(targetUserId);
        if (!member) {
            throw new Error(`找不到用户: ${targetUserId}`);
        }
        
        // 获取原始频道
        const originalChannel = await client.channels.fetch(targetChannelId);
        if (!originalChannel) {
            throw new Error(`找不到频道: ${targetChannelId}`);
        }
        
        // 获取适合设置权限的频道
        const permissionChannel = getPermissionChannel(originalChannel);
        if (!permissionChannel) {
            throw new Error(`频道 ${targetChannelId} (类型: ${originalChannel.type}) 不支持权限覆盖，父频道也不支持`);
        }
        
        console.log(`将在频道 ${permissionChannel.id} (类型: ${permissionChannel.type}) 设置权限`);
        
        // 执行频道级禁言（修改权限）
        const muteEndTime = new Date();
        muteEndTime.setMinutes(muteEndTime.getMinutes() + muteInfo.additionalDuration);
        
        // 设置频道权限，禁止用户发送消息
        await permissionChannel.permissionOverwrites.create(member, {
            SendMessages: false,
            AddReactions: false,
            CreatePublicThreads: false,
            CreatePrivateThreads: false,
            SendMessagesInThreads: false
        });
        
        console.log(`成功在频道 ${permissionChannel.id} 设置用户 ${targetUserId} 的禁言权限`);
        
        // 记录禁言信息
        const muteAction = {
            type: 'mute',
            timestamp: new Date().toISOString(),
            duration: muteInfo.additionalDuration,
            totalDuration: muteInfo.totalDuration,
            reactionCount: effectiveReactionCount,
            level: muteInfo.newLevel,
            endTime: muteEndTime.toISOString(),
            channelId: targetChannelId,
            permissionChannelId: permissionChannel.id,
            targetMessageExists
        };
        
        // 更新投票状态
        const newExecutedActions = [...executedActions, muteAction];
        await updateSelfModerationVote(guildId, targetMessageId, recordType, {
            executedActions: newExecutedActions,
            lastExecuted: new Date().toISOString(),
            executed: true
            // 注意：这里不设置 status: 'completed'，因为投票还没结束
        });

        // 严肃禁言：成功后写入历史事件（娱乐指令不写入）
        if (recordType === 'serious_mute') {
            try {
                const voteId = voteData.id || `${guildId}:${targetMessageId}`;
                const levelIndex = (muteInfo.serious && muteInfo.serious.levelIndex) ? muteInfo.serious.levelIndex : 1;
                await appendSeriousMuteEvent({
                    guildId,
                    userId: targetUserId,
                    channelId: permissionChannel.id,
                    voteId,
                    messageId: targetMessageId,
                    durationMinutes: muteInfo.totalDuration,
                    levelIndex,
                    executedAt: Date.now()
                });
            } catch (e) {
                console.error('[SeriousMuteHistory] 记录严肃禁言事件失败:', e);
            }
        }
        
        console.log(`成功禁言用户 ${targetUserId} ${muteInfo.additionalDuration}分钟`);
        
        // 设置定时器，到时间后解除禁言
        setTimeout(async () => {
            try {
                await permissionChannel.permissionOverwrites.delete(member);
                console.log(`已解除用户 ${targetUserId} 在频道 ${permissionChannel.id} 的禁言`);
            } catch (error) {
                console.error(`解除禁言时出错:`, error);
            }
        }, muteInfo.additionalDuration * 60 * 1000);
        
        return {
            success: true,
            action: 'mute',
            userId: targetUserId,
            additionalDuration: formatDuration(muteInfo.additionalDuration),
            totalDuration: formatDuration(muteInfo.totalDuration),
            level: muteInfo.newLevel,
            reactionCount: effectiveReactionCount,
            endTime: muteEndTime,
            targetMessageExists,
            permissionChannelId: permissionChannel.id
        };
        
    } catch (error) {
        console.error('执行禁言用户时出错:', error);
        
        // 更新投票状态为失败
        try {
            await updateSelfModerationVote(voteData.guildId, voteData.targetMessageId, 'mute', {
                status: 'failed',
                error: error.message,
                failedAt: new Date().toISOString()
            });
        } catch (updateError) {
            console.error('更新失败状态时出错:', updateError);
        }
        
        return {
            success: false,
            action: 'mute',
            error: error.message
        };
    }
}

/**
 * 获取当前已执行的禁言总时长
 * @param {Array} executedActions - 已执行的操作列表
 * @returns {number} 总禁言时长（分钟）
 */
function getCurrentMuteDuration(executedActions) {
    if (!executedActions || !Array.isArray(executedActions)) {
        return 0;
    }
    
    return executedActions
        .filter(action => action.type === 'mute')
        .reduce((total, action) => total + (action.duration || 0), 0);
}

/**
 * 延迟删除消息（当存在禁言投票时）
 * @param {Client} client - Discord客户端
 * @param {object} deleteVoteData - 删除投票数据
 * @param {object} muteVoteData - 禁言投票数据
 * @returns {Promise} 删除操作的Promise
 */
async function delayedDeleteMessage(client, deleteVoteData, muteVoteData) {
    return new Promise((resolve) => {
        const muteEndTime = new Date(muteVoteData.endTime);
        const now = new Date();
        const delay = Math.max(0, muteEndTime.getTime() - now.getTime());
        
        console.log(`延迟 ${delay}ms 后删除消息 ${deleteVoteData.targetMessageId}`);
        
        setTimeout(async () => {
            try {
                const result = await executeDeleteMessage(client, deleteVoteData);
                resolve(result);
            } catch (error) {
                console.error('延迟删除消息时出错:', error);
                resolve({
                    success: false,
                    action: 'delete',
                    error: error.message
                });
            }
        }, delay);
    });
}

/**
 * 投票结束后删除用户消息（禁言投票专用）
 * @param {Client} client - Discord客户端
 * @param {object} voteData - 投票数据
 * @returns {object} 删除结果
 */
async function deleteMessageAfterVoteEnd(client, voteData) {
    try {
        const { guildId, targetChannelId, targetMessageId, targetMessageExists } = voteData;
        
        console.log(`投票结束，开始删除消息: ${targetMessageId}, 消息存在: ${targetMessageExists}`);
        
        // 如果目标消息本来就不存在，不需要删除
        if (targetMessageExists === false) {
            console.log(`目标消息 ${targetMessageId} 本来就不存在，无需删除`);
            return {
                success: true,
                alreadyDeleted: true,
                archived: false
            };
        }
        
        // 使用通用的删除并归档函数
        const deleteResult = await deleteAndArchiveMessage(client, voteData);
        
        // 更新投票记录
        await updateSelfModerationVote(guildId, targetMessageId, 'mute', {
            messageDeleted: deleteResult.success,
            messageArchived: deleteResult.archived,
            messageDeletedAt: new Date().toISOString()
        });
        
        console.log(`投票结束后删除消息结果: 成功=${deleteResult.success}, 归档=${deleteResult.archived}`);
        return deleteResult;
        
    } catch (error) {
        console.error('投票结束后删除用户消息时出错:', error);
        return {
            success: false,
            error: error.message,
            archived: false
        };
    }
}
 
/**
 * 立即删除目标消息（严肃禁言投票专用）
 * 尽量复用 deleteMessageAfterVoteEnd 与 deleteAndArchiveMessage 的底层逻辑
 * 不在此处更新投票状态，避免打断后续流程；调用方在执行成功后自行记录 executedActions
 * @param {Client} client - Discord客户端
 * @param {object} voteData - 投票数据
 * @returns {object} 删除结果 { success: boolean, alreadyDeleted?: boolean, archived?: boolean, error?: string }
 */
async function deleteMessageImmediately(client, voteData) {
    try {
        const { targetMessageExists, targetMessageId } = voteData;
 
        console.log(`立即删除目标消息: ${targetMessageId}, 消息存在: ${targetMessageExists}`);
 
        // 如果目标消息本来就不存在，视为已删除
        if (targetMessageExists === false) {
            return {
                success: true,
                alreadyDeleted: true,
                archived: false
            };
        }
 
        // 复用通用删除+归档逻辑
        const deleteResult = await deleteAndArchiveMessage(client, voteData);
        return deleteResult;
 
    } catch (error) {
        console.error('立即删除目标消息时出错:', error);
        return {
            success: false,
            action: 'delete',
            error: error.message,
            archived: false
        };
    }
}
 
module.exports = {
    executeDeleteMessage,
    executeMuteUser,
    delayedDeleteMessage,
    deleteMessageAfterVoteEnd, // 新增导出
    getCurrentMuteDuration,
    deleteAndArchiveMessage,
    deleteMessageImmediately
};