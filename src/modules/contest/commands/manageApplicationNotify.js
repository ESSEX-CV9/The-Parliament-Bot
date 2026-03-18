// src/modules/contest/commands/manageApplicationNotify.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { saveContestSettings, getContestSettings } = require('../utils/contestDatabase');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('赛事-管理申请通知身份组')
    .setDescription('管理收到赛事申请时需要被@通知的身份组')
    .addSubcommand(subcommand =>
        subcommand
            .setName('添加')
            .setDescription('添加一个在收到新申请时会被@通知的身份组')
            .addRoleOption(option =>
                option.setName('身份组')
                    .setDescription('要添加的通知身份组')
                    .setRequired(true))
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('移除')
            .setDescription('移除一个通知身份组')
            .addRoleOption(option =>
                option.setName('身份组')
                    .setDescription('要移除的通知身份组')
                    .setRequired(true))
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('列表')
            .setDescription('查看当前所有通知身份组')
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('清除')
            .setDescription('清除所有通知身份组')
    );

async function execute(interaction) {
    try {
        if (!interaction.guild) {
            return interaction.reply({
                content: '❌ 此指令只能在服务器中使用，不能在私信中使用。',
                flags: MessageFlags.Ephemeral
            });
        }

        const hasPermission = checkAdminPermission(interaction.member);
        if (!hasPermission) {
            return interaction.reply({
                content: getPermissionDeniedMessage(),
                flags: MessageFlags.Ephemeral
            });
        }

        await interaction.deferReply({ ephemeral: true });

        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;

        let currentSettings = await getContestSettings(guildId) || { guildId, applicationNotifyRoles: [] };
        if (!currentSettings.applicationNotifyRoles) {
            currentSettings.applicationNotifyRoles = [];
        }

        switch (subcommand) {
            case '添加': {
                const role = interaction.options.getRole('身份组');
                if (currentSettings.applicationNotifyRoles.includes(role.id)) {
                    return interaction.editReply({
                        content: `❌ 身份组 **${role.name}** 已经在通知列表中了。`
                    });
                }
                currentSettings.applicationNotifyRoles.push(role.id);
                await saveContestSettings(guildId, currentSettings);
                await interaction.editReply({
                    content: `✅ 已添加身份组 **${role.name}** 到申请通知列表。\n\n今后每当有新的赛事申请提交，该身份组将在审核帖中被@通知。`
                });
                break;
            }

            case '移除': {
                const role = interaction.options.getRole('身份组');
                const index = currentSettings.applicationNotifyRoles.indexOf(role.id);
                if (index === -1) {
                    return interaction.editReply({
                        content: `❌ 身份组 **${role.name}** 不在通知列表中。`
                    });
                }
                currentSettings.applicationNotifyRoles.splice(index, 1);
                await saveContestSettings(guildId, currentSettings);
                await interaction.editReply({
                    content: `✅ 已从申请通知列表中移除身份组 **${role.name}**。`
                });
                break;
            }

            case '列表': {
                if (currentSettings.applicationNotifyRoles.length === 0) {
                    return interaction.editReply({
                        content: `📋 **当前申请通知身份组**\n\n未设置任何通知身份组，有新申请时不会主动@任何人。\n\n*使用 \`/赛事-管理申请通知身份组 添加\` 来添加身份组*`
                    });
                }
                const roleNames = [];
                for (const roleId of currentSettings.applicationNotifyRoles) {
                    try {
                        const role = await interaction.guild.roles.fetch(roleId);
                        roleNames.push(role ? role.name : `未知身份组 (${roleId})`);
                    } catch {
                        roleNames.push(`未知身份组 (${roleId})`);
                    }
                }
                await interaction.editReply({
                    content: `📋 **当前申请通知身份组**\n\n${roleNames.map(n => `• ${n}`).join('\n')}\n\n共 ${roleNames.length} 个通知身份组。有新申请时，以上身份组将在审核帖中被@。`
                });
                break;
            }

            case '清除': {
                currentSettings.applicationNotifyRoles = [];
                await saveContestSettings(guildId, currentSettings);
                await interaction.editReply({
                    content: `✅ 已清除所有申请通知身份组。\n\n今后有新申请提交时，不会主动@任何身份组。`
                });
                break;
            }

            default:
                await interaction.editReply({ content: '❌ 未知的子命令。' });
        }

        console.log(`申请通知身份组操作完成 - 子命令: ${subcommand}, 操作者: ${interaction.user.tag}`);

    } catch (error) {
        console.error('管理申请通知身份组时出错:', error);
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: `❌ 操作失败：${error.message}`,
                    flags: MessageFlags.Ephemeral
                });
            } else {
                await interaction.editReply({ content: `❌ 操作失败：${error.message}` });
            }
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

module.exports = { data, execute };
