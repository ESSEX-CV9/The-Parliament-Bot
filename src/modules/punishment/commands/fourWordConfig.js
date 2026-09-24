const { SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const { checkAdminPermission } = require('../../../core/utils/permissionManager');
const { parseDuration } = require('../utils/timeParser');
const { getWarnRoleForGuild } = require('../services/punishmentDatabase');
const { getFourWordConfig, updateFourWordConfig, validDuration, MAX_TIMEOUT_MS } = require('../services/fourWordConfig');

const data = new SlashCommandBuilder().setName('四字配置').setDescription('配置四字处罚和恢复').setDefaultMemberPermissions(0)
    .addChannelOption(o => o.setName('公示频道').setDescription('四字固定话术公示频道').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addRoleOption(o => o.setName('正常身份组').setDescription('处罚前及恢复后的身份组'))
    .addRoleOption(o => o.setName('处罚身份组').setDescription('处罚后的身份组'))
    .addStringOption(o => o.setName('固定话术').setDescription('四字处罚额外公示的内容').setMaxLength(1900))
    .addStringOption(o => o.setName('禁言').setDescription('例如 2h、3d，纯数字按天，不超过28天'))
    .addStringOption(o => o.setName('警告').setDescription('例如 7d、12h，纯数字按天'))
    .addRoleOption(o => o.setName('可用身份组').setDescription('授权使用四字处罚与恢复的身份组，默认添加'))
    .addStringOption(o => o.setName('操作').setDescription('对可用身份组执行添加或移除，默认添加')
        .addChoices({ name: '添加', value: 'add' }, { name: '移除', value: 'remove' }));

async function replyText(interaction, text) {
    for (let start = 0; start < text.length; start += 1900) {
        const payload = { content: text.slice(start, start + 1900), allowedMentions: { parse: [] } };
        if (start === 0) await interaction.editReply(payload);
        else await interaction.followUp({ ...payload, ephemeral: true });
    }
}

async function execute(interaction) {
    if (!interaction.guild || !checkAdminPermission(interaction.member)) {
        await interaction.reply({ content: '❌ 你没有权限使用此命令', ephemeral: true });
        return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
        const guildId = interaction.guild.id;
        const config = getFourWordConfig(guildId);
        const updates = {};
        const channel = interaction.options.getChannel('公示频道');
        if (channel) updates.publicChannelId = channel.id;
        for (const [name, key] of [['正常身份组', 'normalRoleId'], ['处罚身份组', 'penaltyRoleId']]) {
            const role = interaction.options.getRole(name);
            if (!role) continue;
            if (role.managed || role.id === guildId) throw new Error('不能使用托管身份组或 @everyone。');
            if (role.id === getWarnRoleForGuild(guildId)) throw new Error('不能与原警告身份组相同。');
            if (role.permissions.has(PermissionFlagsBits.Administrator)) {
                throw new Error(`${name}不能拥有「管理员（Administrator）」权限。`);
            }
            updates[key] = role.id;
        }
        if ((updates.normalRoleId || updates.penaltyRoleId) &&
            (updates.normalRoleId || config.normalRoleId) === (updates.penaltyRoleId || config.penaltyRoleId)) {
            throw new Error('正常身份组和处罚身份组不能相同。');
        }
        const message = interaction.options.getString('固定话术');
        if (message !== null) {
            updates.message = message.trim();
            if (!updates.message) throw new Error('固定话术不能为空。');
        }
        for (const [name, key] of [['禁言', 'muteDuration'], ['警告', 'warnDuration']]) {
            const input = interaction.options.getString(name);
            if (input === null) continue;
            const duration = parseDuration(input);
            if (!validDuration(duration)) throw new Error(`${name}时长无效，请使用 2h、3d 或纯数字（天）。`);
            if (key === 'muteDuration' && duration.ms > MAX_TIMEOUT_MS) throw new Error('禁言时长不能超过 28 天。');
            updates[key] = duration;
        }
        const action = interaction.options.getString('操作');
        const accessRole = interaction.options.getRole('可用身份组');
        if (action && !accessRole) throw new Error('请提供要添加或移除的可用身份组。');
        if (accessRole) {
            updates.allowedRoleIds = action === 'remove' ? config.allowedRoleIds.filter(id => id !== accessRole.id)
                : [...new Set([...config.allowedRoleIds, accessRole.id])];
        }
        const roleList = () => config.allowedRoleIds.map(id => `<@&${id}>`).join('、') || '未配置（仅管理员可用）';
        if (!Object.keys(updates).length) {
            const warnId = getWarnRoleForGuild(guildId);
            await replyText(interaction, [
                '**四字配置**',
                `公示频道：${config.publicChannelId ? `<#${config.publicChannelId}>` : '未配置'}`,
                `正常身份组：${config.normalRoleId ? `<@&${config.normalRoleId}>` : '未配置'}`,
                `处罚身份组：${config.penaltyRoleId ? `<@&${config.penaltyRoleId}>` : '未配置'}`,
                `原处罚系统警告身份组：${warnId ? `<@&${warnId}>` : '未配置'}`,
                `禁言时间：${config.muteDuration?.label || '未配置'}`,
                `警告时间：${config.warnDuration?.label || '未配置'}`,
                `可用身份组：${roleList()}`, `固定话术：${config.message || '未配置'}`,
            ].join('\n'));
            return;
        }
        updateFourWordConfig(guildId, updates);
        await replyText(interaction, '✅ 四字配置已更新。');
    } catch (error) {
        console.error('[FourWord] 配置失败:', error);
        await replyText(interaction, `❌ ${error.message}`);
    }
}

module.exports = { data, execute };
