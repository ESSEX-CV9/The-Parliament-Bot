const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { validateAdminPermission } = require('../utils/validationUtils');
const { ElectionPermissions } = require('../data/electionDatabase');
const { createErrorEmbed, createSuccessEmbed } = require('../utils/messageUtils');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('募选-设置募选通知身份组')
        .setDescription('设置募选阶段通知时要@的身份组')
        .addStringOption(option =>
            option.setName('阶段')
                .setDescription('要设置的阶段')
                .setRequired(true)
                .addChoices(
                    { name: '报名阶段', value: 'registration' },
                    { name: '投票阶段', value: 'voting' }
                ))
        .addRoleOption(option =>
            option.setName('身份组')
                .setDescription('要@的身份组（留空则清除设置）')
                .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            // 验证权限
            if (!validateAdminPermission(interaction.member)) {
                const errorEmbed = createErrorEmbed('权限不足', '只有管理员可以设置募选通知身份组');
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            const guildId = interaction.guild.id;
            const phase = interaction.options.getString('阶段');
            const role = interaction.options.getRole('身份组');

            if (role) {
                // 设置身份组
                await ElectionPermissions.saveNotificationRoles(guildId, phase, role.id);
                
                const phaseName = phase === 'registration' ? '报名阶段' : '投票阶段';
                const successEmbed = createSuccessEmbed(
                    '通知身份组设置成功',
                    `**阶段：** ${phaseName}\n**身份组：** ${role}\n\n当${phaseName}开始时，系统会@该身份组进行通知。`
                );
                
                await interaction.editReply({ embeds: [successEmbed] });
            } else {
                // 清除设置
                await ElectionPermissions.clearNotificationRole(guildId, phase);
                
                const phaseName = phase === 'registration' ? '报名阶段' : '投票阶段';
                const successEmbed = createSuccessEmbed(
                    '通知身份组已清除',
                    `**阶段：** ${phaseName}\n\n该阶段的通知将不会@任何身份组。`
                );
                
                await interaction.editReply({ embeds: [successEmbed] });
            }

        } catch (error) {
            console.error('设置通知身份组时出错:', error);
            const errorEmbed = createErrorEmbed('系统错误', '处理命令时发生错误，请稍后重试');
            
            if (interaction.deferred) {
                await interaction.editReply({ embeds: [errorEmbed] });
            } else {
                await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            }
        }
    }
}; 