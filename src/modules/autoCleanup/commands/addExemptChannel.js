const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType } = require('discord.js');
const { addExemptChannel } = require('../../../core/utils/database');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('频道冲水-添加豁免频道')
        .setNameLocalizations({
            'en-US': 'add-exempt-channel'
        })
        .setDescription('添加频道到豁免列表（全服务器清理时将跳过此频道）')
        .addChannelOption(option =>
            option.setName('频道')
                .setNameLocalizations({ 'en-US': 'channel' })
                .setDescription('要添加到豁免列表的频道')
                .addChannelTypes(
                    ChannelType.GuildText,
                    ChannelType.GuildForum,
                    ChannelType.GuildNews,
                    ChannelType.PublicThread,
                    ChannelType.PrivateThread
                )
                .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            const channel = interaction.options.getChannel('频道');
            const guildId = interaction.guild.id;

            // 验证频道类型
            const allowedTypes = [
                ChannelType.GuildText,
                ChannelType.GuildForum,
                ChannelType.GuildNews,
                ChannelType.PublicThread,
                ChannelType.PrivateThread
            ];

            if (!allowedTypes.includes(channel.type)) {
                return await interaction.editReply({
                    content: '❌ 只能豁免文字频道、论坛频道、公告频道或帖子！',
                    ephemeral: true
                });
            }

            // 添加豁免频道
            const settings = await addExemptChannel(guildId, channel.id);

            // 检查频道类型并给出相应提示
            let channelTypeDesc = '频道';
            let exemptionNote = '';
            
            switch (channel.type) {
                case ChannelType.GuildForum:
                    channelTypeDesc = '论坛频道';
                    exemptionNote = '\n📌 **注意**：该论坛下的所有帖子也会被豁免';
                    break;
                case ChannelType.PublicThread:
                case ChannelType.PrivateThread:
                    channelTypeDesc = '帖子';
                    if (channel.parent) {
                        exemptionNote = `\n📌 **注意**：这是独立帖子豁免，不影响父频道 <#${channel.parent.id}>`;
                    }
                    break;
                case ChannelType.GuildNews:
                    channelTypeDesc = '公告频道';
                    break;
                default:
                    channelTypeDesc = '文字频道';
            }

            const embed = new EmbedBuilder()
                .setTitle('✅ 豁免频道已添加')
                .setDescription(`成功将${channelTypeDesc} <#${channel.id}> 添加到豁免列表${exemptionNote}`)
                .addFields(
                    { name: '频道名称', value: channel.name, inline: true },
                    { name: '频道类型', value: channelTypeDesc, inline: true },
                    { name: '当前豁免频道数量', value: `${settings.exemptChannels.length}`, inline: true }
                )
                .setColor(0x00ff00)
                .setTimestamp();

            embed.addFields({
                name: '💡 豁免说明',
                value: '• 豁免的频道在全服务器清理时会被跳过\n• 豁免的论坛频道包括其所有子帖子\n• 实时自动清理不受豁免影响',
                inline: false
            });

            console.log(`✅ 添加豁免频道 - Guild: ${guildId}, Channel: ${channel.name} (${channel.id}), User: ${interaction.user.tag}`);

            await interaction.editReply({
                embeds: [embed],
                ephemeral: true
            });

        } catch (error) {
            console.error('添加豁免频道时出错:', error);
            
            const errorMessage = error.message || '添加豁免频道时发生未知错误';
            await interaction.editReply({
                content: `❌ 操作失败：${errorMessage}`,
                ephemeral: true
            });
        }
    },
}; 