// src/modules/selfRole/services/activityTracker.js

const { getUserActivity, saveUserActivity, getSelfRoleSettings } = require('../../../core/utils/database');

/**
 * 内存缓存，用于暂存用户活跃度数据
 * 结构: { guildId: { channelId: { userId: { messageCount: 1, mentionedCount: 0 } } } }
 */
let activityCache = {};

// 定时器ID
let saveInterval = null;

// 批量写入间隔（毫秒），例如5分钟
const SAVE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 将内存中的缓存数据合并到db中
 * @private
 */
async function _writeCacheToFile() {
    // 复制并立即清空缓存，防止在异步操作期间丢失新数据
    const cacheToWrite = { ...activityCache };
    activityCache = {};

    if (Object.keys(cacheToWrite).length === 0) {
        // console.log('[SelfRole] ✅ 活跃度缓存为空，无需写入。');
        return;
    }

    console.log(`[SelfRole] 💾 开始将 ${Object.keys(cacheToWrite).length} 个服务器的活跃度数据写入数据库...`);

    try {
        for (const guildId in cacheToWrite) {
            const guildActivity = await getUserActivity(guildId);
            const cachedGuildData = cacheToWrite[guildId];

            for (const channelId in cachedGuildData) {
                if (!guildActivity[channelId]) {
                    guildActivity[channelId] = {};
                }
                const cachedChannelData = cachedGuildData[channelId];

                for (const userId in cachedChannelData) {
                    if (!guildActivity[channelId][userId]) {
                        guildActivity[channelId][userId] = { messageCount: 0, mentionedCount: 0 };
                    }
                    guildActivity[channelId][userId].messageCount += cachedChannelData[userId].messageCount || 0;
                    guildActivity[channelId][userId].mentionedCount += cachedChannelData[userId].mentionedCount || 0;
                }
            }
            await saveUserActivity(guildId, guildActivity);
        }
        console.log('[SelfRole] ✅ 活跃度数据成功写入数据库。');
    } catch (error) {
        console.error('[SelfRole] ❌ 写入活跃度数据到数据库时出错:', error);
        // 在出错时，可以选择将数据合并回主缓存以供下次尝试
        // (为简单起见，此处暂时只记录错误)
    }
}

/**
 * 启动定时器，周期性地将缓存数据写入文件
 */
function startActivityTracker() {
    if (saveInterval) {
        clearInterval(saveInterval);
    }
    saveInterval = setInterval(_writeCacheToFile, SAVE_INTERVAL_MS);
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
        _writeCacheToFile();
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

    // 检查此频道是否是任何已配置的活跃度统计频道
    const settings = await getSelfRoleSettings(guildId);
    if (!settings || !settings.roles) return;

    const isMonitoredChannel = settings.roles.some(role => role.conditions?.activity?.channelId === channelId);

    if (!isMonitoredChannel) {
        return;
    }

    // 初始化缓存结构
    if (!activityCache[guildId]) activityCache[guildId] = {};
    if (!activityCache[guildId][channelId]) activityCache[guildId][channelId] = {};
    if (!activityCache[guildId][channelId][authorId]) {
        activityCache[guildId][channelId][authorId] = { messageCount: 0, mentionedCount: 0 };
    }

    // 更新发言数
    activityCache[guildId][channelId][authorId].messageCount++;

    // 更新被提及数
    message.mentions.users.forEach(mentionedUser => {
        // 忽略机器人和自己提及自己
        if (mentionedUser.bot || mentionedUser.id === authorId) {
            return;
        }
        const mentionedId = mentionedUser.id;
        if (!activityCache[guildId][channelId][mentionedId]) {
            activityCache[guildId][channelId][mentionedId] = { messageCount: 0, mentionedCount: 0 };
        }
        activityCache[guildId][channelId][mentionedId].mentionedCount++;
    });
}

module.exports = {
    startActivityTracker,
    stopActivityTracker,
    handleMessage,
};