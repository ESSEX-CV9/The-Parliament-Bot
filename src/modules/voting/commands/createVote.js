const { SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('开启投票')
        .setDescription('创建一个新的投票')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    
    async execute(interaction) {
        try {
            // 创建设置投票按钮
            const setupButton = new ButtonBuilder()
                .setCustomId('vote_setup')
                .setLabel('📊 设置投票')
                .setStyle(ButtonStyle.Primary);

            const row = new ActionRowBuilder()
                .addComponents(setupButton);

            // 发送只有用户能看到的消息
            await interaction.reply({
                content: '点击下方按钮来设置投票详情：',
                components: [row],
                ephemeral: true
            });

        } catch (error) {
            console.error('创建投票命令错误:', error);
            await interaction.reply({
                content: '❌ 创建投票失败，请稍后重试',
                ephemeral: true
            });
        }
    }
}; 