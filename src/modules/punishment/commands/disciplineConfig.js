const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { checkAdminPermission } = require('../../../core/utils/permissionManager');
const { parseDuration } = require('../utils/timeParser');
const {
    getDisciplineAllowedRoles,
    setDisciplineAllowedRoles,
    getDisciplineLimits,
    setDisciplineLimits,
} = require('../services/punishmentDatabase');

const MAX_TIMEOUT_MS = 28 * 24 * 3600 * 1000; // Discord timeout 上限 28 天

const data = new SlashCommandBuilder()
    .setName('风纪配置')
    .setDescription('配置风纪指令（可用身份组与时长上限）')
    .setDefaultMemberPermissions(0)
    .addSubcommand(sub => sub
        .setName('身份组')
        .setDescription('管理可以使用 /风纪 指令的身份组')
        .addStringOption(opt => opt
            .setName('操作')
            .setDescription('添加、移除或查看列表')
            .setRequired(true)
            .addChoices(
                { name: '添加', value: 'add' },
                { name: '移除', value: 'remove' },
                { name: '查看列表', value: 'list' },
            ))
        .addRoleOption(opt => opt.setName('身份组').setDescription('要添加或移除的身份组').setRequired(false))
    )
    .addSubcommand(sub => sub
        .setName('上限')
        .setDescription('设置风纪禁言/警告的时长上限（至少填一项）')
        .addStringOption(opt => opt.setName('禁言上限').setDescription('如 2h 或 3d（禁言不超过 28 天）').setRequired(false))
        .addStringOption(opt => opt.setName('警告上限').setDescription('如 7d 或 12h').setRequired(false))
    )
    .addSubcommand(sub => sub
        .setName('查看')
        .setDescription('查看当前风纪配置')
    );

async function execute(interaction) {
    if (!checkAdminPermission(interaction.member)) {
        await interaction.reply({ content: '❌ 你没有权限使用此命令', ephemeral: true });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    try {
        switch (sub) {
            case '身份组': {
                const action = interaction.options.getString('操作');
                const role = interaction.options.getRole('身份组');

                if (action === 'list') {
                    const roleIds = getDisciplineAllowedRoles(guildId);
                    if (roleIds.length === 0) {
                        await interaction.editReply('当前没有配置任何风纪身份组（仅管理员可用 /风纪）');
                        return;
                    }
                    const lines = roleIds.map(id => `• <@&${id}> (\`${id}\`)`);
                    await interaction.editReply('**风纪可用身份组：**\n' + lines.join('\n'));
                    return;
                }

                if (!role) {
                    await interaction.editReply('❌ 请提供要添加或移除的身份组');
                    return;
                }

                const roleIds = getDisciplineAllowedRoles(guildId);
                if (action === 'add') {
                    if (roleIds.includes(role.id)) {
                        await interaction.editReply(`ℹ️ <@&${role.id}> 已在风纪可用名单中`);
                        return;
                    }
                    roleIds.push(role.id);
                    setDisciplineAllowedRoles(guildId, roleIds);
                    await interaction.editReply(`✅ 已将 <@&${role.id}> 加入风纪可用名单`);
                } else if (action === 'remove') {
                    if (!roleIds.includes(role.id)) {
                        await interaction.editReply(`ℹ️ <@&${role.id}> 不在风纪可用名单中`);
                        return;
                    }
                    setDisciplineAllowedRoles(guildId, roleIds.filter(id => id !== role.id));
                    await interaction.editReply(`✅ 已将 <@&${role.id}> 移出风纪可用名单`);
                }
                break;
            }
            case '上限': {
                const muteStr = interaction.options.getString('禁言上限');
                const warnStr = interaction.options.getString('警告上限');

                if (!muteStr && !warnStr) {
                    await interaction.editReply('❌ 请至少提供「禁言上限」或「警告上限」其中一项');
                    return;
                }

                const updates = {};

                if (muteStr) {
                    const muteDuration = parseDuration(muteStr);
                    if (!muteDuration) {
                        await interaction.editReply('❌ 禁言上限格式错误，请使用如 `2h`（2小时）、`3d`（3天）');
                        return;
                    }
                    if (muteDuration.ms > MAX_TIMEOUT_MS) {
                        await interaction.editReply('❌ 禁言上限不能超过 28 天（Discord 限制）');
                        return;
                    }
                    updates.maxMuteMs = muteDuration.ms;
                    updates.maxMuteLabel = muteDuration.label;
                }

                if (warnStr) {
                    const warnDuration = parseDuration(warnStr);
                    if (!warnDuration) {
                        await interaction.editReply('❌ 警告上限格式错误，请使用如 `7d`（7天）、`12h`（12小时）');
                        return;
                    }
                    updates.maxWarnMs = warnDuration.ms;
                    updates.maxWarnLabel = warnDuration.label;
                }

                setDisciplineLimits(guildId, updates);
                const limits = getDisciplineLimits(guildId);
                await interaction.editReply(
                    `✅ 已更新风纪时长上限：\n禁言上限: ${limits.maxMuteLabel}\n警告上限: ${limits.maxWarnLabel}`
                );
                break;
            }
            case '查看': {
                const roleIds = getDisciplineAllowedRoles(guildId);
                const limits = getDisciplineLimits(guildId);

                const rolesText = roleIds.length > 0
                    ? roleIds.map(id => `<@&${id}>`).join('、')
                    : '未配置（仅管理员可用 /风纪）';

                const embed = new EmbedBuilder()
                    .setTitle('风纪配置')
                    .setColor(0x5865F2)
                    .addFields(
                        { name: '可用身份组', value: rolesText, inline: false },
                        { name: '禁言上限', value: limits.maxMuteLabel, inline: true },
                        { name: '警告上限', value: limits.maxWarnLabel, inline: true },
                    )
                    .setTimestamp();

                await interaction.editReply({ embeds: [embed] });
                break;
            }
        }
    } catch (err) {
        console.error('[Discipline] 配置命令执行出错:', err);
        try {
            await interaction.editReply(`❌ 执行出错: ${err.message}`);
        } catch (_) {}
    }
}

module.exports = { data, execute };
