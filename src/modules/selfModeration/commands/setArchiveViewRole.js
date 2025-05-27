const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { saveArchiveViewRoleSettings, getArchiveViewRoleSettings, clearArchiveViewRoleSettings } = require('../../../core/utils/database');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('设置归档查看身份组')
    .setDescription('设置可以查看归档频道的身份组')
    .addSubcommand(subcommand =>
        subcommand
            .setName('设置')
            .setDescription('设置归档查看身份组')
            .addRoleOption(option =>
                option.setName('身份组')
                    .setDescription('可以查看归档频道的身份组')
                    .setRequired(true)))
    .addSubcommand(subcommand =>
        subcommand
            .setName('查看')
            .setDescription('查看当前的归档查看身份组设置'))
    .addSubcommand(subcommand =>
        subcommand
            .setName('清除')
            .setDescription('清除归档查看身份组设置'));

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

        switch (subcommand) {
            case '设置':
                await handleSetRole(interaction);
                break;
            case '查看':
                await handleViewRole(interaction);
                break;
            case '清除':
                await handleClearRole(interaction);
                break;
        }

    } catch (error) {
        console.error('执行设置归档查看身份组指令时出错:', error);
        
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

async function handleSetRole(interaction) {
    try {
        const role = interaction.options.getRole('身份组');
        
        // 检查身份组是否存在
        if (!role) {
            await interaction.editReply({
                content: '❌ 指定的身份组不存在。'
            });
            return;
        }

        // 检查身份组是否是@everyone
        if (role.id === interaction.guild.id) {
            await interaction.editReply({
                content: '❌ 不能将@everyone设置为归档查看身份组。'
            });
            return;
        }

        // 保存设置
        await saveArchiveViewRoleSettings(interaction.guild.id, role.id);
        
        console.log(`${interaction.user.tag} 设置了归档查看身份组: ${role.name} (${role.id})`);
        
        await interaction.editReply({
            content: `✅ **归档查看身份组设置成功**\n\n📋 **身份组：** ${role}\n\n💡 **说明：** 拥有此身份组的用户可以使用 \`/获取归档查看权限\` 指令来自助获取查看归档频道的权限。`
        });
        
    } catch (error) {
        console.error('设置归档查看身份组时出错:', error);
        await interaction.editReply({
            content: '❌ 设置归档查看身份组时出现错误。'
        });
    }
}

async function handleViewRole(interaction) {
    try {
        const roleId = await getArchiveViewRoleSettings(interaction.guild.id);
        
        if (!roleId) {
            await interaction.editReply({
                content: '❌ **未设置归档查看身份组**\n\n请使用 `/设置归档查看身份组 设置` 指令来设置归档查看身份组。'
            });
            return;
        }

        // 尝试获取身份组信息
        try {
            const role = await interaction.guild.roles.fetch(roleId);
            if (role) {
                await interaction.editReply({
                    content: `✅ **当前归档查看身份组**\n\n📋 **身份组：** ${role}\n📊 **成员数量：** ${role.members.size} 人\n\n💡 **说明：** 拥有此身份组的用户可以使用 \`/获取归档查看权限\` 指令来自助获取查看归档频道的权限。`
                });
            } else {
                await interaction.editReply({
                    content: `❌ **身份组不存在**\n\n设置的身份组 (ID: \`${roleId}\`) 已被删除，请重新设置。`
                });
            }
        } catch (fetchError) {
            await interaction.editReply({
                content: `❌ **身份组不存在**\n\n设置的身份组 (ID: \`${roleId}\`) 已被删除，请重新设置。`
            });
        }
        
    } catch (error) {
        console.error('查看归档查看身份组时出错:', error);
        await interaction.editReply({
            content: '❌ 查看归档查看身份组时出现错误。'
        });
    }
}

async function handleClearRole(interaction) {
    try {
        const roleId = await getArchiveViewRoleSettings(interaction.guild.id);
        
        if (!roleId) {
            await interaction.editReply({
                content: '❌ 当前没有设置归档查看身份组，无需清除。'
            });
            return;
        }

        await clearArchiveViewRoleSettings(interaction.guild.id);
        
        console.log(`${interaction.user.tag} 清除了归档查看身份组设置`);
        
        await interaction.editReply({
            content: '✅ **归档查看身份组设置已清除**\n\n现在用户无法通过自助指令获取归档查看权限。'
        });
        
    } catch (error) {
        console.error('清除归档查看身份组时出错:', error);
        await interaction.editReply({
            content: '❌ 清除归档查看身份组时出现错误。'
        });
    }
}

module.exports = {
    data,
    execute,
}; 