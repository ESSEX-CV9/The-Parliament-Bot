// src/modules/proposal/commands/setProposalReviewers.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { saveProposalSettings, getProposalSettings } = require('../utils/proposalDatabase');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('设置议案审核员')
    .setDescription('管理议案审核员身份组')
    .addSubcommand(subcommand =>
        subcommand
            .setName('添加')
            .setDescription('添加审核员身份组')
            .addRoleOption(option =>
                option.setName('身份组')
                    .setDescription('要添加的审核员身份组')
                    .setRequired(true))
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('移除')
            .setDescription('移除审核员身份组')
            .addRoleOption(option =>
                option.setName('身份组')
                    .setDescription('要移除的审核员身份组')
                    .setRequired(true))
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('列表')
            .setDescription('查看当前审核员身份组')
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('清除')
            .setDescription('清除所有审核员身份组（只有管理员可审核）')
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
        let currentSettings = await getProposalSettings(guildId) || {
            guildId,
            reviewerRoles: []
        };

        if (!currentSettings.reviewerRoles) {
            currentSettings.reviewerRoles = [];
        }

        switch (subcommand) {
            case '添加':
                const roleToAdd = interaction.options.getRole('身份组');
                
                if (currentSettings.reviewerRoles.includes(roleToAdd.id)) {
                    return interaction.editReply({
                        content: `❌ 身份组 **${roleToAdd.name}** 已经是审核员了。`
                    });
                }
                
                currentSettings.reviewerRoles.push(roleToAdd.id);
                await saveProposalSettings(guildId, currentSettings);
                
                await interaction.editReply({
                    content: `✅ 已添加身份组 **${roleToAdd.name}** 为议案审核员。\n\n现在拥有此身份组的成员可以审核议案申请。`
                });
                break;

            case '移除':
                const roleToRemove = interaction.options.getRole('身份组');
                
                const roleIndex = currentSettings.reviewerRoles.indexOf(roleToRemove.id);
                if (roleIndex === -1) {
                    return interaction.editReply({
                        content: `❌ 身份组 **${roleToRemove.name}** 不是审核员。`
                    });
                }
                
                currentSettings.reviewerRoles.splice(roleIndex, 1);
                await saveProposalSettings(guildId, currentSettings);
                
                await interaction.editReply({
                    content: `✅ 已移除身份组 **${roleToRemove.name}** 的审核员权限。`
                });
                break;

            case '列表':
                if (currentSettings.reviewerRoles.length === 0) {
                    return interaction.editReply({
                        content: `📋 **当前审核员设置**\n\n❌ 未设置审核员身份组 - 只有管理员可以审核\n\n*使用 \`/设置议案审核员 添加\` 来添加审核员身份组*`
                    });
                }

                let roleNames = [];
                for (const roleId of currentSettings.reviewerRoles) {
                    try {
                        const role = await interaction.guild.roles.fetch(roleId);
                        roleNames.push(role ? role.name : `未知身份组 (${roleId})`);
                    } catch (error) {
                        roleNames.push(`未知身份组 (${roleId})`);
                    }
                }

                await interaction.editReply({
                    content: `📋 **当前审核员设置**\n\n✅ **审核员身份组：**\n${roleNames.map(name => `• ${name}`).join('\n')}\n\n*管理员始终拥有审核权限*`
                });
                break;

            case '清除':
                currentSettings.reviewerRoles = [];
                await saveProposalSettings(guildId, currentSettings);
                
                await interaction.editReply({
                    content: `✅ 已清除所有审核员身份组。\n\n现在只有管理员可以审核议案申请。`
                });
                break;

            default:
                await interaction.editReply({
                    content: '❌ 未知的子命令。'
                });
                break;
        }

        console.log(`议案审核员设置操作完成 - 子命令: ${subcommand}, 操作者: ${interaction.user.tag}`);

    } catch (error) {
        console.error('设置议案审核员时出错:', error);
        console.error('错误堆栈:', error.stack);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: `❌ 设置审核员时出错：${error.message}\n请查看控制台获取详细信息。`,
                    flags: MessageFlags.Ephemeral
                });
            } else {
                await interaction.editReply({
                    content: `❌ 设置审核员时出错：${error.message}\n请查看控制台获取详细信息。`
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