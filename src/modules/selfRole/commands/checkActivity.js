// src/modules/selfRole/commands/checkActivity.js

const { SlashCommandBuilder, EmbedBuilder, ChannelType } = require('discord.js');
const { getSelfRoleSettings, getUserActivity, getUserActiveDaysCount } = require('../../../core/utils/database');

function trimEmbedDescription(text, maxLen = 3900) {
    const raw = String(text || '');
    if (raw.length <= maxLen) return raw;
    return raw.slice(0, maxLen - 80).trimEnd() + '\n\n…（内容过长，已截断。请指定频道查询更详细数据。）';
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

            let description = '';
            if (specificChannel) {
                const activity = userActivity[specificChannel.id]?.[userId] || { messageCount: 0, mentionedCount: 0, mentioningCount: 0 };
                description += `您在 <#${specificChannel.id}> 的活跃度数据：\n`;
                description += `> • **发言数**: ${activity.messageCount}\n`;
                description += `> • **被提及数**: ${activity.mentionedCount}\n`;
                description += `> • **主动提及数**: ${activity.mentioningCount}\n\n`;

                // 活跃天数（仅当该频道下存在 activeDaysThreshold 配置时显示）
                const roleCfgs = activeDaysRoleConfigsByChannel[specificChannel.id] || [];
                if (roleCfgs.length > 0) {
                    // 同一 dailyMessageThreshold 只计算一次，避免重复查询
                    const cache = new Map();
                    description += `该频道的 **活跃天数**（近90天，按UTC日切分；“每日发言≥阈值” 计为1天）：\n`;

                    // 限制展示条数，避免 Embed 过长
                    const MAX_LINES = 12;
                    const showList = roleCfgs.slice(0, MAX_LINES);
                    for (const cfg of showList) {
                        if (!cache.has(cfg.dailyMessageThreshold)) {
                            const c = await getUserActiveDaysCount(guildId, specificChannel.id, userId, cfg.dailyMessageThreshold).catch(() => 0);
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
                    const activity = userActivity[channelId]?.[userId] || { messageCount: 0, mentionedCount: 0, mentioningCount: 0 };
                    description += `在 <#${channelId}>:\n`;
                    description += `> • **发言数**: ${activity.messageCount}\n`;
                    description += `> • **被提及数**: ${activity.mentionedCount}\n`;
                    description += `> • **主动提及数**: ${activity.mentioningCount}\n\n`;

                    const roleCfgs = activeDaysRoleConfigsByChannel[channelId] || [];
                    if (roleCfgs.length > 0) {
                        const cache = new Map();
                        description += `该频道的 **活跃天数**（近90天，按UTC日切分；“每日发言≥阈值” 计为1天）：\n`;

                        const MAX_LINES = 8;
                        const showList = roleCfgs.slice(0, MAX_LINES);
                        for (const cfg of showList) {
                            if (!cache.has(cfg.dailyMessageThreshold)) {
                                const c = await getUserActiveDaysCount(guildId, channelId, userId, cfg.dailyMessageThreshold).catch(() => 0);
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