// src/modules/selfRole/commands/debugRoles.js

const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('自助身份组申请-debug-roles')
        .setDescription('【调试】获取并显示服务器内所有身份组的详细信息')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        if (!checkAdminPermission(interaction.member)) {
            return interaction.reply({ content: getPermissionDeniedMessage(), ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            // 强制从API获取最新的身份组列表，绕过缓存
            const roles = await interaction.guild.roles.fetch();
            
            const sortedRoles = roles.sort((a, b) => b.position - a.position);

            let description = '以下是机器人通过API获取到的所有身份组列表，按层级从高到低排列：\n\n';
            sortedRoles.forEach(role => {
                description += `**名称**: ${role.name}\n`;
                description += `**ID**: \`${role.id}\`\n`;
                description += `**层级 (Position)**: ${role.position}\n`;
                description += `**由集成管理?**: ${role.managed ? '是' : '否'}\n`;
                description += `----------\n`;
            });

            const embed = new EmbedBuilder()
                .setTitle('🛠️ 身份组调试信息')
                .setDescription(description)
                .setColor(0xFFD700) // Gold
                .setTimestamp();

            // 由于描述可能很长，如果超过Discord限制，则分多条消息发送
            if (description.length > 4000) {
                await interaction.editReply({ content: '身份组列表过长，将分多条消息发送：' });
                const chunks = description.match(/[\s\S]{1,1900}/g) || [];
                for (const chunk of chunks) {
                    await interaction.followUp({ content: `\`\`\`\n${chunk}\`\`\``, ephemeral: true });
                }
            } else {
                await interaction.editReply({ embeds: [embed] });
            }

        } catch (error) {
            console.error('[SelfRole-Debug] ❌ 获取身份组列表时出错:', error);
            await interaction.editReply({ content: '❌ 获取身份组列表时发生错误。' });
        }
    },
};