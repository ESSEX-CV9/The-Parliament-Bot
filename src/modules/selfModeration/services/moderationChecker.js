// src\modules\selfModeration\services\moderationChecker.js
const { getAllSelfModerationVotes, updateSelfModerationVote, deleteSelfModerationVote } = require('../../../core/utils/database');
const { getCheckIntervals, MUTE_DURATIONS, SERIOUS_MUTE_STABILITY_CONFIG, getSeriousMuteTotalDurationMinutes } = require('../../../core/config/timeconfig');
const { batchCheckReactions, checkReactionThreshold } = require('./reactionTracker');
const { executeDeleteMessage, executeMuteUser, checkAndDeleteUserMessage, getCurrentMuteDuration } = require('./punishmentExecutor');
const { EmbedBuilder } = require('discord.js');
const { formatMessageLink } = require('../utils/messageParser');
const { deleteMessageAfterVoteEnd } = require('./punishmentExecutor');
const { calculateLinearMuteDuration, isDayTime, LINEAR_MUTE_CONFIG } = require('../../../core/config/timeconfig');
const { formatDuration } = require('../utils/timeCalculator');
const { startMuteStatusChecker } = require('./muteStatusChecker');
const { getRecentSeriousMuteCount, appendSeriousMuteEvent } = require('./seriousMuteHistory');

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
            // 检查是否需要更新通知（票数有变化的禁言投票）
            const originalVote = activeVotes.find(v => 
                v.guildId === vote.guildId && 
                v.targetMessageId === vote.targetMessageId && 
                v.type === vote.type
            );
            
            const shouldUpdateNotification = originalVote && 
                originalVote.currentReactionCount !== vote.currentReactionCount &&
                (vote.type === 'mute' || vote.type === 'serious_mute');
            
            if (shouldUpdateNotification) {
                await updateMuteNotification(client, vote);
            }
            
            await processIndividualVote(client, vote);
        }
        
        console.log(`=== 自助管理投票检查完成 ===\n`);
        
    } catch (error) {
        console.error('检查自助管理投票时出错:', error);
    }
}

/**
 * 更新禁言投票的实时通知
 * @param {Client} client - Discord客户端
 * @param {object} voteData - 投票数据
 */
async function updateMuteNotification(client, voteData) {
    try {
        const { 
            voteAnnouncementMessageId, 
            voteAnnouncementChannelId, 
            currentReactionCount,
            type,
            targetUserId,
            initiatorId,
            targetMessageUrl,
            endTime,
            executed
        } = voteData;
        
        // 只更新禁言相关的投票（不包括严肃禁言，它有自己的显示逻辑）
        if (type !== 'mute' || !voteAnnouncementMessageId || !voteAnnouncementChannelId) {
            return;
        }
        
        const channel = await client.channels.fetch(voteAnnouncementChannelId);
        if (!channel) return;
        
        const message = await channel.messages.fetch(voteAnnouncementMessageId);
        if (!message || !message.embeds[0]) return;
        
        // 计算当前应有的总禁言时长
        const isNight = isDayTime() === false;
        const muteInfo = calculateLinearMuteDuration(currentReactionCount, isNight);
        const endTimestamp = Math.floor(new Date(endTime).getTime() / 1000);
        
        // 构建更新的执行条件文本
        const baseThreshold = muteInfo.threshold;
        const executionCondition = `${baseThreshold}个🚫开始禁言(${LINEAR_MUTE_CONFIG.BASE_DURATION}分钟)，${baseThreshold}个🚫后每票+${LINEAR_MUTE_CONFIG.ADDITIONAL_MINUTES_PER_VOTE}分钟`;
        
        // 构建描述文本
        let description = `有用户发起了禁言搬屎用户投票，请大家前往目标消息添加🚫反应来表达支持，**或者直接对本消息添加🚫反应**。\n\n`;
        description += `**目标消息：** ${formatMessageLink(targetMessageUrl)}\n`;
        description += `**消息作者：** <@${targetUserId}>\n`;
        description += `**发起人：** <@${initiatorId}>\n`;
        description += `**投票结束时间：** <t:${endTimestamp}:f>\n`;
        description += `**当前🚫数量：** ${currentReactionCount}\n`;
        description += `**执行条件：** ${executionCondition}`;
        
        // 如果已经开始禁言，显示当前总禁言时长
        if (muteInfo.shouldMute) {
            description += `\n\n**当前总禁言时长：** ${formatDuration(muteInfo.duration)}`;
            // 只有在已执行禁言时才显示解禁时间和执行状态
            if (executed) {
                // 如果已执行，从投票数据中获取最后执行时间，如果没有则用当前时间
                let muteStartTime = Date.now();
                if (voteData.lastExecuted) {
                    muteStartTime = new Date(voteData.lastExecuted).getTime();
                } else if (voteData.executedActions && voteData.executedActions.length > 0) {
                    // 找到最近的禁言执行动作
                    const lastMuteAction = voteData.executedActions
                        .filter(action => action.type === 'mute')
                        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
                    if (lastMuteAction) {
                        muteStartTime = new Date(lastMuteAction.timestamp).getTime();
                    }
                }
                
                // 计算解禁时间：禁言开始时间 + 总禁言时长
                const muteEndTime = new Date(muteStartTime + muteInfo.duration * 60 * 1000);
                const muteEndTimestamp = Math.floor(muteEndTime.getTime() / 1000);
                description += `\n**解禁时间：** <t:${muteEndTimestamp}:f> ✅ (已执行禁言)`;
            }
        }
        
        // 更新嵌入消息
        const updatedEmbed = EmbedBuilder.from(message.embeds[0])
            .setDescription(description);
        
        await message.edit({ embeds: [updatedEmbed] });
        console.log(`已更新禁言投票通知 ${voteAnnouncementMessageId}，当前票数: ${currentReactionCount}`);
        
    } catch (error) {
        console.error('更新禁言通知时出错:', error);
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
        
        // 严肃禁言投票：≥5 立即删除目标消息（在阈值判定之前执行）
        try {
            const executedActions = Array.isArray(vote.executedActions) ? vote.executedActions : [];
            const alreadyDeleteNow = executedActions.some(a => a && a.action === 'delete_now');
            const dedupCount = (vote.currentReactionCount ?? vote.reactionCount ?? vote.deduplicatedCount ?? 0);
            if (type === 'serious_mute' && vote.earlyDelete === true && dedupCount >= 5 && !alreadyDeleteNow) {
                const { deleteMessageImmediately } = require('./punishmentExecutor');
                const delRes = await deleteMessageImmediately(client, vote);
                if (delRes && delRes.success) {
                    const newExecutedActions = [...executedActions, { action: 'delete_now', at: Date.now() }];
                    await updateSelfModerationVote(guildId, targetMessageId, type, {
                        executedActions: newExecutedActions,
                        lastExecuted: new Date().toISOString()
                    });
                    console.log(`已在严肃禁言投票中立即删除目标消息 ${targetMessageId}，并记录 executedActions.delete_now`);
                } else {
                    console.warn(`严肃禁言投票立即删除失败: ${targetMessageId} - ${delRes && delRes.error ? delRes.error : '未知原因'}`);
                }
            }
        } catch (immediateErr) {
            console.error('处理严肃禁言投票即时删除时出错:', immediateErr);
        }
        
        // 检查是否达到执行阈值
        const thresholdCheck = checkReactionThreshold(currentReactionCount, type);
        
        console.log(`处理投票: ${guildId}_${targetMessageId}_${type}`);
        console.log(`- 反应数量: ${currentReactionCount}`);
        console.log(`- 是否过期: ${isExpired}`);
        console.log(`- 是否达到阈值: ${thresholdCheck.reached}`);
        console.log(`- 是否已执行: ${executed}`);
        console.log(`- 目标消息存在: ${targetMessageExists}`);
        
        // 优先检查投票是否过期
        if (isExpired) {
            await handleExpiredVote(client, vote);
        }
        // 如果未过期但达到阈值，执行或追加惩罚
        else if (thresholdCheck.reached) {
            await executePunishment(client, vote);
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
        } else if (type === 'mute' || type === 'serious_mute') {
            // serious_mute 复用禁言执行链路
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
        const { guildId, targetMessageId, type, channelId, currentReactionCount, executed, targetUserId } = vote;
        
        let deleteResult = null;
        let jumpResult = null; // 跳跃机制结果
        
        // 如果是禁言投票（含严肃禁言），检查消息是否已在禁言开始时被删除
        if (type === 'mute' || type === 'serious_mute') {
            // 检查是否达到禁言阈值
            const thresholdCheck = checkReactionThreshold(currentReactionCount, type);
            
            if (thresholdCheck.reached) {
                // 🔥 严肃禁言投票结束时的跳跃机制
                if (type === 'serious_mute' && executed) {
                    jumpResult = await handleSeriousMuteJumpOnExpire(client, vote);
                }
                
                // 检查是否已经在禁言开始时删除了消息
                if (vote.messageDeletedOnMuteStart) {
                    console.log(`禁言投票结束，消息已在禁言开始时被删除: ${targetMessageId}`);
                    deleteResult = {
                        success: true,
                        alreadyDeleted: true,
                        archived: vote.messageArchived || false,
                        deletedOnMuteStart: true
                    };
                } else {
                    console.log(`禁言投票结束且达到阈值，但消息未在禁言开始时删除，现在删除: ${targetMessageId}`);
                    deleteResult = await deleteMessageAfterVoteEnd(client, vote);
                }
            } else {
                console.log(`禁言投票结束但未达到阈值 (${currentReactionCount} < ${thresholdCheck.threshold})，不删除消息: ${targetMessageId}`);
            }
        }
        
        // 更新投票状态为已完成
        await updateSelfModerationVote(guildId, targetMessageId, type, {
            status: 'completed',
            completedAt: new Date().toISOString()
        });
        
        // 发送投票结束通知（编辑原始公告，包含删除结果和跳跃结果）
        await editVoteAnnouncementToExpired(client, vote, deleteResult, jumpResult);
        
        console.log(`投票 ${guildId}_${targetMessageId}_${type} 已过期`);
        
    } catch (error) {
        console.error(`处理过期投票时出错:`, error);
    }
}

/**
 * 处理严肃禁言投票结束时的跳跃机制
 * @param {Client} client - Discord客户端
 * @param {object} vote - 投票数据
 * @returns {object|null} 跳跃结果
 */
async function handleSeriousMuteJumpOnExpire(client, vote) {
    try {
        const { guildId, targetMessageId, targetUserId, currentReactionCount, executedActions = [], muteEndTime, muteChannelId } = vote;
        
        // 获取基础配置
        const base0 = MUTE_DURATIONS.LEVEL_1.threshold;
        const frozenBase = (typeof vote.seriousBase === 'number') ? vote.seriousBase : Math.ceil(base0 * 1.5);
        const minBase = (SERIOUS_MUTE_STABILITY_CONFIG && typeof SERIOUS_MUTE_STABILITY_CONFIG.MIN_BASE === 'number')
            ? SERIOUS_MUTE_STABILITY_CONFIG.MIN_BASE : 5;
        const base = Math.max(frozenBase, minBase);
        
        // 获取当前投票的 voteId
        const currentVoteId = vote.id || `${guildId}:${targetMessageId}`;
        
        // 获取历史次数（排除当前投票）
        const prev = (typeof vote.initialPrev === 'number')
            ? vote.initialPrev
            : await getRecentSeriousMuteCount(guildId, targetUserId, 15, currentVoteId);
        
        // 计算最终的 multiplier（基于投票结束时的总票数）
        const finalMultiplier = Math.max(1, Math.floor(currentReactionCount / base));
        
        // 如果 multiplier 为 1，无需跳跃
        if (finalMultiplier <= 1) {
            console.log(`[SeriousMute] 投票结束，票数${currentReactionCount}，multiplier=${finalMultiplier}，无需跳跃`);
            return null;
        }
        
        // 计算新的 levelIndex
        const newLevelIndex = prev + finalMultiplier;
        const newTotalMinutes = getSeriousMuteTotalDurationMinutes(newLevelIndex);
        
        // 获取当前已执行的禁言时长
        const currentExecutedMinutes = getCurrentMuteDuration(executedActions);
        
        // 如果新的总时长不大于当前已执行的时长，无需跳跃
        if (newTotalMinutes <= currentExecutedMinutes) {
            console.log(`[SeriousMute] 投票结束，新目标${newTotalMinutes}分钟不大于当前${currentExecutedMinutes}分钟，无需跳跃`);
            return null;
        }
        
        // 计算需要追加的时长
        const additionalMinutes = newTotalMinutes - currentExecutedMinutes;
        
        console.log(`[SeriousMute] 投票结束跳跃：票数${currentReactionCount}，multiplier=${finalMultiplier}，levelIndex=${newLevelIndex}，追加${additionalMinutes}分钟`);
        
        // 计算新的解禁时间
        let newMuteEndTime;
        const now = Date.now();
        if (muteEndTime) {
            const oldEndMs = new Date(muteEndTime).getTime();
            if (oldEndMs > now) {
                // 在原解禁时间基础上追加
                newMuteEndTime = new Date(oldEndMs + additionalMinutes * 60 * 1000);
            } else {
                // 原禁言已过期，从现在开始计算
                newMuteEndTime = new Date(now + newTotalMinutes * 60 * 1000);
            }
        } else {
            newMuteEndTime = new Date(now + newTotalMinutes * 60 * 1000);
        }
        
        // 更新权限（延长禁言）
        try {
            if (muteChannelId) {
                const guild = await client.guilds.fetch(guildId);
                const member = await guild.members.fetch(targetUserId);
                const permissionChannel = await client.channels.fetch(muteChannelId);
                
                if (permissionChannel && permissionChannel.permissionOverwrites) {
                    await permissionChannel.permissionOverwrites.create(member, {
                        SendMessages: false,
                        AddReactions: false,
                        CreatePublicThreads: false,
                        CreatePrivateThreads: false,
                        SendMessagesInThreads: false
                    });
                    console.log(`[SeriousMute] 已延长用户 ${targetUserId} 在频道 ${muteChannelId} 的禁言`);
                }
                
                // 更新定时器
                const timerKey = `${guildId}_${targetUserId}_${muteChannelId}_serious_mute`;
                if (global.muteTimers && global.muteTimers[timerKey]) {
                    clearTimeout(global.muteTimers[timerKey]);
                }

                if (!global.muteTimers) {
                    global.muteTimers = {};
                }

                const remainingTime = newMuteEndTime.getTime() - Date.now();
                global.muteTimers[timerKey] = setTimeout(async () => {
                    try {
                        // 检查是否还有普通禁言仍活跃，避免提前解除
                        const allVotesJump = await getAllSelfModerationVotes();
                        const nowJump = Date.now();
                        const otherMuteActiveJump = Object.values(allVotesJump).some(v =>
                            v.guildId === guildId &&
                            v.targetUserId === targetUserId &&
                            v.muteChannelId === muteChannelId &&
                            v.muteStatus === 'active' &&
                            v.type !== 'serious_mute' &&
                            v.muteEndTime &&
                            new Date(v.muteEndTime).getTime() > nowJump
                        );

                        if (!otherMuteActiveJump) {
                            await permissionChannel.permissionOverwrites.delete(member);
                            console.log(`[SeriousMute] 已解除用户 ${targetUserId} 在频道 ${muteChannelId} 的禁言（跳跃后）`);
                        } else {
                            console.log(`[SeriousMute] 用户 ${targetUserId} 仍有活跃的普通禁言，跳过权限删除（跳跃后）`);
                        }

                        await updateSelfModerationVote(guildId, targetMessageId, 'serious_mute', {
                            muteStatus: 'completed',
                            lastUnmuteAttempt: new Date().toISOString()
                        });

                        delete global.muteTimers[timerKey];
                    } catch (error) {
                        console.error('[SeriousMute] 解除跳跃后禁言时出错:', error);
                    }
                }, remainingTime);
            }
        } catch (permError) {
            console.error('[SeriousMute] 延长禁言权限时出错:', permError);
        }
        
        // 记录跳跃动作到 executedActions
        const jumpAction = {
            type: 'mute_jump',
            timestamp: new Date().toISOString(),
            previousDuration: currentExecutedMinutes,
            additionalDuration: additionalMinutes,
            totalDuration: newTotalMinutes,
            reactionCount: currentReactionCount,
            multiplier: finalMultiplier,
            level: `A1_${newLevelIndex}`,
            endTime: newMuteEndTime.toISOString()
        };
        
        const newExecutedActions = [...executedActions, jumpAction];
        
        // 更新投票记录
        await updateSelfModerationVote(guildId, targetMessageId, 'serious_mute', {
            executedActions: newExecutedActions,
            lastExecuted: new Date().toISOString(),
            muteEndTime: newMuteEndTime.toISOString(),
            lastTargetTotalMinutes: newTotalMinutes,
            jumpApplied: true,
            jumpMultiplier: finalMultiplier,
            jumpLevelIndex: newLevelIndex
        });
        
        // 更新历史记录中的 levelIndex（如果需要）
        try {
            // 历史记录中的 levelIndex 保持为首次写入时的值（prev + 1），跳跃信息记录在投票数据中
            console.log(`[SeriousMute] 跳跃完成：新 levelIndex=${newLevelIndex}，新解禁时间=${newMuteEndTime.toISOString()}`);
        } catch (historyError) {
            console.error('[SeriousMute] 更新历史记录时出错:', historyError);
        }
        
        // 更新禁言执行通知消息
        await updatePunishmentNotificationForJump(client, vote, {
            newTotalMinutes,
            newMuteEndTime,
            additionalMinutes,
            finalMultiplier,
            newLevelIndex
        });
        
        return {
            jumped: true,
            previousDuration: currentExecutedMinutes,
            newTotalDuration: newTotalMinutes,
            additionalMinutes,
            multiplier: finalMultiplier,
            newLevelIndex,
            newMuteEndTime
        };
        
    } catch (error) {
        console.error('[SeriousMute] 处理投票结束跳跃时出错:', error);
        return null;
    }
}

/**
 * 更新禁言执行通知消息以反映跳跃结果
 * @param {Client} client - Discord客户端
 * @param {object} vote - 投票数据
 * @param {object} jumpInfo - 跳跃信息
 */
async function updatePunishmentNotificationForJump(client, vote, jumpInfo) {
    try {
        const { punishmentNotificationMessageId, channelId } = vote;
        
        if (!punishmentNotificationMessageId) {
            console.log('[SeriousMute] 没有禁言通知消息ID，跳过更新');
            return;
        }
        
        const channel = await client.channels.fetch(channelId);
        if (!channel) return;
        
        const message = await channel.messages.fetch(punishmentNotificationMessageId);
        if (!message || !message.embeds[0]) return;
        
        const existingEmbed = message.embeds[0];
        let description = existingEmbed.description || '';
        
        // 更新总禁言时长
        description = description.replace(
            /\*\*总禁言时长：\*\* .+/,
            `**总禁言时长：** ${formatDuration(jumpInfo.newTotalMinutes)}`
        );
        
        // 更新解禁时间
        const endTimestamp = Math.floor(jumpInfo.newMuteEndTime.getTime() / 1000);
        description = description.replace(
            /\*\*解禁时间：\*\* <t:\d+:f>/,
            `**解禁时间：** <t:${endTimestamp}:f>`
        );
        
        // 添加跳跃说明
        if (!description.includes('票数跳跃')) {
            description += `\n\n**📈 票数跳跃：** 投票结束时票数达到 ${vote.currentReactionCount}，触发 ${jumpInfo.finalMultiplier}x 跳跃，追加 ${formatDuration(jumpInfo.additionalMinutes)}`;
        }
        
        const updatedEmbed = EmbedBuilder.from(existingEmbed)
            .setDescription(description);
        
        await message.edit({ embeds: [updatedEmbed] });
        console.log(`[SeriousMute] 已更新禁言通知消息以反映跳跃：追加${jumpInfo.additionalMinutes}分钟`);
        
    } catch (error) {
        console.error('[SeriousMute] 更新禁言通知消息时出错:', error);
    }
}

/**
 * 编辑投票公告为投票结束通知
 * @param {Client} client - Discord客户端
 * @param {object} vote - 投票数据
 * @param {object} deleteResult - 删除结果（禁言投票专用）
 * @param {object} jumpResult - 跳跃结果（严肃禁言专用）
 */
async function editVoteAnnouncementToExpired(client, vote, deleteResult = null, jumpResult = null) {
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
        
        // 🔥 如果是禁言/严肃禁言投票且有删除结果，添加消息删除状态
        if ((type === 'mute' || type === 'serious_mute') && deleteResult) {
            if (deleteResult.success && !deleteResult.alreadyDeleted) {
                description += `\n**消息状态：** ✅ 已删除`;
                if (deleteResult.archived) {
                    description += `\n**归档状态：** ✅ 已归档`;
                } else {
                    description += `\n**归档状态：** ❌ 未归档`;
                }
            } else if (deleteResult.alreadyDeleted) {
                description += `\n**消息状态：** ✅ 消息已不存在`;
            } else {
                description += `\n**消息状态：** ❌ 删除失败`;
            }
        }
        
        // 🔥 如果有跳跃结果，添加跳跃信息
        if (jumpResult && jumpResult.jumped) {
            description += `\n\n**📈 票数跳跃：** 触发 ${jumpResult.multiplier}x 跳跃`;
            description += `\n**最终禁言时长：** ${formatDuration(jumpResult.newTotalDuration)}`;
            const endTimestamp = Math.floor(jumpResult.newMuteEndTime.getTime() / 1000);
            description += `\n**新解禁时间：** <t:${endTimestamp}:f>`;
        }
        
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
 * 发送或更新惩罚执行通知
 * @param {Client} client - Discord客户端
 * @param {object} vote - 投票数据
 * @param {object} result - 执行结果
 */
async function sendPunishmentNotification(client, vote, result) {
    try {
        const { channelId, type, currentReactionCount, targetMessageUrl, voteAnnouncementMessageId, targetMessageExists, punishmentNotificationMessageId } = vote;
        const channel = await client.channels.fetch(channelId);
        if (!channel) return;
        
        let embed;
        if (type === 'delete' && result.success) {
            let description = `由于⚠️反应数量达到 **${currentReactionCount}** 个（去重后），以下消息已被删除：\n\n**原消息链接：** ${targetMessageUrl}\n**消息作者：** <@${result.messageInfo.authorId}>\n**执行时间：** <t:${Math.floor(Date.now() / 1000)}:f>`;
            
            // 添加归档状态信息
            if (result.archived) {
                description += `\n**归档状态：** ✅ 已归档`;
            } else {
                description += `\n**归档状态：** ❌ 未归档`;
            }
            
            if (voteAnnouncementMessageId) {
                description += `\n\n💡 反应统计包含目标消息和投票公告的所有⚠️反应（同一用户只计算一次）`;
            }
            
            embed = new EmbedBuilder()
                .setTitle('🗑️ 搬屎消息已删除')
                .setDescription(description)
                .setColor('#FF0000')
                .setTimestamp();
        } else if ((type === 'mute' || type === 'serious_mute') && result.success) {
            // 如果已经被禁言且不需要追加时长，跳过通知的发送和更新
            if (result.alreadyMuted) {
                console.log(`用户 ${result.userId} 已处于禁言状态且无需追加时长，跳过通知更新`);
                return; // 直接返回，不发送也不更新通知
            }
            
            // 🔥 如果是更新现有消息，使用增量更新方式保留原始信息
            if (punishmentNotificationMessageId) {
                try {
                    const existingMessage = await channel.messages.fetch(punishmentNotificationMessageId);
                    if (existingMessage && existingMessage.embeds[0]) {
                        // 使用增量更新：更新票数、总禁言时长和解禁时间
                        const endTimestamp = Math.floor(result.endTime.getTime() / 1000);
                        const existingEmbed = existingMessage.embeds[0];
                        let existingDescription = existingEmbed.description || '';

                        // 更新票数
                        existingDescription = existingDescription.replace(
                            /🚫反应数量达到 \*\*\d+\*\* 个（去重后）/,
                            `🚫反应数量达到 **${currentReactionCount}** 个（去重后）`
                        );

                        // 更新总禁言时长
                        existingDescription = existingDescription.replace(
                            /\*\*总禁言时长：\*\* .+/,
                            `**总禁言时长：** ${result.totalDuration}`
                        );

                        // 更新解禁时间
                        existingDescription = existingDescription.replace(
                            /\*\*解禁时间：\*\* <t:\d+:f>/,
                            `**解禁时间：** <t:${endTimestamp}:f>`
                        );
                        
                        // 使用 EmbedBuilder.from() 复制现有embed并更新描述
                        const updatedEmbed = EmbedBuilder.from(existingEmbed)
                            .setDescription(existingDescription);
                        
                        await existingMessage.edit({ embeds: [updatedEmbed] });
                        console.log(`已增量更新禁言执行通知消息 ${punishmentNotificationMessageId}，保留了原始信息`);
                        return; // 更新成功，直接返回
                    }
                } catch (error) {
                    console.error('增量更新禁言执行通知失败，将发送新消息:', error);
                }
            }
            
            // 首次发送消息：构建完整的embed
            let description;
            const endTimestamp = Math.floor(result.endTime.getTime() / 1000);
            description = `由于🚫反应数量达到 **${currentReactionCount}** 个（去重后），<@${result.userId}> 已在此频道被禁言：\n\n**总禁言时长：** ${result.totalDuration}\n**解禁时间：** <t:${endTimestamp}:f>\n**目标消息：** ${targetMessageUrl}`;
            
            // 显示消息删除状态（兼容提前删除与消息已不存在）
            if (result.isFirstTimeMute) {
                let messageStatusText = '';
                if (targetMessageExists === false) {
                    messageStatusText = '✅ 消息已被删除';
                } else if (result.messageDeleted) {
                    if (result.messageArchived) {
                        messageStatusText = '✅ 已删除 | ✅ 已归档';
                    } else if (!result.messageDeleteError) {
                        // 已删除但未归档，多为提前已被删或归档不可用
                        messageStatusText = '✅ 消息已被删除';
                    } else {
                        messageStatusText = `❌ 删除失败 (${result.messageDeleteError})`;
                    }
                } else {
                    if (result.messageDeleteError) {
                        messageStatusText = `❌ 删除失败 (${result.messageDeleteError})`;
                    } else {
                        messageStatusText = '❌ 删除失败';
                    }
                }
                description += `\n\n**消息处理：** ${messageStatusText}`;
            }
            
            if (voteAnnouncementMessageId) {
                description += `\n\n💡 反应统计包含目标消息和投票公告的所有🚫反应（同一用户只计算一次）`;
            }
            
            const successTitle = type === 'serious_mute'
                ? '🔇 严肃禁言已执行'
                : '🔇 搬屎用户已被禁言';
            
            embed = new EmbedBuilder()
                .setTitle(successTitle)
                .setDescription(description)
                .setColor('#FF8C00')
                .setTimestamp();
        } else {
            // 执行失败
            embed = new EmbedBuilder()
                .setTitle('❌ 惩罚执行失败')
                .setDescription(`执行${type === 'delete' ? '删除消息' : '禁言用户'}时出现错误：\n\`\`\`${result.error}\`\`\``)
                .setColor('#8B0000')
                .setTimestamp();
        }
        
        // 发送新消息
        const sentMessage = await channel.send({ embeds: [embed] });
        
        // 如果是禁言投票，保存通知消息ID
        if ((type === 'mute' || type === 'serious_mute') && sentMessage) {
            const { updateSelfModerationVote } = require('../../../core/utils/database');
            await updateSelfModerationVote(vote.guildId, vote.targetMessageId, type, {
                punishmentNotificationMessageId: sentMessage.id
            });
            console.log(`已保存禁言执行通知消息ID: ${sentMessage.id}`);
        }
        
    } catch (error) {
        console.error('发送惩罚通知时出错:', error);
    }
}

/**
 * 发送投票过期通知
 * @param {Client} client - Discord客户端
 * @param {object} vote - 投票数据
 */

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
    
    // 同时启动禁言状态检查器
    startMuteStatusChecker(client);
}

module.exports = {
    startSelfModerationChecker,
    checkActiveModerationVotes
};
