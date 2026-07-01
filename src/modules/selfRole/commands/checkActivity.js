// src/modules/selfRole/commands/checkActivity.js

const { SlashCommandBuilder, EmbedBuilder, ChannelType } = require('discord.js');
const { getSelfRoleSettings, getUserActivity, getUserDailyActivitySummary, getUserActiveDaysCount, getUserDailyActivity } = require('../../../core/utils/database');
const { flushActivityCacheToDatabase } = require('../services/activityTracker');

function trimEmbedDescription(text, maxLen = 3900) {
    const raw = String(text || '');
    if (raw.length <= maxLen) return raw;
    return raw.slice(0, maxLen - 80).trimEnd() + '\n\n…（内容过长，已截断。请指定频道查询更详细数据。）';
}

/**
 * 获取当前 UTC 日期字符串（YYYY-MM-DD）。
 * 注意：UTC 0:00 = 北京时间 8:00，因此每日统计以北京时间的上午 8:00 为分割点，
 * 而非北京时间的 0:00 午夜。
 * @returns {string} UTC 日期，格式 YYYY-MM-DD
 */
function getUTCToday() {
    return new Date().toISOString().split('T')[0];
}

/**
 * 根据每日活跃度查询结果，格式化"今日已发送"条目。
 * 从查询到的每日活跃度数据中匹配今天的 UTC 日期，展示今日发言/被提及/主动提及数。
 * 若今日尚无数据，则显示"暂无数据"。
 * @param {Array<{date: string, messageCount: number, mentionedCount: number, mentioningCount: number}>} dailyRows - getUserDailyActivity 返回的每日数据
 * @returns {string} 格式化后的今日活跃度描述行
 */
function formatTodayDailyActivity(dailyRows) {
    const today = getUTCToday();
    const todayRow = dailyRows.find(r => r.date === today);
    if (!todayRow) {
        return `> • **今日已发送（UTC日）**: 暂无数据\n`;
    }
    return `> • **今日已发送（UTC日 ${today}）**: 发言 ${todayRow.messageCount} | 被提及 ${todayRow.mentionedCount} | 主动提及 ${todayRow.mentioningCount}\n`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('自助身份组申请-查询我的活跃度')
        .setDescription('查询您在特定频道的发言和被提及数')
        .addChannelOption(option =>
            option.setName('频道')
                .setDescription('只查询特定频道的活跃度（可选）')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(false)
        ),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const guildId = interaction.guild.id;
        const userId = interaction.user.id;

        try {
            const settings = await getSelfRoleSettings(guildId);
            if (!settings || !settings.roles || settings.roles.length === 0) {
                interaction.editReply({ content: '❌ 本服务器尚未配置任何需要统计活跃度的身份组。' });
                setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
                return;
            }

            const specificChannel = interaction.options.getChannel('频道');

            let channelIdsToCheck = [];

            if (specificChannel) {
                // 如果用户指定了频道，只检查这一个
                channelIdsToCheck.push(specificChannel.id);
            } else {
                // 否则，获取所有被监控的频道
                const monitoredChannels = settings.roles
                    .filter(role => role.conditions?.activity?.channelId)
                    .map(role => role.conditions.activity.channelId);
                channelIdsToCheck = [...new Set(monitoredChannels)];
            }

            if (channelIdsToCheck.length === 0) {
                interaction.editReply({ content: '❌ 本服务器尚未配置任何需要统计活跃度的身份组。' });
                setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
                return;
            }

            await flushActivityCacheToDatabase().catch(() => {});
            const userActivity = await getUserActivity(guildId);

            // 预先构建“频道 -> 该频道下配置了 activeDaysThreshold 的岗位配置”映射
            // 说明：活跃天数需要“每日发言阈值”才能计算，因此这里按岗位配置中的 activeDaysThreshold 来展示。
            const activeDaysRoleConfigsByChannel = {};
            for (const role of settings.roles) {
                const a = role?.conditions?.activity;
                const dt = a?.activeDaysThreshold;
                const channelId = a?.channelId;
                if (!channelId || !dt) continue;
                const dailyMessageThreshold = Number(dt.dailyMessageThreshold);
                const requiredActiveDays = Number(dt.requiredActiveDays);
                if (!Number.isFinite(dailyMessageThreshold) || dailyMessageThreshold <= 0) continue;
                if (!Number.isFinite(requiredActiveDays) || requiredActiveDays <= 0) continue;

                if (!activeDaysRoleConfigsByChannel[channelId]) activeDaysRoleConfigsByChannel[channelId] = [];
                activeDaysRoleConfigsByChannel[channelId].push({
                    roleId: role.roleId,
                    roleLabel: role.label || role.roleId,
                    dailyMessageThreshold,
                    requiredActiveDays,
                });
            }
            
            const embed = new EmbedBuilder()
                .setTitle('📈 您的活跃度统计')
                .setColor(0x5865F2)
                .setTimestamp();

            const dailySummaryCache = new Map();
            async function getDailySummary(channelId) {
                if (!dailySummaryCache.has(channelId)) {
                    const summary = await getUserDailyActivitySummary(guildId, channelId, userId);
                    dailySummaryCache.set(channelId, summary);
                }
                return dailySummaryCache.get(channelId);
            }

            function appendActivitySummary(description, totalActivity) {
                let text = description;
                text += `> • **总发言数**: ${totalActivity.messageCount}\n`;
                text += `> • **总被提及数**: ${totalActivity.mentionedCount}\n`;
                text += `> • **总主动提及数**: ${totalActivity.mentioningCount}\n`;
                return text + '\n';
            }

            function appendDailyActivityScope(description, dailyActivity) {
                let text = description;
                text += `> • **日表内发言数**: ${dailyActivity.messageCount}\n`;
                if (dailyActivity.firstDate && dailyActivity.lastDate) {
                    text += `> • **日表覆盖范围**: ${dailyActivity.firstDate} 至 ${dailyActivity.lastDate}\n`;
                }
                return text;
            }

            let description = '';
            if (specificChannel) {
                const totalActivity = userActivity[specificChannel.id]?.[userId] || { messageCount: 0, mentionedCount: 0, mentioningCount: 0 };
                description += `您在 <#${specificChannel.id}> 的活跃度数据：\n`;
                description = appendActivitySummary(description, totalActivity);

                const dailyRows = await getUserDailyActivity(guildId, specificChannel.id, userId, 1);
                description += formatTodayDailyActivity(dailyRows);
                description += '\n';

                // 活跃天数（仅当该频道下存在 activeDaysThreshold 配置时显示）
                const roleCfgs = activeDaysRoleConfigsByChannel[specificChannel.id] || [];
                if (roleCfgs.length > 0) {
                    const dailyActivity = await getDailySummary(specificChannel.id);
                    // 同一 dailyMessageThreshold 只计算一次，避免重复查询
                    const cache = new Map();
                    description += `该频道的 **活跃天数**（全部已统计记录，按UTC日切分；“每日发言≥阈值” 计为1天）：\n`;
                    description = appendDailyActivityScope(description, dailyActivity);

                    // 限制展示条数，避免 Embed 过长
                    const MAX_LINES = 12;
                    const showList = roleCfgs.slice(0, MAX_LINES);
                    for (const cfg of showList) {
                        if (!cache.has(cfg.dailyMessageThreshold)) {
                            const c = await getUserActiveDaysCount(guildId, specificChannel.id, userId, cfg.dailyMessageThreshold);
                            cache.set(cfg.dailyMessageThreshold, c);
                        }
                        const actual = cache.get(cfg.dailyMessageThreshold) ?? 0;
                        description += `> • **${cfg.roleLabel}**: 每日发言≥${cfg.dailyMessageThreshold}，需 ${cfg.requiredActiveDays} 天；当前 ${actual} 天\n`;
                    }
                    if (roleCfgs.length > MAX_LINES) {
                        description += `> ……（还有 ${roleCfgs.length - MAX_LINES} 个岗位配置未展示）\n`;
                    }
                    description += '\n';
                }
            } else {
                for (const channelId of channelIdsToCheck) {
                    const totalActivity = userActivity[channelId]?.[userId] || { messageCount: 0, mentionedCount: 0, mentioningCount: 0 };
                    description += `在 <#${channelId}>:\n`;
                    description = appendActivitySummary(description, totalActivity);

                    const dailyRows = await getUserDailyActivity(guildId, channelId, userId, 1);
                    description += formatTodayDailyActivity(dailyRows);
                    description += '\n';

                    const roleCfgs = activeDaysRoleConfigsByChannel[channelId] || [];
                    if (roleCfgs.length > 0) {
                        const dailyActivity = await getDailySummary(channelId);
                        const cache = new Map();
                        description += `该频道的 **活跃天数**（全部已统计记录，按UTC日切分；“每日发言≥阈值” 计为1天）：\n`;
                        description = appendDailyActivityScope(description, dailyActivity);

                        const MAX_LINES = 8;
                        const showList = roleCfgs.slice(0, MAX_LINES);
                        for (const cfg of showList) {
                            if (!cache.has(cfg.dailyMessageThreshold)) {
                                const c = await getUserActiveDaysCount(guildId, channelId, userId, cfg.dailyMessageThreshold);
                                cache.set(cfg.dailyMessageThreshold, c);
                            }
                            const actual = cache.get(cfg.dailyMessageThreshold) ?? 0;
                            description += `> • **${cfg.roleLabel}**: 每日发言≥${cfg.dailyMessageThreshold}，需 ${cfg.requiredActiveDays} 天；当前 ${actual} 天\n`;
                        }
                        if (roleCfgs.length > MAX_LINES) {
                            description += `> ……（还有 ${roleCfgs.length - MAX_LINES} 个岗位配置未展示）\n`;
                        }
                        description += '\n';
                    }
                }
            }

            if (!description) {
                description = '暂无您的活跃度数据。';
            }

            embed.setDescription(trimEmbedDescription(description));

            await interaction.editReply({ embeds: [embed] });
            setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);

        } catch (error) {
            console.error('[SelfRole] ❌ 查询活跃度时出错:', error);
            await interaction.editReply({ content: '❌ 查询时发生未知错误。' });
            setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        }
    },
};
