const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const MessageDeleteService = require('../services/messageDeleteService');

const data = new SlashCommandBuilder()
    .setName('删除重建消息')
    .setDescription('删除你发布的重建消息')
    .addStringOption(option =>
        option.setName('消息链接')
            .setDescription('要删除的消息链接')
            .setRequired(true)
    );

async function execute(interaction) {
    try {
        const messageLink = interaction.options.getString('消息链接');
        
        // 初始回复
        await interaction.deferReply({ ephemeral: true });
        
        // 创建消息删除服务实例
        const deleteService = new MessageDeleteService();
        
        // 执行删除操作
        const result = await deleteService.processMessageDelete(
            interaction.user.id,
            messageLink,
            interaction.client
        );
        
        // 返回结果
        if (result.success) {
            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('✅ 删除成功')
                .setDescription(result.message)
                .addFields([
                    { name: '消息位置', value: `${result.threadName}`, inline: true }
                ])
                .setTimestamp();
                
            await interaction.editReply({ embeds: [embed] });
        } else {
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('❌ 删除失败')
                .setDescription(result.message)
                .setTimestamp();
                
            await interaction.editReply({ embeds: [embed] });
        }
        
    } catch (error) {
        console.error('删除重建消息命令执行失败:', error);
        
        const errorEmbed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('❌ 系统错误')
            .setDescription('处理请求时发生错误，请稍后再试。')
            .setTimestamp();
            
        if (interaction.deferred) {
            await interaction.editReply({ embeds: [errorEmbed] });
        } else {
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }
    }
}

module.exports = {
    data,
    execute
}; 