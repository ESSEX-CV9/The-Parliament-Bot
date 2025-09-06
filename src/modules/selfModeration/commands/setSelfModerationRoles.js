// src\modules\selfModeration\commands\setSelfModerationRoles.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getSelfModerationSettings, saveSelfModerationSettings } = require('../../../core/utils/database');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('搬石公投-设置自助管理权限')
    .setDescription('设置哪些身份组可以使用自助管理功能')
    .addSubcommand(subcommand =>
        subcommand
            .setName('删除权限')
            .setDescription('设置可以发起删除消息投票的身份组')
            .addRoleOption(option =>
                option.setName('身份组')
                    .setDescription('允许使用删除消息功能的身份组')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('操作')
                    .setDescription('添加或移除该身份组')
                    .setRequired(true)
                    .addChoices(
                        { name: '添加', value: 'add' },
                        { name: '移除', value: 'remove' }
                    )))
    .addSubcommand(subcommand =>
        subcommand
            .setName('禁言权限')
            .setDescription('设置可以发起禁言用户投票的身份组')
            .addRoleOption(option =>
                option.setName('身份组')
                    .setDescription('允许使用禁言用户功能的身份组')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('操作')
                    .setDescription('添加或移除该身份组')
                    .setRequired(true)
                    .addChoices(
                        { name: '添加', value: 'add' },
                        { name: '移除', value: 'remove' }
                    )))
    .addSubcommand(subcommand =>
        subcommand
            .setName('查看')
            .setDescription('查看当前的权限配置'));

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

        if (subcommand === '查看') {
            await handleViewPermissions(interaction);
        } else {
            await handleModifyPermissions(interaction, subcommand);
        }

    } catch (error) {
        console.error('执行设置自助管理权限指令时出错:', error);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ 处理指令时出现错误，请稍后重试。',
                    flags: MessageFlags.Ephemeral
                });
            } else {
                await interaction.editReply({
                    content: '❌ 处理指令时出现错误，请稍后重试。'
                });
            }
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

async function handleViewPermissions(interaction) {
    try {
        const settings = await getSelfModerationSettings(interaction.guild.id);
        
        let response = '**🛡️ 自助管理权限配置**\n\n';
        
        if (!settings) {
            response += '❌ 未配置自助管理权限，默认使用管理员权限。';
        } else {
            // 删除权限
            if (settings.deleteRoles && settings.deleteRoles.length > 0) {
                response += '**🗑️ 删除消息权限：**\n';
                for (const roleId of settings.deleteRoles) {
                    response += `• <@&${roleId}>\n`;
                }
            } else {
                response += '**🗑️ 删除消息权限：** 未配置（使用管理员权限）\n';
            }
            
            response += '\n';
            
            // 禁言权限
            if (settings.muteRoles && settings.muteRoles.length > 0) {
                response += '**🔇 禁言用户权限：**\n';
                for (const roleId of settings.muteRoles) {
                    response += `• <@&${roleId}>\n`;
                }
            } else {
                response += '**🔇 禁言用户权限：** 未配置（使用管理员权限）\n';
            }
        }
        
        await interaction.editReply({ content: response });
        
    } catch (error) {
        console.error('查看权限配置时出错:', error);
        await interaction.editReply({
            content: '❌ 查看权限配置时出现错误。'
        });
    }
}

async function handleModifyPermissions(interaction, permissionType) {
    try {
        const role = interaction.options.getRole('身份组');
        const operation = interaction.options.getString('操作');
        
        // 获取当前设置
        let settings = await getSelfModerationSettings(interaction.guild.id);
        if (!settings) {
            settings = {
                guildId: interaction.guild.id,
                deleteRoles: [],
                muteRoles: [],
                allowedChannels: []
            };
        }
        
        const roleArrayKey = permissionType === '删除权限' ? 'deleteRoles' : 'muteRoles';
        const actionName = permissionType === '删除权限' ? '删除消息' : '禁言用户';
        
        // 确保数组存在
        if (!settings[roleArrayKey]) {
            settings[roleArrayKey] = [];
        }
        
        let response = '';
        
        if (operation === 'add') {
            if (settings[roleArrayKey].includes(role.id)) {
                response = `❌ 身份组 ${role} 已经拥有${actionName}权限。`;
            } else {
                settings[roleArrayKey].push(role.id);
                response = `✅ 已给身份组 ${role} 添加${actionName}权限。`;
            }
        } else if (operation === 'remove') {
            const index = settings[roleArrayKey].indexOf(role.id);
            if (index === -1) {
                response = `❌ 身份组 ${role} 没有${actionName}权限。`;
            } else {
                settings[roleArrayKey].splice(index, 1);
                response = `✅ 已移除身份组 ${role} 的${actionName}权限。`;
            }
        }
        
        // 保存设置
        await saveSelfModerationSettings(interaction.guild.id, settings);
        
        console.log(`${interaction.user.tag} ${operation === 'add' ? '添加' : '移除'}了身份组 ${role.name} 的${actionName}权限`);
        
        await interaction.editReply({ content: response });
        
    } catch (error) {
        console.error('修改权限配置时出错:', error);
        await interaction.editReply({
            content: '❌ 修改权限配置时出现错误。'
        });
    }
}

module.exports = {
    data,
    execute,
};