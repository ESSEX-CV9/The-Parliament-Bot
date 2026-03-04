const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType } = require('discord.js');
const {
    addExemptChannel,
    removeExemptChannel,
    getExemptChannels,
} = require('../../../core/utils/database');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('频道冲水-豁免')
        .setNameLocalizations({ 'en-US': 'cleanup-exempt' })
        .setDescription('管理豁免频道（添加 / 删除 / 查看）')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)

        .addSubcommand(sub => sub
            .setName('添加')
            .setDescription('添加频道到豁免列表（全服务器清理时将跳过此频道）')
            .addChannelOption(opt => opt
                .setName('频道')
                .setNameLocalizations({ 'en-US': 'channel' })
                .setDescription('要添加到豁免列表的频道')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum, ChannelType.GuildNews, ChannelType.PublicThread, ChannelType.PrivateThread)
                .setRequired(true)
            )
        )
        .addSubcommand(sub => sub
            .setName('删除')
            .setDescription('从豁免列表中移除频道')
            .addStringOption(opt => opt
                .setName('频道')
                .setNameLocalizations({ 'en-US': 'channel' })
                .setDescription('要从豁免列表移除的频道')
                .setRequired(true)
                .setAutocomplete(true)
            )
        )
        .addSubcommand(sub => sub
            .setName('查看')
            .setDescription('查看当前服务器的所有豁免频道')
        ),

    // ========== Autocomplete（删除子命令需要） ==========
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
                            value: channelId,
                        });
                    }
                } catch (_) { /* 频道不存在或无权访问 */ }
            }
            await interaction.respond(filtered.slice(0, 25));
        } catch (err) {
            console.error('自动完成豁免频道时出错:', err);
            await interaction.respond([]);
        }
    },

    // ========== Execute ==========
    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });
            const sub = interaction.options.getSubcommand();
            const guildId = interaction.guild.id;

            switch (sub) {
                // ────── 添加 ──────
                case '添加': {
                    const channel = interaction.options.getChannel('频道');

                    const allowedTypes = [ChannelType.GuildText, ChannelType.GuildForum, ChannelType.GuildNews, ChannelType.PublicThread, ChannelType.PrivateThread];
                    if (!allowedTypes.includes(channel.type)) {
                        return await interaction.editReply({ content: '❌ 只能豁免文字频道、论坛频道、公告频道或帖子！' });
                    }

                    const settings = await addExemptChannel(guildId, channel.id);

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
                            if (channel.parent) exemptionNote = `\n📌 **注意**：这是独立帖子豁免，不影响父频道 <#${channel.parent.id}>`;
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
                            { name: '当前豁免频道数量', value: `${settings.exemptChannels.length}`, inline: true },
                            { name: '💡 豁免说明', value: '• 豁免的频道在全服务器清理时会被跳过\n• 豁免的论坛频道包括其所有子帖子\n• 实时自动清理不受豁免影响', inline: false },
                        )
                        .setColor(0x00ff00)
                        .setTimestamp();

                    console.log(`✅ 添加豁免频道 - Guild: ${guildId}, Channel: ${channel.name} (${channel.id}), User: ${interaction.user.tag}`);
                    await interaction.editReply({ embeds: [embed] });
                    break;
                }

                // ────── 删除 ──────
                case '删除': {
                    const channelId = interaction.options.getString('频道');
                    const exemptChannels = await getExemptChannels(guildId);

                    if (!exemptChannels.includes(channelId)) {
                        return await interaction.editReply({ content: '❌ 该频道不在豁免列表中！' });
                    }

                    let channelName = channelId;
                    let channelType = '未知';
                    try {
                        const channel = await interaction.guild.channels.fetch(channelId);
                        if (channel) {
                            channelName = channel.name;
                            channelType = channel.type === 15 ? '论坛频道' :
                                         channel.type === 5 ? '公告频道' :
                                         (channel.type === 11 || channel.type === 12) ? '帖子' : '文字频道';
                        }
                    } catch (_) {
                        channelName = `已删除的频道 (${channelId})`;
                    }

                    const settings = await removeExemptChannel(guildId, channelId);
                    const embed = new EmbedBuilder()
                        .setTitle('✅ 豁免频道已移除')
                        .setDescription(`成功从豁免列表中移除${channelType} **${channelName}**`)
                        .addFields(
                            { name: '频道ID', value: channelId, inline: true },
                            { name: '频道类型', value: channelType, inline: true },
                            { name: '剩余豁免频道数量', value: `${settings.exemptChannels.length}`, inline: true },
                        )
                        .setColor(0x00ff00)
                        .setTimestamp();

                    console.log(`✅ 移除豁免频道 - Guild: ${guildId}, Channel: ${channelName} (${channelId}), User: ${interaction.user.tag}`);
                    await interaction.editReply({ embeds: [embed] });
                    break;
                }

                // ────── 查看 ──────
                case '查看': {
                    const exemptChannels = await getExemptChannels(guildId);

                    if (exemptChannels.length === 0) {
                        const embed = new EmbedBuilder()
                            .setTitle('📋 豁免频道列表')
                            .setDescription('当前没有设置任何豁免频道。')
                            .addFields({ name: '💡 提示', value: '使用 `/频道冲水-豁免 添加` 命令来添加不希望被全服务器清理影响的频道。' })
                            .setColor(0xffa500)
                            .setTimestamp();
                        return await interaction.editReply({ embeds: [embed] });
                    }

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
                                    case 0: channelType = '文字频道'; break;
                                    case 5: channelType = '公告频道'; break;
                                    case 15: channelType = '论坛频道'; extraInfo = ' (包含所有子帖子)'; break;
                                    case 11: channelType = '公开帖子'; break;
                                    case 12: channelType = '私人帖子'; break;
                                    default: channelType = '其他';
                                }
                                channelDetails.push({ name: channel.name, type: channelType, id: channelId, extraInfo, valid: true });
                            }
                        } catch (_) {
                            deletedChannels++;
                            channelDetails.push({ name: '已删除的频道', type: '未知', id: channelId, extraInfo: '', valid: false });
                        }
                    }

                    const embed = new EmbedBuilder()
                        .setTitle('📋 豁免频道列表')
                        .setDescription(`服务器 **${interaction.guild.name}** 的豁免频道`)
                        .setColor(0x00ff00)
                        .setTimestamp();

                    const typeGroups = {};
                    channelDetails.forEach(ch => {
                        if (!typeGroups[ch.type]) typeGroups[ch.type] = [];
                        typeGroups[ch.type].push(ch);
                    });
                    for (const [type, channels] of Object.entries(typeGroups)) {
                        const channelList = channels.map(ch => {
                            const prefix = ch.valid ? '✅' : '❌';
                            const ref = ch.valid ? `<#${ch.id}>` : `\`${ch.id}\``;
                            return `${prefix} ${ref}${ch.extraInfo}`;
                        }).join('\n');
                        embed.addFields({ name: `${type} (${channels.length}个)`, value: channelList || '无', inline: false });
                    }

                    embed.addFields(
                        { name: '📊 统计信息', value: `总计: ${exemptChannels.length} 个豁免频道`, inline: true },
                        { name: '✅ 有效', value: `${validChannels} 个`, inline: true },
                        { name: '❌ 已删除', value: `${deletedChannels} 个`, inline: true },
                        { name: '📝 豁免说明', value: '• 全服务器清理时会跳过这些频道\n• 论坛频道豁免包括其所有子帖子\n• 实时自动清理不受豁免影响\n• 已删除的频道可以使用 `/频道冲水-豁免 删除` 清理', inline: false },
                    );

                    await interaction.editReply({ embeds: [embed] });
                    break;
                }
            }
        } catch (error) {
            console.error('豁免频道操作出错:', error);
            await interaction.editReply({ content: `❌ 操作失败：${error.message || '未知错误'}` });
        }
    },
};
