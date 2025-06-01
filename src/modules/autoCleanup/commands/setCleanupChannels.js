const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const { setCleanupChannels, getAutoCleanupSettings } = require('../../../core/utils/database');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('设置清理频道')
        .setNameLocalizations({
            'en-US': 'set-cleanup-channels'
        })
        .setDescription('设置要监控的频道（留空表示监控所有频道）')
        .addChannelOption(option =>
            option.setName('频道1')
                .setNameLocalizations({ 'en-US': 'channel1' })
                .setDescription('要监控的频道')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum, ChannelType.PublicThread, ChannelType.PrivateThread)
                .setRequired(false)
        )
        .addChannelOption(option =>
            option.setName('频道2')
                .setNameLocalizations({ 'en-US': 'channel2' })
                .setDescription('要监控的频道')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum, ChannelType.PublicThread, ChannelType.PrivateThread)
                .setRequired(false)
        )
        .addChannelOption(option =>
            option.setName('频道3')
                .setNameLocalizations({ 'en-US': 'channel3' })
                .setDescription('要监控的频道')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum, ChannelType.PublicThread, ChannelType.PrivateThread)
                .setRequired(false)
        )
        .addChannelOption(option =>
            option.setName('频道4')
                .setNameLocalizations({ 'en-US': 'channel4' })
                .setDescription('要监控的频道')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum, ChannelType.PublicThread, ChannelType.PrivateThread)
                .setRequired(false)
        )
        .addChannelOption(option =>
            option.setName('频道5')
                .setNameLocalizations({ 'en-US': 'channel5' })
                .setDescription('要监控的频道')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum, ChannelType.PublicThread, ChannelType.PrivateThread)
                .setRequired(false)
        )
        .addBooleanOption(option =>
            option.setName('清空设置')
                .setNameLocalizations({ 'en-US': 'clear-settings' })
                .setDescription('清空所有监控频道设置（将监控所有频道）')
                .setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            const guildId = interaction.guild.id;
            const clearSettings = interaction.options.getBoolean('清空设置') || false;

            if (clearSettings) {
                // 清空所有监控频道设置
                await setCleanupChannels(guildId, []);
                
                const embed = new EmbedBuilder()
                    .setTitle('✅ 清理频道设置已清空')
                    .setDescription('已清空所有监控频道设置，现在将监控服务器中的所有频道。')
                    .setColor(0x00ff00)
                    .setTimestamp();

                console.log(`✅ 清空清理频道设置 - Guild: ${guildId}, User: ${interaction.user.tag}`);

                return await interaction.editReply({
                    embeds: [embed],
                    ephemeral: true
                });
            }

            // 收集所有选择的频道
            const selectedChannels = [];
            for (let i = 1; i <= 5; i++) {
                const channel = interaction.options.getChannel(`频道${i}`);
                if (channel) {
                    selectedChannels.push(channel);
                }
            }

            if (selectedChannels.length === 0) {
                return await interaction.editReply({
                    content: '❌ 请至少选择一个频道，或使用"清空设置"选项来监控所有频道。',
                    ephemeral: true
                });
            }

            // 验证频道权限
            const invalidChannels = [];
            const validChannels = [];

            for (const channel of selectedChannels) {
                try {
                    const permissions = channel.permissionsFor(interaction.guild.members.me);
                    if (permissions.has(['ViewChannel', 'ReadMessageHistory', 'ManageMessages'])) {
                        validChannels.push(channel);
                    } else {
                        invalidChannels.push(channel);
                    }
                } catch (error) {
                    invalidChannels.push(channel);
                }
            }

            if (validChannels.length === 0) {
                return await interaction.editReply({
                    content: '❌ 所选频道中没有任何频道具备必要的权限（查看频道、阅读消息历史、管理消息）。',
                    ephemeral: true
                });
            }

            // 保存有效的频道设置
            const channelIds = validChannels.map(ch => ch.id);
            await setCleanupChannels(guildId, channelIds);

            // 构建响应
            const embed = new EmbedBuilder()
                .setTitle('✅ 清理频道设置已更新')
                .setDescription('成功设置要监控的频道。自动清理功能将只在这些频道中生效。')
                .setColor(0x00ff00)
                .setTimestamp();

            // 添加有效频道列表
            if (validChannels.length > 0) {
                const validChannelList = validChannels.map(ch => `<#${ch.id}>`).join('\n');
                embed.addFields({
                    name: `✅ 已设置的监控频道 (${validChannels.length})`,
                    value: validChannelList,
                    inline: false
                });
            }

            // 添加无效频道警告
            if (invalidChannels.length > 0) {
                const invalidChannelList = invalidChannels.map(ch => `<#${ch.id}>`).join('\n');
                embed.addFields({
                    name: `⚠️ 权限不足的频道 (${invalidChannels.length})`,
                    value: `${invalidChannelList}\n*这些频道已跳过，请检查机器人权限*`,
                    inline: false
                });
            }

            console.log(`✅ 设置清理频道 - Guild: ${guildId}, Channels: ${channelIds.join(', ')}, User: ${interaction.user.tag}`);

            await interaction.editReply({
                embeds: [embed],
                ephemeral: true
            });

        } catch (error) {
            console.error('设置清理频道时出错:', error);
            
            const errorMessage = error.message || '设置清理频道时发生未知错误';
            await interaction.editReply({
                content: `❌ 操作失败：${errorMessage}`,
                ephemeral: true
            });
        }
    },
}; 