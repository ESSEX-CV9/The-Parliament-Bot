// src/modules/selfModeration/services/muteStatusChecker.js
const { getAllSelfModerationVotes, updateSelfModerationVote } = require('../../../core/utils/database');
const { getCheckIntervals, MUTE_STATUS_CHECK_CONFIG } = require('../../../core/config/timeconfig');

/**
 * 检查所有活跃的禁言状态并尝试解封到期的用户
 * @param {Client} client - Discord客户端
 */
async function checkActiveMuteStatus(client) {
    try {
        console.log(`\n=== 开始检查禁言状态 ===`);
        const checkStartTime = new Date();
        console.log(`检查时间: ${checkStartTime.toISOString()}`);
        
        const allVotes = await getAllSelfModerationVotes();
        
        // 筛选出所有禁言状态为 'active' 的投票
        const activeMutes = Object.values(allVotes).filter(vote => 
            vote.muteStatus === 'active' && 
            vote.muteEndTime && 
            vote.muteChannelId &&
            vote.targetUserId
        );
        
        console.log(`找到 ${activeMutes.length} 个活跃的禁言记录`);
        
        if (activeMutes.length === 0) {
            console.log(`=== 禁言状态检查完成（无活跃禁言） ===\n`);
            return;
        }
        
        const now = Date.now();
        let processedCount = 0;
        let unmuteSuccessCount = 0;
        let unmuteFailedCount = 0;
        let notYetDueCount = 0;
        
        // 处理每个禁言记录
        for (const vote of activeMutes) {
            try {
                const muteEndTime = new Date(vote.muteEndTime).getTime();
                const isExpired = now >= muteEndTime;
                
                console.log(`\n检查禁言记录: ${vote.guildId}_${vote.targetMessageId}_${vote.type}`);
                console.log(`- 用户ID: ${vote.targetUserId}`);
                console.log(`- 禁言频道: ${vote.muteChannelId}`);
                console.log(`- 解禁时间: ${vote.muteEndTime}`);
                console.log(`- 是否到期: ${isExpired}`);
                console.log(`- 已尝试次数: ${vote.unmuteAttempts || 0}`);
                
                if (!isExpired) {
                    const remainingMinutes = Math.ceil((muteEndTime - now) / 1000 / 60);
                    console.log(`- 状态: 未到期，剩余 ${remainingMinutes} 分钟`);
                    notYetDueCount++;
                    continue;
                }
                
                // 检查是否超过最大重试次数
                const attempts = vote.unmuteAttempts || 0;
                if (attempts >= MUTE_STATUS_CHECK_CONFIG.MAX_UNMUTE_ATTEMPTS) {
                    console.log(`- 状态: 已达到最大重试次数 (${attempts}/${MUTE_STATUS_CHECK_CONFIG.MAX_UNMUTE_ATTEMPTS})，跳过`);
                    unmuteFailedCount++;
                    continue;
                }
                
                // 尝试解封
                const unmuteResult = await attemptUnmute(client, vote);
                processedCount++;
                
                if (unmuteResult.success) {
                    unmuteSuccessCount++;
                    console.log(`✅ 解封成功`);
                } else {
                    unmuteFailedCount++;
                    console.log(`❌ 解封失败: ${unmuteResult.error}`);
                }
                
            } catch (error) {
                console.error(`处理禁言记录 ${vote.guildId}_${vote.targetMessageId} 时出错:`, error);
                unmuteFailedCount++;
            }
        }
        
        console.log(`\n=== 禁言状态检查完成 ===`);
        console.log(`总计: ${activeMutes.length} 个活跃禁言`);
        console.log(`未到期: ${notYetDueCount} 个`);
        console.log(`已处理: ${processedCount} 个`);
        console.log(`解封成功: ${unmuteSuccessCount} 个`);
        console.log(`解封失败: ${unmuteFailedCount} 个`);
        console.log(`===============================\n`);
        
    } catch (error) {
        console.error('检查禁言状态时出错:', error);
    }
}

/**
 * 尝试解除用户的禁言
 * @param {Client} client - Discord客户端
 * @param {object} voteData - 投票数据
 * @returns {object} {success: boolean, error?: string, verified?: boolean}
 */
async function attemptUnmute(client, voteData) {
    const { guildId, targetUserId, muteChannelId, targetMessageId, type, unmuteAttempts = 0 } = voteData;
    
    try {
        // 获取服务器
        const guild = await client.guilds.fetch(guildId);
        if (!guild) {
            throw new Error(`找不到服务器: ${guildId}`);
        }
        
        // 获取用户
        const member = await guild.members.fetch(targetUserId);
        if (!member) {
            throw new Error(`找不到用户: ${targetUserId}`);
        }
        
        // 获取频道
        const channel = await client.channels.fetch(muteChannelId);
        if (!channel) {
            throw new Error(`找不到频道: ${muteChannelId}`);
        }
        
        // 检查频道是否支持权限覆盖
        if (!channel.permissionOverwrites) {
            throw new Error(`频道 ${muteChannelId} 不支持权限覆盖`);
        }
        
        // 尝试删除权限覆盖（解封）
        await channel.permissionOverwrites.delete(member);
        console.log(`已删除用户 ${targetUserId} 在频道 ${muteChannelId} 的权限覆盖`);
        
        // 如果配置要求验证解封，再次尝试解封以确保执行
        let verified = false;
        if (MUTE_STATUS_CHECK_CONFIG.VERIFY_UNMUTE) {
            try {
                // 等待一小段时间后再次检查
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // 再次尝试删除权限覆盖（如果已经删除，这个操作应该不会报错）
                await channel.permissionOverwrites.delete(member);
                verified = true;
                console.log(`已验证解封：用户 ${targetUserId} 在频道 ${muteChannelId} 的权限覆盖已确认删除`);
            } catch (verifyError) {
                // 如果报错说明权限覆盖不存在，这是好事
                if (verifyError.code === 10009 || verifyError.message.includes('Unknown Overwrite')) {
                    verified = true;
                    console.log(`验证解封成功：权限覆盖已不存在`);
                } else {
                    console.warn(`验证解封时出现异常:`, verifyError.message);
                    verified = false;
                }
            }
        }
        
        // 更新投票状态为已完成
        await updateSelfModerationVote(guildId, targetMessageId, type, {
            muteStatus: 'completed',
            lastUnmuteAttempt: new Date().toISOString(),
            unmuteAttempts: unmuteAttempts + 1,
            lastUnmuteError: null
        });
        
        return { 
            success: true, 
            verified: MUTE_STATUS_CHECK_CONFIG.VERIFY_UNMUTE ? verified : true 
        };
        
    } catch (error) {
        console.error(`解封用户 ${targetUserId} 时出错:`, error);
        
        // 更新失败信息
        try {
            await updateSelfModerationVote(guildId, targetMessageId, type, {
                muteStatus: 'active', // 保持禁言中状态
                unmuteAttempts: unmuteAttempts + 1,
                lastUnmuteAttempt: new Date().toISOString(),
                lastUnmuteError: error.message
            });
        } catch (updateError) {
            console.error('更新解封失败状态时出错:', updateError);
        }
        
        return { 
            success: false, 
            error: error.message 
        };
    }
}

/**
 * 启动禁言状态检查器
 * @param {Client} client - Discord客户端
 */
function startMuteStatusChecker(client) {
    console.log('启动禁言状态检查器...');
    console.log(`检查间隔: ${getCheckIntervals().muteStatusCheck / 1000 / 60} 分钟`);
    console.log(`最大重试次数: ${MUTE_STATUS_CHECK_CONFIG.MAX_UNMUTE_ATTEMPTS}`);
    console.log(`验证解封: ${MUTE_STATUS_CHECK_CONFIG.VERIFY_UNMUTE ? '启用' : '禁用'}`);
    
    // 立即进行一次检查
    checkActiveMuteStatus(client);
    
    // 设置定时检查
    const intervals = getCheckIntervals();
    setInterval(() => {
        checkActiveMuteStatus(client);
    }, intervals.muteStatusCheck);
}

module.exports = {
    startMuteStatusChecker,
    checkActiveMuteStatus,
    attemptUnmute
};