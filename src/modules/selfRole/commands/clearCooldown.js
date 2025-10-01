// src/modules/selfRole/commands/clearCooldown.js

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const { clearSelfRoleCooldown } = require('../../../core/utils/database');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('自助身份组申请-解除申请冷却')
        .setDescription('解除某用户对指定身份组的申请冷却期')
        .addUserOption(option =>
            option
                .setName('用户')
                .setDescription('需要解除冷却的用户')
                .setRequired(true)
        )
        .addRoleOption(option =>
            option
                .setName('身份组')
                .setDescription('需要解除冷却的目标身份组')
                .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    /**
     * 执行解除申请冷却指令
     * 说明：
     * - 此指令用于管理员在特殊情况下为某用户解除针对某身份组的“被拒后冷却期”
     * - 仅对“自助身份组申请模块”中配置了人工审核的身份组生效（拒绝后设置了冷却天数）
     */
    async execute(interaction) {
        // 鉴权
        if (!checkAdminPermission(interaction.member)) {
            return interaction.reply({ content: getPermissionDeniedMessage(), ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const guildId = interaction.guild.id;
            const targetUser = interaction.options.getUser('用户', true);
            const targetRole = interaction.options.getRole('身份组', true);

            // 清除被拒后冷却期记录
            await clearSelfRoleCooldown(guildId, targetRole.id, targetUser.id);

            // 成功提示
            await interaction.editReply({
                content: `✅ 已解除用户 <@${targetUser.id}> 对身份组 <@&${targetRole.id}> 的申请冷却期。`,
            });

        } catch (error) {
            console.error('[SelfRole] ❌ 解除申请冷却期时出错:', error);
            await interaction.editReply({
                content: '❌ 解除申请冷却期时发生错误，请检查机器人或用户权限或稍后重试。实在不行拷打shin',
            });
        }
    },
};