const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const { displayService } = require('../services/displayService');

const data = new SlashCommandBuilder()
    .setName('cachestats')
    .setDescription('查看比赛系统缓存统计信息（管理员专用）');

async function execute(interaction) {
    try {
        // 检查用户权限
        const hasPermission = checkAdminPermission(interaction.member);
        
        if (!hasPermission) {
            return interaction.reply({
                content: getPermissionDeniedMessage(),
                flags: MessageFlags.Ephemeral
            });
        }
        
        const stats = displayService.getCacheStats();
        
        const statsMessage = `**📊 比赛系统缓存统计**\n\n` +
            `**投稿数据缓存：** ${stats.submissionCacheSize} 个\n` +
            `**频道数据缓存：** ${stats.contestChannelCacheSize} 个\n` +
            `**缓存超时时间：** ${stats.cacheTimeout / 1000} 秒\n\n` +
            `缓存会自动清理过期数据，有新投稿时也会自动清除相关缓存。`;
        
        await interaction.reply({
            content: statsMessage,
            flags: MessageFlags.Ephemeral
        });
        
    } catch (error) {
        console.error('获取缓存统计时出错:', error);
        await interaction.reply({
            content: '❌ 获取缓存统计时出现错误。',
            flags: MessageFlags.Ephemeral
        });
    }
}

module.exports = {
    data,
    execute
}; 