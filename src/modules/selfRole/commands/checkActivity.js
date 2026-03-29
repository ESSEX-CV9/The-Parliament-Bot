// src/modules/selfRole/commands/checkActivity.js

const { SlashCommandBuilder, EmbedBuilder, ChannelType } = require('discord.js');
const { getSelfRoleSettings, getUserActivity } = require('../../../core/utils/database');

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
            } else {
                for (const channelId of channelIdsToCheck) {
                    const activity = userActivity[channelId]?.[userId] || { messageCount: 0, mentionedCount: 0, mentioningCount: 0 };
                    description += `在 <#${channelId}>:\n`;
                    description += `> • **发言数**: ${activity.messageCount}\n`;
                    description += `> • **被提及数**: ${activity.mentionedCount}\n`;
                    description += `> • **主动提及数**: ${activity.mentioningCount}\n\n`;
                }
            }

            if (!description) {
                description = '暂无您的活跃度数据。';
            }

            embed.setDescription(description);

            await interaction.editReply({ embeds: [embed] });
            setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);

        } catch (error) {
            console.error('[SelfRole] ❌ 查询活跃度时出错:', error);
            await interaction.editReply({ content: '❌ 查询时发生未知错误。' });
            setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        }
    },
};