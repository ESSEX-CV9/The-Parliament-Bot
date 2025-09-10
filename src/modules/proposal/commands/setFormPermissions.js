// src/modules/proposal/commands/setFormPermissions.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { saveFormPermissionSettings, getFormPermissionSettings } = require('../../../core/utils/database');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('提案-设置可以使用表单的身份组')
    .setDescription('设置可以使用表单的身份组权限')
    .addSubcommand(subcommand =>
        subcommand
            .setName('add')
            .setDescription('添加允许使用表单的身份组')
            .addRoleOption(option =>
                option.setName('身份组')
                    .setDescription('要添加的身份组')
                    .setRequired(true))
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('remove')
            .setDescription('移除允许使用表单的身份组')
            .addRoleOption(option =>
                option.setName('身份组')
                    .setDescription('要移除的身份组')
                    .setRequired(true))
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('list')
            .setDescription('查看当前允许使用表单的身份组')
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('clear')
            .setDescription('清除所有表单权限限制（允许所有人使用）')
    );

async function execute(interaction) {
    try {
        // 检查是否在服务器中使用
        if (!interaction.guild) {
            return interaction.reply({
                content: '❌ 此指令只能在服务器中使用，不能在私信中使用。',
                flags: MessageFlags.Ephemeral
            });
        }

        // 检查用户权限
        const hasPermission = checkAdminPermission(interaction.member);
        
        if (!hasPermission) {
            return interaction.reply({
                content: getPermissionDeniedMessage(),
                flags: MessageFlags.Ephemeral
            });
        }

        // 立即defer以防止超时
        await interaction.deferReply({ ephemeral: true });

        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;

        // 获取当前设置
        let currentSettings = await getFormPermissionSettings(guildId) || {
            guildId,
            allowedRoles: [],
            updatedBy: interaction.user.id,
            updatedAt: new Date().toISOString()
        };

        switch (subcommand) {
            case 'add':
                const roleToAdd = interaction.options.getRole('身份组');
                
                if (currentSettings.allowedRoles.includes(roleToAdd.id)) {
                    return interaction.editReply({
                        content: `❌ 身份组 **${roleToAdd.name}** 已经在允许列表中。`
                    });
                }
                
                currentSettings.allowedRoles.push(roleToAdd.id);
                currentSettings.updatedBy = interaction.user.id;
                currentSettings.updatedAt = new Date().toISOString();
                
                await saveFormPermissionSettings(guildId, currentSettings);
                
                await interaction.editReply({
                    content: `✅ 已添加身份组 **${roleToAdd.name}** 到表单使用权限列表。\n\n现在拥有此身份组的成员可以使用表单。`
                });
                break;

            case 'remove':
                const roleToRemove = interaction.options.getRole('身份组');
                
                const roleIndex = currentSettings.allowedRoles.indexOf(roleToRemove.id);
                if (roleIndex === -1) {
                    return interaction.editReply({
                        content: `❌ 身份组 **${roleToRemove.name}** 不在允许列表中。`
                    });
                }
                
                currentSettings.allowedRoles.splice(roleIndex, 1);
                currentSettings.updatedBy = interaction.user.id;
                currentSettings.updatedAt = new Date().toISOString();
                
                await saveFormPermissionSettings(guildId, currentSettings);
                
                await interaction.editReply({
                    content: `✅ 已从表单使用权限列表中移除身份组 **${roleToRemove.name}**。`
                });
                break;

            case 'list':
                if (!currentSettings.allowedRoles || currentSettings.allowedRoles.length === 0) {
                    return interaction.editReply({
                        content: `📋 **当前表单权限设置**\n\n❌ 未设置权限限制 - 所有成员都可以使用表单\n\n*使用 \`/setformpermissions add\` 来添加权限限制*`
                    });
                }

                let roleNames = [];
                for (const roleId of currentSettings.allowedRoles) {
                    try {
                        const role = await interaction.guild.roles.fetch(roleId);
                        roleNames.push(role ? role.name : `未知身份组 (${roleId})`);
                    } catch (error) {
                        roleNames.push(`未知身份组 (${roleId})`);
                    }
                }

                await interaction.editReply({
                    content: `📋 **当前表单权限设置**\n\n✅ **允许使用表单的身份组：**\n${roleNames.map(name => `• ${name}`).join('\n')}\n\n*最后更新：<t:${Math.floor(new Date(currentSettings.updatedAt).getTime() / 1000)}:f>*`
                });
                break;

            case 'clear':
                currentSettings.allowedRoles = [];
                currentSettings.updatedBy = interaction.user.id;
                currentSettings.updatedAt = new Date().toISOString();
                
                await saveFormPermissionSettings(guildId, currentSettings);
                
                await interaction.editReply({
                    content: `✅ 已清除所有表单权限限制。\n\n现在所有成员都可以使用表单。`
                });
                break;

            default:
                await interaction.editReply({
                    content: '❌ 未知的子命令。'
                });
                break;
        }

        console.log(`表单权限设置操作完成 - 子命令: ${subcommand}, 操作者: ${interaction.user.tag}`);

    } catch (error) {
        console.error('设置表单权限时出错:', error);
        console.error('错误堆栈:', error.stack);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: `❌ 设置表单权限时出错：${error.message}\n请查看控制台获取详细信息。`,
                    flags: MessageFlags.Ephemeral
                });
            } else {
                await interaction.editReply({
                    content: `❌ 设置表单权限时出错：${error.message}\n请查看控制台获取详细信息。`
                });
            }
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

module.exports = {
    data,
    execute,
};