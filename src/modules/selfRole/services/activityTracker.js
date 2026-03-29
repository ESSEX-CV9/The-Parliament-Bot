// src/modules/selfRole/services/activityTracker.js

const { saveUserActivityBatch, saveDailyUserActivityBatch, getSelfRoleSettings, getAllSelfRoleSettings, saveSelfRoleSettings } = require('../../../core/utils/database');

/**
 * 单个用户在某频道内的活跃度增量数据。
 * @typedef {Object} UserActivity
 * @property {number} messageCount 用户在该频道发送的消息条数
 * @property {number} mentionedCount 该用户在该频道被 @ 提及的次数
 * @property {number} mentioningCount 该用户在该频道主动 @ 或回复他人的次数
 */

/**
 * 频道层级: key 为 channelId, value 为该频道内所有用户的活跃度。
 * @typedef {Record<string, UserActivity>} ChannelActivity
 */

/**
 * 服务器层级: key 为 guildId, value 为该服务器内所有频道的活跃度。
 * @typedef {Record<string, ChannelActivity>} GuildActivity
 */

/**
 * 整体缓存结构: key 为 guildId, value 为对应服务器的活跃度数据。
 * @typedef {Record<string, GuildActivity>} ActivityCache
 */

/**
 * 内存缓存，用于暂存用户活跃度数据增量。
 * 结构示例:
 * {
 *   "guildA": {
 *     "channelX": {
 *       "user123": { messageCount: 1, mentionedCount: 0, mentioningCount: 0 },
 *       "user456": { messageCount: 4, mentionedCount: 2, mentioningCount: 1 }
 *     }
 *   }
 * }
 * @type {ActivityCache}
 */
let activityCache = {};

/**
 * 内存缓存，用于存储每个服务器被监控的频道ID集合。
 * 结构: { "guildId": Set("channelId1", "channelId2") }
 * @type {Record<string, Set<string>>}
 */
let monitoredChannelsCache = {};

// 定时器ID
let saveInterval = null;

// 批量写入间隔（毫秒），例如5分钟
const SAVE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 将内存中的缓存数据批量写入数据库。
 * @private
 */
async function _writeCacheToDatabase() {
    // 如果缓存为空，则不执行任何操作
    if (Object.keys(activityCache).length === 0) {
        return;
    }

    // 复制并立即清空主缓存，以防在异步的数据库操作期间丢失新的消息数据
    const cacheToWrite = activityCache;
    activityCache = {};

    console.log(`[SelfRole] 💾 开始将 ${Object.keys(cacheToWrite).length} 个服务器的活跃度增量数据写入数据库...`);

    try {
        // 保存总体活跃度数据
        await saveUserActivityBatch(cacheToWrite);

        // 保存每日活跃度数据
        // 使用 UTC 时间确保与历史数据回溯的日期计算一致
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD 格式（UTC）
        await saveDailyUserActivityBatch(cacheToWrite, today);

        // 批量更新所有涉及服务器的最后成功保存时间戳
        const guildIds = Object.keys(cacheToWrite);
        for (const guildId of guildIds) {
            const settings = await getSelfRoleSettings(guildId);
            if (settings) {
                settings.lastSuccessfulSave = new Date().toISOString();
                await saveSelfRoleSettings(guildId, settings);
            }
        }

        console.log('[SelfRole] ✅ 活跃度数据成功写入数据库。');
    } catch (error) {
        console.error('[SelfRole] ❌ 写入活跃度数据到数据库时出错:', error);
        // 如果写入失败，将数据合并回主缓存，以便下次重试
        // 注意：这是一种简化的重试逻辑，可能会导致数据顺序问题，但能保证数据不丢失
        for (const guildId in cacheToWrite) {
            if (!activityCache[guildId]) activityCache[guildId] = {};
            for (const channelId in cacheToWrite[guildId]) {
                if (!activityCache[guildId][channelId]) activityCache[guildId][channelId] = {};
                for (const userId in cacheToWrite[guildId][channelId]) {
                    if (!activityCache[guildId][channelId][userId]) {
                        activityCache[guildId][channelId][userId] = { messageCount: 0, mentionedCount: 0, mentioningCount: 0 };
                    }
                    const oldData = activityCache[guildId][channelId][userId];
                    const failedData = cacheToWrite[guildId][channelId][userId];
                    oldData.messageCount += failedData.messageCount;
                    oldData.mentionedCount += failedData.mentionedCount;
                    oldData.mentioningCount += failedData.mentioningCount;
                }
            }
        }
        console.log('[SelfRole] ⚠️ 数据已合并回缓存，将在下次定时任务时重试。');
    }
}

/**
 * 更新或初始化一个服务器的被监控频道列表缓存。
 * @param {string} guildId - 服务器ID。
 */
async function updateMonitoredChannels(guildId) {
    try {
        const settings = await getSelfRoleSettings(guildId);
        if (settings && settings.roles) {
            const channelIds = new Set(
                settings.roles
                    .filter(role => role.conditions?.activity?.channelId)
                    .map(role => role.conditions.activity.channelId)
            );
            monitoredChannelsCache[guildId] = channelIds;
            console.log(`[SelfRole] 缓存了服务器 ${guildId} 的 ${channelIds.size} 个被监控频道。`);
        } else {
            delete monitoredChannelsCache[guildId]; // 如果没有设置，则清空缓存
        }
    } catch (error) {
        console.error(`[SelfRole] ❌ 更新服务器 ${guildId} 的被监控频道缓存时出错:`, error);
    }
}

/**
 * 启动定时器，并初始化所有服务器的监控频道缓存。
 */
async function startActivityTracker() {
    // 1. 初始化所有现有服务器的缓存
    // 注意：在大型机器人中，这里可能需要分批处理
    console.log('[SelfRole] 正在初始化所有服务器的被监控频道缓存...');
    const allSettings = await getAllSelfRoleSettings();
    for (const guildId in allSettings) {
        await updateMonitoredChannels(guildId);
    }
    console.log('[SelfRole] ✅ 所有服务器的监控频道缓存初始化完成。');

    // 2. 启动定时写入任务
    if (saveInterval) {
        clearInterval(saveInterval);
    }
    saveInterval = setInterval(_writeCacheToDatabase, SAVE_INTERVAL_MS);
    console.log(`[SelfRole] ✅ 活跃度追踪器已启动，每 ${SAVE_INTERVAL_MS / 1000} 秒保存一次数据。`);
}

/**
 * 停止定时器
 */
function stopActivityTracker() {
    if (saveInterval) {
        clearInterval(saveInterval);
        saveInterval = null;
        console.log('[SelfRole] 🛑 活跃度追踪器已停止。');
        // 停止前最后执行一次写入，确保数据不丢失
        _writeCacheToDatabase();
    }
}

/**
 * 处理消息创建事件，更新内存缓存
 * @param {import('discord.js').Message} message - Discord 消息对象
 */
async function handleMessage(message) {
    // 忽略机器人和私信消息
    if (message.author.bot || !message.guild) {
        return;
    }

    const guildId = message.guild.id;
    const channelId = message.channel.id;
    const authorId = message.author.id;

    // 1. 快速内存检查，判断频道是否被监控
    const monitoredChannels = monitoredChannelsCache[guildId];
    if (!monitoredChannels || !monitoredChannels.has(channelId)) {
        return; // 如果不被监控，立即返回，无任何开销
    }

    // 2. 初始化缓存结构
    if (!activityCache[guildId]) activityCache[guildId] = {};
    if (!activityCache[guildId][channelId]) activityCache[guildId][channelId] = {};
    if (!activityCache[guildId][channelId][authorId]) {
        activityCache[guildId][channelId][authorId] = { messageCount: 0, mentionedCount: 0, mentioningCount: 0 };
    }

    // 更新发言数
    activityCache[guildId][channelId][authorId].messageCount++;

    // 检查是否为主动提及 (回复或@)
    const isMentioning = message.reference !== null || message.mentions.users.size > 0 || message.mentions.roles.size > 0;
    if (isMentioning) {
        activityCache[guildId][channelId][authorId].mentioningCount++;
    }

    // 更新被提及数
    message.mentions.users.forEach(mentionedUser => {
        // 忽略机器人和自己提及自己
        if (mentionedUser.bot || mentionedUser.id === authorId) {
            return;
        }
        const mentionedId = mentionedUser.id;
        if (!activityCache[guildId][channelId][mentionedId]) {
            activityCache[guildId][channelId][mentionedId] = { messageCount: 0, mentionedCount: 0, mentioningCount: 0 };
        }
        activityCache[guildId][channelId][mentionedId].mentionedCount++;
    });
}

module.exports = {
    startActivityTracker,
    stopActivityTracker,
    handleMessage,
    updateMonitoredChannels, // 导出此函数，以便其他服务可以调用
};