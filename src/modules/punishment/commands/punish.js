const { SlashCommandBuilder, EmbedBuilder, ChannelType } = require('discord.js');
const { checkAdminPermission } = require('../../../core/utils/permissionManager');
const { parseDuration } = require('../utils/timeParser');
const { executeBan, executeUnban, executeMute, executeWarnRole, executeUnmute } = require('../services/punishmentExecutor');
const {
    setWarnRoleForGuild,
    addSyncTarget,
    removeSyncTarget,
    listSyncTargets,
    addAnnouncementChannel,
    removeAnnouncementChannel,
    getAnnouncementChannels,
    getPunishmentRecords,
} = require('../services/punishmentDatabase');

const data = new SlashCommandBuilder()
    .setName('处罚')
    .setDescription('管理员处罚工具')
    .setDefaultMemberPermissions(0)
    .addSubcommand(sub => sub
        .setName('封禁')
        .setDescription('永久封禁服务器成员')
        .addUserOption(opt => opt.setName('用户').setDescription('要封禁的用户').setRequired(true))
        .addStringOption(opt => opt.setName('原因').setDescription('封禁原因').setRequired(false))
        .addBooleanOption(opt => opt.setName('同步').setDescription('是否同步至关联服务器（默认开启）').setRequired(false))
    )
    .addSubcommand(sub => sub
        .setName('解封')
        .setDescription('解除成员的封禁')
        .addStringOption(opt => opt.setName('用户id').setDescription('要解封的用户ID').setRequired(true))
        .addStringOption(opt => opt.setName('原因').setDescription('解封原因').setRequired(false))
        .addBooleanOption(opt => opt.setName('同步').setDescription('是否同步至关联服务器（默认开启）').setRequired(false))
    )
    .addSubcommand(sub => sub
        .setName('禁言')
        .setDescription('对成员执行超时禁言')
        .addUserOption(opt => opt.setName('用户').setDescription('要禁言的用户').setRequired(true))
        .addStringOption(opt => opt.setName('时长').setDescription('时长格式：2h 或 3d').setRequired(true))
        .addStringOption(opt => opt.setName('原因').setDescription('禁言原因').setRequired(false))
        .addStringOption(opt => opt.setName('警告时长').setDescription('同时添加警告身份组的时长，如 7 或 7d 或 12h').setRequired(false))
        .addBooleanOption(opt => opt.setName('同步').setDescription('是否同步至关联服务器（默认开启）').setRequired(false))
    )
    .addSubcommand(sub => sub
        .setName('警告')
        .setDescription('为成员添加警告身份组（到期自动移除）')
        .addUserOption(opt => opt.setName('用户').setDescription('目标用户').setRequired(true))
        .addStringOption(opt => opt.setName('时长').setDescription('时长格式：2h 或 3d').setRequired(true))
        .addStringOption(opt => opt.setName('原因').setDescription('原因').setRequired(false))
        .addBooleanOption(opt => opt.setName('同步').setDescription('是否同步至关联服务器（默认开启）').setRequired(false))
    )
    .addSubcommand(sub => sub
        .setName('解除禁言')
        .setDescription('解除成员的禁言')
        .addUserOption(opt => opt.setName('用户').setDescription('要解除禁言的用户').setRequired(true))
        .addStringOption(opt => opt.setName('原因').setDescription('解除原因').setRequired(false))
        .addBooleanOption(opt => opt.setName('同步').setDescription('是否同步至关联服务器（默认开启）').setRequired(false))
    )
    .addSubcommand(sub => sub
        .setName('配置公告频道')
        .setDescription('添加、移除或查看处罚公告频道（支持跨服频道ID）')
        .addStringOption(opt => opt
            .setName('操作')
            .setDescription('添加、移除或查看列表')
            .setRequired(true)
            .addChoices(
                { name: '添加', value: 'add' },
                { name: '移除', value: 'remove' },
                { name: '查看列表', value: 'list' },
            ))
        .addChannelOption(opt => opt
            .setName('频道')
            .setDescription('公告频道（当前服务器内可选）')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(false))
        .addStringOption(opt => opt
            .setName('频道id')
            .setDescription('跨服务器频道请填写频道ID')
            .setRequired(false))
    )
    .addSubcommand(sub => sub
        .setName('配置警告身份组')
        .setDescription('设置本服务器的警告身份组')
        .addRoleOption(opt => opt.setName('身份组').setDescription('警告身份组').setRequired(true))
    )
    .addSubcommand(sub => sub
        .setName('配置同步服务器')
        .setDescription('单向配置同步目标服务器（双向需互加）')
        .addStringOption(opt => opt
            .setName('操作')
            .setDescription('添加或移除')
            .setRequired(true)
            .addChoices(
                { name: '添加', value: 'add' },
                { name: '移除', value: 'remove' },
                { name: '查看列表', value: 'list' },
            ))
        .addStringOption(opt => opt.setName('目标服务器id').setDescription('目标服务器的ID').setRequired(false))
    )
    .addSubcommand(sub => sub
        .setName('查询记录')
        .setDescription('查询某用户的处罚记录')
        .addUserOption(opt => opt.setName('用户').setDescription('要查询的用户').setRequired(true))
    );

async function execute(interaction) {
    if (!checkAdminPermission(interaction.member)) {
        await interaction.reply({ content: '❌ 你没有权限使用此命令', ephemeral: true });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    const sub = interaction.options.getSubcommand();
    const client = interaction.client;

    try {
        switch (sub) {
            case '封禁': {
                const targetUser = interaction.options.getUser('用户');
                const reason = interaction.options.getString('原因');
                const sync = interaction.options.getBoolean('同步') ?? true;
                await executeBan(client, interaction, { targetUser, reason, sync });
                break;
            }
            case '解封': {
                const userId = interaction.options.getString('用户id');
                const reason = interaction.options.getString('原因');
                const sync = interaction.options.getBoolean('同步') ?? true;
                await executeUnban(client, interaction, { userId, reason, sync });
                break;
            }
            case '禁言': {
                const targetUser = interaction.options.getUser('用户');
                const durationStr = interaction.options.getString('时长');
                const reason = interaction.options.getString('原因');
                const warnDurationStr = interaction.options.getString('警告时长');
                const sync = interaction.options.getBoolean('同步') ?? true;

                const duration = parseDuration(durationStr);
                if (!duration) {
                    await interaction.editReply('❌ 时长格式错误，请使用如 `2h`（2小时）、`3d`（3天）或直接输入数字（默认天）');
                    return;
                }

                let warnDuration = null;
                if (warnDurationStr) {
                    warnDuration = parseDuration(warnDurationStr);
                    if (!warnDuration) {
                        await interaction.editReply('❌ 警告时长格式错误，请使用如 `7`（7天）、`12h`（12小时）或 `3d`（3天）');
                        return;
                    }
                }

                const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
                if (!targetMember) {
                    await interaction.editReply('❌ 无法找到该用户');
                    return;
                }

                await executeMute(client, interaction, {
                    targetMember,
                    durationMs: duration.ms,
                    durationLabel: duration.label,
                    reason,
                    warnDuration,
                    sync,
                });
                break;
            }
            case '警告': {
                const targetUser = interaction.options.getUser('用户');
                const durationStr = interaction.options.getString('时长');
                const reason = interaction.options.getString('原因');
                const sync = interaction.options.getBoolean('同步') ?? true;

                const duration = parseDuration(durationStr);
                if (!duration) {
                    await interaction.editReply('❌ 时长格式错误，请使用如 `7`（7天）、`12h`（12小时）或 `3d`（3天）');
                    return;
                }

                const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
                if (!targetMember) {
                    await interaction.editReply('❌ 无法找到该用户');
                    return;
                }

                await executeWarnRole(client, interaction, {
                    targetMember,
                    durationMs: duration.ms,
                    durationLabel: duration.label,
                    reason,
                    sync,
                });
                break;
            }
            case '解除禁言': {
                const targetUser = interaction.options.getUser('用户');
                const reason = interaction.options.getString('原因');
                const sync = interaction.options.getBoolean('同步') ?? true;

                const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
                if (!targetMember) {
                    await interaction.editReply('❌ 无法找到该用户');
                    return;
                }

                await executeUnmute(client, interaction, { targetMember, reason, sync });
                break;
            }

            case '配置公告频道': {
                const action = interaction.options.getString('操作');
                const selectedChannel = interaction.options.getChannel('频道');
                const channelIdInput = interaction.options.getString('频道id');

                if (action === 'list') {
                    const channelIds = getAnnouncementChannels(interaction.guild.id);
                    if (channelIds.length === 0) {
                        await interaction.editReply('当前没有配置任何处罚公告频道');
                        return;
                    }

                    const lines = [];
                    for (const channelId of channelIds) {
                        const channel = await client.channels.fetch(channelId).catch(() => null);
                        if (channel && channel.isTextBased()) {
                            const guildName = channel.guild?.name || '未知服务器';
                            lines.push(`✅ <#${channelId}> (\`${channelId}\`) - ${guildName}`);
                        } else {
                            lines.push(`⚠️ \`${channelId}\` - 无法访问或非文本频道`);
                        }
                    }

                    await interaction.editReply('**处罚公告频道列表：**\n' + lines.join('\n'));
                    return;
                }

                const channelId = (channelIdInput || selectedChannel?.id || '').trim();
                if (!channelId) {
                    await interaction.editReply('❌ 请提供频道或频道ID');
                    return;
                }

                if (action === 'remove') {
                    const result = removeAnnouncementChannel(interaction.guild.id, channelId);
                    await interaction.editReply(result.changes > 0 ? `✅ 已移除处罚公告频道: \`${channelId}\`` : `ℹ️ 该频道未在公告配置列表中: \`${channelId}\``);
                } else if (action === 'add') {
                    const channel = await client.channels.fetch(channelId).catch(() => null);
                    if (!channel) {
                        await interaction.editReply('❌ 无法获取该频道，请确认机器人已加入频道所属服务器');
                        return;
                    }
                    if (!channel.isTextBased()) {
                        await interaction.editReply('❌ 仅支持文本频道作为处罚公告频道');
                        return;
                    }

                    addAnnouncementChannel(interaction.guild.id, channelId);
                    const guildName = channel.guild?.name || '未知服务器';
                    await interaction.editReply(`✅ 已添加处罚公告频道: <#${channelId}> (\`${channelId}\`)\n所属服务器: ${guildName}`);
                }
                break;
            }
            case '配置警告身份组': {
                const role = interaction.options.getRole('身份组');
                setWarnRoleForGuild(interaction.guild.id, role.id);
                await interaction.editReply(`✅ 已将警告身份组设置为 <@&${role.id}>`);
                break;
            }
            case '配置同步服务器': {
                const action = interaction.options.getString('操作');
                const targetGuildId = interaction.options.getString('目标服务器id');

                if (action === 'list') {
                    const targets = listSyncTargets(interaction.guild.id);
                    if (targets.length === 0) {
                        await interaction.editReply('当前没有配置任何同步目标服务器');
                        return;
                    }
                    const lines = [];
                    for (const t of targets) {
                        const guild = await client.guilds.fetch(t.target_guild_id).catch(() => null);
                        const name = guild ? guild.name : '未知';
                        const status = t.enabled ? '✅' : '❌';
                        lines.push(`${status} ${name} (\`${t.target_guild_id}\`)`);
                    }
                    await interaction.editReply(
                        '**同步目标服务器列表：**\n' + lines.join('\n') +
                        '\n\nℹ️ 同步关系为单向（当前服 → 目标服），如需双向请在对方服务器也添加当前服务器。'
                    );
                    return;
                }

                if (!targetGuildId) {
                    await interaction.editReply('❌ 请提供目标服务器ID');
                    return;
                }

                if (action === 'add') {
                    const targetGuild = await client.guilds.fetch(targetGuildId).catch(() => null);
                    if (!targetGuild) {
                        await interaction.editReply('❌ 无法获取目标服务器，请确认机器人已加入该服务器');
                        return;
                    }
                    addSyncTarget(interaction.guild.id, targetGuildId);
                    await interaction.editReply(
                        `✅ 已添加同步目标服务器: ${targetGuild.name} (\`${targetGuildId}\`)\nℹ️ 当前配置是单向同步（本服务器 → 目标服务器），若要双向请在目标服务器也添加本服务器。`
                    );
                } else if (action === 'remove') {
                    removeSyncTarget(interaction.guild.id, targetGuildId);
                    await interaction.editReply(`✅ 已移除同步目标服务器: \`${targetGuildId}\``);
                }
                break;
            }
            case '查询记录': {
                const targetUser = interaction.options.getUser('用户');
                const records = getPunishmentRecords(interaction.guild.id, targetUser.id);

                if (records.length === 0) {
                    await interaction.editReply(`用户 <@${targetUser.id}> 没有处罚记录`);
                    return;
                }

                const TYPE_LABELS = {
                    ban: '🔨 封禁',
                    unban: '✅ 解封',
                    mute: '🔇 禁言',
                    warn_role: '⚠️ 警告',
                    unmute: '🔊 解除禁言',
                };

                const lines = records.map(r => {
                    const timestamp = Math.floor(new Date(r.created_at).getTime() / 1000);
                    let line = `${TYPE_LABELS[r.type] || r.type} - <t:${timestamp}:f>`;
                    if (r.reason) line += ` | ${r.reason}`;
                    if (r.duration_ms) {
                        const hours = Math.round(r.duration_ms / 3600000);
                        line += ` | ${hours >= 24 ? `${Math.round(hours / 24)}天` : `${hours}小时`}`;
                    }
                    line += ` | ${r.status === 'active' ? '生效中' : r.status === 'expired' ? '已过期' : r.status}`;
                    return line;
                });

                const embed = new EmbedBuilder()
                    .setTitle(`处罚记录 - ${targetUser.username}`)
                    .setDescription(lines.join('\n'))
                    .setColor(0x5865F2)
                    .setTimestamp();

                await interaction.editReply({ embeds: [embed] });
                break;
            }
        }
    } catch (err) {
        console.error('[Punishment] 命令执行出错:', err);
        try {
            await interaction.editReply(`❌ 执行出错: ${err.message}`);
        } catch (_) {}
    }
}

module.exports = { data, execute };
