const { ChannelType } = require('discord.js');
const { getAllSelfRoleSettings, saveUserActivityBatch } = require('../../../core/utils/database');

/**
 * @file autoSyncService.js
 * @description 该服务用于在机器人离线后，自动同步错过的用户活跃度数据。
 */

/**
 * 在指定时间范围（从某个时间点到现在）内获取频道的消息。
 * @param {import('discord.js').TextChannel} channel - 要获取消息的频道。
 * @param {string} after - ISO 格式timestamp，从这个时间点之后开始获取消息。
 * @returns {Promise<Array<import('discord.js').Message>>} - 一个解析为消息数组的 Promise。
 */
async function fetchMessagesInRange(channel, after) {
    let allMessages = [];
    let lastId;
    const limit = 100;

    try {
        // Discord.js v14 的 fetch({ after: ... }) 是用来获取指定ID之后的消息
        // 我们需要找到'after'时间戳之后的第一个消息作为起点
        // 更简单的方法是直接获取最近的消息然后按时间戳过滤
        // 分批获取，直到消息的时间戳早于'after'时间点
        
        const afterTimestamp = new Date(after).getTime();

        while (true) {
            const options = { limit };
            if (lastId) {
                options.before = lastId;
            }

            const messages = await channel.messages.fetch(options);
            if (messages.size === 0) {
                break;
            }

            let reachedOlderMessages = false;
            for (const message of messages.values()) {
                if (message.createdTimestamp > afterTimestamp) {
                    allMessages.push(message);
                } else {
                    reachedOlderMessages = true;
                }
            }

            if (reachedOlderMessages || messages.size < limit) {
                break;
            }

            lastId = messages.last().id;
        }
    } catch (error) {
        console.error(`[SelfRole-AutoSync] Error fetching messages in channel ${channel.id}: ${error.message}`);
    }
    
    return allMessages;
}


/**
 * 启动时为所有服务器同步活跃度的主函数。
 * 检查每个服务器的最后保存时间，并获取所有错过的消息。
 * @param {import('discord.js').Client} client - Discord 客户端实例。
 */
async function syncMissedActivity(client) {
    console.log('[SelfRole-AutoSync] Starting auto-sync for missed user activity...');
    const allSettings = await getAllSelfRoleSettings();

    const batchData = {}; // 用于收集所有服务器的增量数据

    for (const guildId in allSettings) {
        try {
            const settings = allSettings[guildId];
            if (!settings.lastSuccessfulSave) {
                console.log(`[SelfRole-AutoSync] Skipping guild ${guildId}: no 'lastSuccessfulSave' timestamp found. Run /recalculateactivity to bootstrap.`);
                continue;
            }

            const monitoredChannels = [...new Set(
                settings.roles
                    .filter(role => role.conditions?.activity?.channelId)
                    .map(role => role.conditions.activity.channelId)
            )];

            if (monitoredChannels.length === 0) {
                continue;
            }

            console.log(`[SelfRole-AutoSync] Syncing activity for guild ${guildId}...`);
            const guild = await client.guilds.fetch(guildId).catch(() => null);
            if (!guild) {
                console.warn(`[SelfRole-AutoSync] Could not fetch guild ${guildId}.`);
                continue;
            }

            const guildIncrements = {}; // 当前服务器的增量数据

            for (const channelId of monitoredChannels) {
                const channel = await guild.channels.fetch(channelId).catch(() => null);
                if (!channel || channel.type !== ChannelType.GuildText) {
                    console.warn(`[SelfRole-AutoSync] Could not fetch text channel ${channelId} in guild ${guildId}.`);
                    continue;
                }

                console.log(`[SelfRole-AutoSync] Fetching missed messages for channel ${channel.name} (${channelId}) since ${settings.lastSuccessfulSave}...`);
                const missedMessages = await fetchMessagesInRange(channel, settings.lastSuccessfulSave);

                if (missedMessages.length > 0) {
                    console.log(`[SelfRole-AutoSync] Found ${missedMessages.length} missed messages in channel ${channel.name}. Calculating increments...`);
                    for (const message of missedMessages) {
                        if (message.author.bot) continue;

                        const authorId = message.author.id;
                        if (!guildIncrements[channelId]) guildIncrements[channelId] = {};
                        if (!guildIncrements[channelId][authorId]) {
                            guildIncrements[channelId][authorId] = { messageCount: 0, mentionedCount: 0, mentioningCount: 0 };
                        }
                        
                        guildIncrements[channelId][authorId].messageCount++;

                        const isMentioning = message.reference !== null || message.mentions.users.size > 0 || message.mentions.roles.size > 0;
                        if (isMentioning) {
                            guildIncrements[channelId][authorId].mentioningCount++;
                        }

                        message.mentions.users.forEach(user => {
                            if (user.bot || user.id === authorId) return;
                            const mentionedId = user.id;
                            if (!guildIncrements[channelId][mentionedId]) {
                                guildIncrements[channelId][mentionedId] = { messageCount: 0, mentionedCount: 0, mentioningCount: 0 };
                            }
                            guildIncrements[channelId][mentionedId].mentionedCount++;
                        });
                    }
                }
            }
            
            if (Object.keys(guildIncrements).length > 0) {
                batchData[guildId] = guildIncrements;
            }
            console.log(`[SelfRole-AutoSync] Finished activity calculation for guild ${guildId}.`);
        } catch (error) {
            console.error(`[SelfRole-AutoSync] ❌ An error occurred while syncing guild ${guildId}:`, error);
        }
    }

    if (Object.keys(batchData).length > 0) {
        console.log(`[SelfRole-AutoSync] 💾 Writing batch data for ${Object.keys(batchData).length} guilds to the database...`);
        try {
            await saveUserActivityBatch(batchData);
            console.log('[SelfRole-AutoSync] ✅ Batch write successful.');
        } catch (error) {
            console.error('[SelfRole-AutoSync] ❌ Batch write to database failed:', error);
        }
    }

    console.log('[SelfRole-AutoSync] Auto-sync for all guilds completed.');
}

module.exports = {
    syncMissedActivity,
};