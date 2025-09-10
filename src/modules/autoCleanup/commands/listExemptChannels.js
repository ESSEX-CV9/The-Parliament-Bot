const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { getExemptChannels } = require('../../../core/utils/database');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('频道冲水-查看豁免频道')
        .setNameLocalizations({
            'en-US': 'list-exempt-channels'
        })
        .setDescription('查看当前服务器的所有豁免频道')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            const guildId = interaction.guild.id;
            const exemptChannels = await getExemptChannels(guildId);

            if (exemptChannels.length === 0) {
                const embed = new EmbedBuilder()
                    .setTitle('📋 豁免频道列表')
                    .setDescription('当前没有设置任何豁免频道。')
                    .addFields({
                        name: '💡 提示',
                        value: '使用 `/添加豁免频道` 命令来添加不希望被全服务器清理影响的频道。'
                    })
                    .setColor(0xffa500)
                    .setTimestamp();

                return await interaction.editReply({
                    embeds: [embed],
                    ephemeral: true
                });
            }

            // 获取频道详细信息
            const channelDetails = [];
            let validChannels = 0;
            let deletedChannels = 0;

            for (const channelId of exemptChannels) {
                try {
                    const channel = await interaction.guild.channels.fetch(channelId);
                    if (channel) {
                        validChannels++;
                        let channelType = '';
                        let extraInfo = '';
                        
                        switch (channel.type) {
                            case 0: // GuildText
                                channelType = '文字频道';
                                break;
                            case 5: // GuildNews
                                channelType = '公告频道';
                                break;
                            case 15: // GuildForum
                                channelType = '论坛频道';
                                extraInfo = ' (包含所有子帖子)';
                                break;
                            case 11: // PublicThread
                                channelType = '公开帖子';
                                break;
                            case 12: // PrivateThread
                                channelType = '私人帖子';
                                break;
                            default:
                                channelType = '其他';
                        }

                        channelDetails.push({
                            name: channel.name,
                            type: channelType,
                            id: channelId,
                            extraInfo: extraInfo,
                            valid: true
                        });
                    }
                } catch (error) {
                    deletedChannels++;
                    channelDetails.push({
                        name: '已删除的频道',
                        type: '未知',
                        id: channelId,
                        extraInfo: '',
                        valid: false
                    });
                }
            }

            const embed = new EmbedBuilder()
                .setTitle('📋 豁免频道列表')
                .setDescription(`服务器 **${interaction.guild.name}** 的豁免频道`)
                .setColor(0x00ff00)
                .setTimestamp();

            // 按类型分组显示
            const typeGroups = {};
            channelDetails.forEach(channel => {
                if (!typeGroups[channel.type]) {
                    typeGroups[channel.type] = [];
                }
                typeGroups[channel.type].push(channel);
            });

            for (const [type, channels] of Object.entries(typeGroups)) {
                const channelList = channels.map(channel => {
                    const prefix = channel.valid ? '✅' : '❌';
                    const channelRef = channel.valid ? `<#${channel.id}>` : `\`${channel.id}\``;
                    return `${prefix} ${channelRef}${channel.extraInfo}`;
                }).join('\n');

                embed.addFields({
                    name: `${type} (${channels.length}个)`,
                    value: channelList || '无',
                    inline: false
                });
            }

            // 添加统计信息
            embed.addFields(
                { name: '📊 统计信息', value: `总计: ${exemptChannels.length} 个豁免频道`, inline: true },
                { name: '✅ 有效', value: `${validChannels} 个`, inline: true },
                { name: '❌ 已删除', value: `${deletedChannels} 个`, inline: true }
            );

            // 添加说明
            embed.addFields({
                name: '📝 豁免说明',
                value: '• 全服务器清理时会跳过这些频道\n• 论坛频道豁免包括其所有子帖子\n• 实时自动清理不受豁免影响\n• 已删除的频道可以使用 `/移除豁免频道` 清理',
                inline: false
            });

            await interaction.editReply({
                embeds: [embed],
                ephemeral: true
            });

        } catch (error) {
            console.error('查看豁免频道时出错:', error);
            
            const errorMessage = error.message || '查看豁免频道时发生未知错误';
            await interaction.editReply({
                content: `❌ 操作失败：${errorMessage}`,
                ephemeral: true
            });
        }
    },
}; 