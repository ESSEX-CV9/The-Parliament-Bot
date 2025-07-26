// src/modules/selfRole/services/activityTracker.js

const { getUserActivity, saveUserActivity } = require('../../../core/utils/database');

let activityCache = {};
const WRITE_INTERVAL = 5 * 60 * 1000; // 5分钟

/**
 * 启动活动追踪器
 */
function startActivityTracker() {
    console.log('[SelfRole] 📈 活动追踪器已启动。');
    setInterval(flushActivityCacheToDB, WRITE_INTERVAL);
}

/**
 * 记录用户活动
 * @param {import('discord.js').Message} message
 */
async function recordActivity(message) {
    const guildId = message.guild.id;
    const channelId = message.channel.id;
    const authorId = message.author.id;

    // 初始化缓存结构
    if (!activityCache[guildId]) {
        activityCache[guildId] = {};
    }
    if (!activityCache[guildId][channelId]) {
        activityCache[guildId][channelId] = {};
    }

    // 记录发言数
    if (!activityCache[guildId][channelId][authorId]) {
        activityCache[guildId][channelId][authorId] = { messageCount: 0, mentionedCount: 0 };
    }
    activityCache[guildId][channelId][authorId].messageCount++;

    // 记录被提及数
    message.mentions.users.forEach(user => {
        if (user.bot || user.id === authorId) return;
        const mentionedId = user.id;
        if (!activityCache[guildId][channelId][mentionedId]) {
            activityCache[guildId][channelId][mentionedId] = { messageCount: 0, mentionedCount: 0 };
        }
        activityCache[guildId][channelId][mentionedId].mentionedCount++;
    });
}

/**
 * 将缓存中的活动数据写入数据库
 */
async function flushActivityCacheToDB() {
    if (Object.keys(activityCache).length === 0) {
        return;
    }

    console.log('[SelfRole] 💾 正在将活动数据缓存写入数据库...');
    const guilds = Object.keys(activityCache);

    for (const guildId of guilds) {
        const guildActivity = await getUserActivity(guildId);
        const guildCache = activityCache[guildId];

        for (const channelId in guildCache) {
            if (!guildActivity[channelId]) {
                guildActivity[channelId] = {};
            }
            const channelCache = guildCache[channelId];

            for (const userId in channelCache) {
                if (!guildActivity[channelId][userId]) {
                    guildActivity[channelId][userId] = { messageCount: 0, mentionedCount: 0 };
                }
                guildActivity[channelId][userId].messageCount += channelCache[userId].messageCount;
                guildActivity[channelId][userId].mentionedCount += channelCache[userId].mentionedCount;
            }
        }
        await saveUserActivity(guildId, guildActivity);
    }

    // 清空缓存
    activityCache = {};
    console.log('[SelfRole] ✅ 活动数据缓存已成功写入数据库。');
}

module.exports = {
    startActivityTracker,
    recordActivity,
};