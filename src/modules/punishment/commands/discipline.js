const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
    checkDisciplinePermission,
    getDisciplinePermissionDeniedMessage,
} = require('../../../core/utils/permissionManager');
const { parseDuration } = require('../utils/timeParser');
const { executeMute, executeWarnRole, executeUnmute } = require('../services/punishmentExecutor');
const { getPunishmentRecords, getDisciplineAllowedRoles, getDisciplineLimits } = require('../services/punishmentDatabase');

const data = new SlashCommandBuilder()
    .setName('风纪')
    .setDescription('风纪委员处罚工具（受限版）')
    .setDefaultMemberPermissions(0)
    .addSubcommand(sub => sub
        .setName('禁言')
        .setDescription('对成员执行超时禁言（受时长上限约束）')
        .addUserOption(opt => opt.setName('用户').setDescription('要禁言的用户').setRequired(true))
        .addStringOption(opt => opt.setName('时长').setDescription('时长格式：2h 或 3d').setRequired(true))
        .addStringOption(opt => opt.setName('原因').setDescription('禁言原因').setRequired(false))
        .addBooleanOption(opt => opt.setName('同步').setDescription('是否同步至关联服务器（默认开启）').setRequired(false))
    )
    .addSubcommand(sub => sub
        .setName('警告')
        .setDescription('为成员添加警告身份组（受时长上限约束，到期自动移除）')
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
        .setName('查询记录')
        .setDescription('查询某用户的处罚记录')
        .addUserOption(opt => opt.setName('用户').setDescription('要查询的用户').setRequired(true))
    );

async function execute(interaction) {
    const allowedRoles = getDisciplineAllowedRoles(interaction.guild.id);
    if (!checkDisciplinePermission(interaction.member, allowedRoles)) {
        await interaction.reply({ content: getDisciplinePermissionDeniedMessage(), ephemeral: true });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    const sub = interaction.options.getSubcommand();
    const client = interaction.client;

    try {
        switch (sub) {
            case '禁言': {
                const targetUser = interaction.options.getUser('用户');
                const durationStr = interaction.options.getString('时长');
                const reason = interaction.options.getString('原因');
                const sync = interaction.options.getBoolean('同步') ?? true;

                const duration = parseDuration(durationStr);
                if (!duration) {
                    await interaction.editReply('❌ 时长格式错误，请使用如 `2h`（2小时）、`3d`（3天）或直接输入数字（默认天）');
                    return;
                }

                const limits = getDisciplineLimits(interaction.guild.id);
                if (duration.ms > limits.maxMuteMs) {
                    await interaction.editReply(`❌ 禁言时长超过上限，风纪禁言最长为 ${limits.maxMuteLabel}`);
                    return;
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
                    warnDuration: null,
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

                const limits = getDisciplineLimits(interaction.guild.id);
                if (duration.ms > limits.maxWarnMs) {
                    await interaction.editReply(`❌ 警告时长超过上限，风纪警告最长为 ${limits.maxWarnLabel}`);
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
        console.error('[Discipline] 命令执行出错:', err);
        try {
            await interaction.editReply(`❌ 执行出错: ${err.message}`);
        } catch (_) {}
    }
}

module.exports = { data, execute };
