const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { ElectionPermissions } = require('../data/electionDatabase');
const { validateAdminPermission } = require('../utils/validationUtils');
const { createErrorEmbed, createSuccessEmbed } = require('../utils/messageUtils');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('设置允许募选投票身份组')
        .setDescription('设置哪些身份组的成员可以参与募选投票（服务器级别持久化配置）')
        .addSubcommand(subcommand =>
            subcommand
                .setName('设置')
                .setDescription('设置允许投票的身份组')
                .addRoleOption(option =>
                    option.setName('身份组1')
                        .setDescription('允许投票的身份组')
                        .setRequired(true))
                .addRoleOption(option =>
                    option.setName('身份组2')
                        .setDescription('允许投票的身份组（可选）')
                        .setRequired(false))
                .addRoleOption(option =>
                    option.setName('身份组3')
                        .setDescription('允许投票的身份组（可选）')
                        .setRequired(false))
                .addRoleOption(option =>
                    option.setName('身份组4')
                        .setDescription('允许投票的身份组（可选）')
                        .setRequired(false))
                .addRoleOption(option =>
                    option.setName('身份组5')
                        .setDescription('允许投票的身份组（可选）')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('查看')
                .setDescription('查看当前的投票权限配置'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('清空')
                .setDescription('清空投票权限限制（允许所有人投票）'))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            // 验证权限 - 使用核心权限管理器
            if (!validateAdminPermission(interaction.member)) {
                const errorEmbed = createErrorEmbed('缺少指定的身份组', '只有管理员或指定身份组成员可以设置募选权限');
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            const guildId = interaction.guild.id;
            const subcommand = interaction.options.getSubcommand();

            if (subcommand === '查看') {
                const permissions = await ElectionPermissions.getByGuild(guildId);
                
                if (!permissions.votingRoles || permissions.votingRoles.length === 0) {
                    const embed = createSuccessEmbed(
                        '投票权限配置',
                        '🗳️ **当前投票权限：** 无限制（所有人都可以投票）\n\n' +
                        '⚠️ 管理员始终拥有投票权限'
                    );
                    return await interaction.editReply({ embeds: [embed] });
                }

                // 获取身份组名称
                const roleNames = [];
                for (const roleId of permissions.votingRoles) {
                    const role = interaction.guild.roles.cache.get(roleId);
                    if (role) {
                        roleNames.push(role.name);
                    } else {
                        roleNames.push(`未知身份组 (${roleId})`);
                    }
                }

                const embed = createSuccessEmbed(
                    '投票权限配置',
                    `🗳️ **允许投票的身份组：**\n${roleNames.map(name => `• ${name}`).join('\n')}\n\n` +
                    `⚠️ 管理员始终拥有投票权限`
                );
                return await interaction.editReply({ embeds: [embed] });
            }

            if (subcommand === '清空') {
                await ElectionPermissions.clearVotingRoles(guildId);
                
                const successEmbed = createSuccessEmbed(
                    '投票权限清空成功',
                    '🗳️ **投票权限配置已清空**\n\n' +
                    '✅ 现在所有服务器成员都可以参与募选投票\n' +
                    '⚠️ 管理员始终拥有投票权限'
                );
                return await interaction.editReply({ embeds: [successEmbed] });
            }

            if (subcommand === '设置') {
                // 收集所有选择的身份组
                const selectedRoles = [];
                const roleNames = [];

                for (let i = 1; i <= 5; i++) {
                    const role = interaction.options.getRole(`身份组${i}`);
                    if (role) {
                        selectedRoles.push(role.id);
                        roleNames.push(role.name);
                    }
                }

                if (selectedRoles.length === 0) {
                    const errorEmbed = createErrorEmbed('参数错误', '至少需要选择一个身份组');
                    return await interaction.editReply({ embeds: [errorEmbed] });
                }

                // 保存权限配置
                await ElectionPermissions.saveVotingRoles(guildId, selectedRoles);

                const successEmbed = createSuccessEmbed(
                    '投票权限设置成功',
                    `🗳️ **允许投票的身份组：**\n${roleNames.map(name => `• ${name}`).join('\n')}\n\n` +
                    `✅ 只有拥有以上身份组的成员才能参与募选投票\n` +
                    `⚠️ 管理员始终拥有投票权限\n\n` +
                    `💾 **配置已持久化保存**，将在所有未来的募选中生效`
                );

                await interaction.editReply({ embeds: [successEmbed] });
            }

        } catch (error) {
            console.error('设置投票权限时出错:', error);
            const errorEmbed = createErrorEmbed('系统错误', '处理命令时发生错误，请稍后重试');
            
            if (interaction.deferred) {
                await interaction.editReply({ embeds: [errorEmbed] });
            } else {
                await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            }
        }
    }
}; 