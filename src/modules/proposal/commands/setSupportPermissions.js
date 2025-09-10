// src/modules/proposal/commands/setSupportPermissions.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { saveSupportPermissionSettings, getSupportPermissionSettings } = require('../../../core/utils/database');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('提案-设置支持提案的身份组')
    .setDescription('设置可以支持提案的身份组权限')
    .addSubcommand(subcommand =>
        subcommand
            .setName('add')
            .setDescription('添加允许支持提案的身份组')
            .addRoleOption(option =>
                option.setName('身份组')
                    .setDescription('要添加的身份组')
                    .setRequired(true))
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('remove')
            .setDescription('移除允许支持提案的身份组')
            .addRoleOption(option =>
                option.setName('身份组')
                    .setDescription('要移除的身份组')
                    .setRequired(true))
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('list')
            .setDescription('查看当前允许支持提案的身份组')
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('clear')
            .setDescription('清除所有支持权限限制（允许所有人支持）')
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
        let currentSettings = await getSupportPermissionSettings(guildId) || {
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
                
                await saveSupportPermissionSettings(guildId, currentSettings);
                
                await interaction.editReply({
                    content: `✅ 已添加身份组 **${roleToAdd.name}** 到提案支持权限列表。\n\n现在拥有此身份组的成员可以支持提案。`
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
                
                await saveSupportPermissionSettings(guildId, currentSettings);
                
                await interaction.editReply({
                    content: `✅ 已从提案支持权限列表中移除身份组 **${roleToRemove.name}**。`
                });
                break;

            case 'list':
                if (!currentSettings.allowedRoles || currentSettings.allowedRoles.length === 0) {
                    return interaction.editReply({
                        content: `📋 **当前提案支持权限设置**\n\n❌ 未设置权限限制 - 所有成员都可以支持提案\n\n*使用 \`/setsupportpermissions add\` 来添加权限限制*`
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
                    content: `📋 **当前提案支持权限设置**\n\n✅ **允许支持提案的身份组：**\n${roleNames.map(name => `• ${name}`).join('\n')}\n\n*最后更新：<t:${Math.floor(new Date(currentSettings.updatedAt).getTime() / 1000)}:f>*`
                });
                break;

            case 'clear':
                currentSettings.allowedRoles = [];
                currentSettings.updatedBy = interaction.user.id;
                currentSettings.updatedAt = new Date().toISOString();
                
                await saveSupportPermissionSettings(guildId, currentSettings);
                
                await interaction.editReply({
                    content: `✅ 已清除所有提案支持权限限制。\n\n现在所有成员都可以支持提案。`
                });
                break;

            default:
                await interaction.editReply({
                    content: '❌ 未知的子命令。'
                });
                break;
        }

        console.log(`支持按钮权限设置操作完成 - 子命令: ${subcommand}, 操作者: ${interaction.user.tag}`);

    } catch (error) {
        console.error('设置支持按钮权限时出错:', error);
        console.error('错误堆栈:', error.stack);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: `❌ 设置支持按钮权限时出错：${error.message}\n请查看控制台获取详细信息。`,
                    flags: MessageFlags.Ephemeral
                });
            } else {
                await interaction.editReply({
                    content: `❌ 设置支持按钮权限时出错：${error.message}\n请查看控制台获取详细信息。`
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