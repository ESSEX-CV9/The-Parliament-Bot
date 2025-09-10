// src/modules/selfRole/commands/setupAdminPanel.js

const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('自助身份组申请-创建管理面板')
        .setDescription('在当前频道创建一个自助身份组的管理面板')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        if (!checkAdminPermission(interaction.member)) {
            return interaction.reply({ content: getPermissionDeniedMessage(), ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const embed = new EmbedBuilder()
                .setTitle('🛠️ 自助身份组管理面板')
                .setDescription('请使用下方的按钮来管理可供申请的身份组。')
                .setColor(0x5865F2);

            const addRoleButton = new ButtonBuilder()
                .setCustomId('admin_add_role_button')
                .setLabel('➕ 添加身份组')
                .setStyle(ButtonStyle.Success);

            const removeRoleButton = new ButtonBuilder()
                .setCustomId('admin_remove_role_button')
                .setLabel('➖ 移除身份组')
                .setStyle(ButtonStyle.Danger);

            const editRoleButton = new ButtonBuilder()
                .setCustomId('admin_edit_role_button')
                .setLabel('✏️ 修改配置')
                .setStyle(ButtonStyle.Primary);
                
            const listRolesButton = new ButtonBuilder()
                .setCustomId('admin_list_roles_button')
                .setLabel('📋 查看已配置')
                .setStyle(ButtonStyle.Secondary);

            const row = new ActionRowBuilder().addComponents(addRoleButton, removeRoleButton, editRoleButton, listRolesButton);

            await interaction.channel.send({ embeds: [embed], components: [row] });

            console.log(`[SelfRole] ✅ 在频道 ${interaction.channel.name} 成功创建管理面板。`);
            await interaction.editReply({ content: '✅ 管理面板已成功创建！' });

        } catch (error) {
            console.error('[SelfRole] ❌ 创建管理面板时出错:', error);
            await interaction.editReply({ content: '❌ 创建面板时发生错误，请检查机器人是否拥有在此频道发送消息的权限。' });
        }
    },
};