const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { removeExemptChannel, getExemptChannels } = require('../../../core/utils/database');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('频道冲水-移除豁免频道')
        .setNameLocalizations({
            'en-US': 'remove-exempt-channel'
        })
        .setDescription('从豁免列表中移除频道')
        .addStringOption(option =>
            option.setName('频道')
                .setNameLocalizations({ 'en-US': 'channel' })
                .setDescription('要从豁免列表移除的频道')
                .setRequired(true)
                .setAutocomplete(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    async autocomplete(interaction) {
        try {
            const focusedValue = interaction.options.getFocused();
            const guildId = interaction.guild.id;
            
            const exemptChannels = await getExemptChannels(guildId);
            const filtered = [];

            for (const channelId of exemptChannels) {
                try {
                    const channel = await interaction.guild.channels.fetch(channelId);
                    if (channel && channel.name.toLowerCase().includes(focusedValue.toLowerCase())) {
                        filtered.push({
                            name: `#${channel.name} (${channel.type === 4 ? '分类' : channel.type === 2 ? '语音' : channel.type === 15 ? '论坛' : '文字'})`,
                            value: channelId
                        });
                    }
                } catch (error) {
                    // 频道不存在或无权访问，跳过
                }
            }

            await interaction.respond(filtered.slice(0, 25));
        } catch (error) {
            console.error('自动完成豁免频道时出错:', error);
            await interaction.respond([]);
        }
    },

    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            const channelId = interaction.options.getString('频道');
            const guildId = interaction.guild.id;

            // 检查频道是否在豁免列表中
            const exemptChannels = await getExemptChannels(guildId);
            if (!exemptChannels.includes(channelId)) {
                return await interaction.editReply({
                    content: '❌ 该频道不在豁免列表中！',
                    ephemeral: true
                });
            }

            // 获取频道信息
            let channelName = channelId;
            let channelType = '未知';
            try {
                const channel = await interaction.guild.channels.fetch(channelId);
                if (channel) {
                    channelName = channel.name;
                    channelType = channel.type === 15 ? '论坛频道' : 
                                 channel.type === 5 ? '公告频道' :
                                 channel.type === 11 || channel.type === 12 ? '帖子' : '文字频道';
                }
            } catch (error) {
                channelName = `已删除的频道 (${channelId})`;
            }

            // 移除豁免频道
            const settings = await removeExemptChannel(guildId, channelId);

            const embed = new EmbedBuilder()
                .setTitle('✅ 豁免频道已移除')
                .setDescription(`成功从豁免列表中移除${channelType} **${channelName}**`)
                .addFields(
                    { name: '频道ID', value: channelId, inline: true },
                    { name: '频道类型', value: channelType, inline: true },
                    { name: '剩余豁免频道数量', value: `${settings.exemptChannels.length}`, inline: true }
                )
                .setColor(0x00ff00)
                .setTimestamp();

            console.log(`✅ 移除豁免频道 - Guild: ${guildId}, Channel: ${channelName} (${channelId}), User: ${interaction.user.tag}`);

            await interaction.editReply({
                embeds: [embed],
                ephemeral: true
            });

        } catch (error) {
            console.error('移除豁免频道时出错:', error);
            
            const errorMessage = error.message || '移除豁免频道时发生未知错误';
            await interaction.editReply({
                content: `❌ 操作失败：${errorMessage}`,
                ephemeral: true
            });
        }
    },
}; 