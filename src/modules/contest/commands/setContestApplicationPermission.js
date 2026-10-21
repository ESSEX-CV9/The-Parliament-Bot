const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getContestSettings, saveContestSettings } = require('../utils/contestDatabase');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('赛事-设置申请权限')
    .setDescription('管理全服赛事申请的前置身份组')
    .setDefaultMemberPermissions(0)
    .addSubcommand(command => command
        .setName('设置')
        .setDescription('替换全服赛事申请的前置身份组')
        .addRoleOption(option => option.setName('身份组')
            .setDescription('申请赛事必须持有的身份组（包括管理员）')
            .setRequired(true)))
    .addSubcommand(command => command.setName('查看').setDescription('查看全服赛事申请的前置身份组'))
    .addSubcommand(command => command.setName('清除').setDescription('清除前置身份组，允许所有成员申请'));

async function execute(interaction) {
    if (!interaction.guild) {
        return interaction.reply({ content: '❌ 此指令只能在服务器中使用，不能在私信中使用。', flags: MessageFlags.Ephemeral });
    }
    if (!checkAdminPermission(interaction.member)) {
        return interaction.reply({ content: getPermissionDeniedMessage(), flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
        const settings = await getContestSettings(interaction.guild.id);
        if (!settings || !Object.values(settings.tracks || {}).some(track => track.reviewForumId && track.contestCategoryId)) {
            return interaction.editReply({ content: '❌ 请先使用 `/赛事-设置赛事申请入口` 设置赛事申请入口。' });
        }
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === '设置') {
            const role = interaction.options.getRole('身份组', true);
            settings.applicationPermissionRoles = [role.id];
            await saveContestSettings(settings);
            return interaction.editReply({ content: `✅ 全服赛事申请前置身份组已设为 <@&${role.id}>（ID：\`${role.id}\`）。所有轨道及已有入口立即生效，管理员申请时也必须持有该身份组。` });
        }
        if (subcommand === '清除') {
            settings.applicationPermissionRoles = [];
            await saveContestSettings(settings);
            return interaction.editReply({ content: '✅ 已清除全服赛事申请前置身份组，所有成员均可申请赛事。' });
        }

        const roleIds = settings.applicationPermissionRoles;
        if (roleIds === undefined || (Array.isArray(roleIds) && roleIds.length === 0)) {
            return interaction.editReply({ content: '全服赛事申请当前不限制前置身份组，所有成员均可申请。' });
        }
        if (!Array.isArray(roleIds) || !roleIds.every(id => typeof id === 'string' && id.length > 0)) {
            return interaction.editReply({ content: '❌ 前置身份组配置无效，请重新设置或清除；当前配置未改动。' });
        }
        const descriptions = await Promise.all(roleIds.map(async id => {
            try {
                const role = await interaction.guild.roles.fetch(id, { force: true });
                return role ? `• <@&${id}>（ID：\`${id}\`）` : `• ID：\`${id}\`（已失效或已删除）`;
            } catch (_) {
                return `• ID：\`${id}\`（无效或暂时无法确认，请检查身份组）`;
            }
        }));
        return interaction.editReply({ content: `**全服赛事申请前置身份组**（持有任一身份组即可；管理员也需满足）：\n${descriptions.join('\n')}\n失效身份组不会自动清除，请使用本指令重新设置或清除。` });
    } catch (error) {
        console.error('设置赛事申请权限失败:', error);
        return interaction.editReply({ content: '❌ 处理赛事申请权限失败，请稍后重试。' });
    }
}

module.exports = { data, execute };
