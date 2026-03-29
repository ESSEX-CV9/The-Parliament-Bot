// src/modules/selfRole/commands/setupAdminPanel.js

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
} = require('discord.js');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const {
    getActiveSelfRolePanels,
    registerSelfRolePanelMessage,
} = require('../../../core/utils/database');

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
            const guildId = interaction.guild.id;

            // 1) 停用旧管理面板（若存在）
            const oldPanels = await getActiveSelfRolePanels(guildId, 'admin');
            let disabledOldCount = 0;
            for (const p of oldPanels) {
                try {
                    const ch = await interaction.guild.channels.fetch(p.channelId).catch(() => null);
                    if (!ch || !ch.isTextBased()) continue;
                    const oldMsg = await ch.messages.fetch(p.messageId).catch(() => null);
                    if (!oldMsg) continue;
                    await oldMsg.edit({ components: [] }).catch(() => {});
                    disabledOldCount++;
                } catch (_) {
                    // 忽略单条失败
                }
            }

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

            const sent = await interaction.channel.send({ embeds: [embed], components: [row] });

            // 2) 注册新面板（DB 会将同类型旧面板标记为 inactive）
            await registerSelfRolePanelMessage(guildId, interaction.channel.id, sent.id, 'admin');

            console.log(`[SelfRole] ✅ 在频道 ${interaction.channel.name} 成功创建管理面板。`);
            const suffix = disabledOldCount > 0 ? `（已停用旧面板 ${disabledOldCount} 个）` : '';
            await interaction.editReply({ content: `✅ 管理面板已成功创建！${suffix}` });

        } catch (error) {
            console.error('[SelfRole] ❌ 创建管理面板时出错:', error);
            await interaction.editReply({ content: '❌ 创建面板时发生错误，请检查机器人是否拥有在此频道发送消息的权限。' });
        }
    },
};