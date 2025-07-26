// src/modules/selfRole/commands/setupRolePanel.js

const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('创建自助身份组面板')
        .setDescription('在当前频道创建一个自助身份组的申请入口')
        .addStringOption(option =>
            option.setName('标题')
                .setDescription('面板的标题')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('描述')
                .setDescription('面板的描述内容')
                .setRequired(false)
        )
        .addStringOption(option =>
            option.setName('按钮文字')
                .setDescription('按钮上显示的文字')
                .setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        if (!checkAdminPermission(interaction.member)) {
            return interaction.reply({ content: getPermissionDeniedMessage(), ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const title = interaction.options.getString('标题');
            const description = interaction.options.getString('描述') || '点击下方的按钮开始申请身份组。';
            const buttonText = interaction.options.getString('按钮文字') || '申请身份组';

            const embed = new EmbedBuilder()
                .setTitle(title)
                .setDescription(description)
                .setColor(0x5865F2);

            const applyButton = new ButtonBuilder()
                .setCustomId('self_role_apply_button')
                .setLabel(buttonText)
                .setStyle(ButtonStyle.Primary);

            const row = new ActionRowBuilder().addComponents(applyButton);

            await interaction.channel.send({ embeds: [embed], components: [row] });

            console.log(`[SelfRole] ✅ 在频道 ${interaction.channel.name} 成功创建自助身份组申请面板。`);
            await interaction.editReply({ content: '✅ 申请面板已成功创建！' });

        } catch (error) {
            console.error('[SelfRole] ❌ 创建自助身份组面板时出错:', error);
            await interaction.editReply({ content: '❌ 创建面板时发生错误，请检查机器人是否拥有在此频道发送消息的权限。' });
        }
    },
};