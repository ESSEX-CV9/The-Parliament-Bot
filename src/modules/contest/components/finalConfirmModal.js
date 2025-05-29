const { 
    EmbedBuilder,
    ActionRowBuilder, 
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

function createFinalConfirmation(contestChannelId, awardedSubmissionsCount) {
    const embed = new EmbedBuilder()
        .setTitle('⚠️ 最终确认完赛')
        .setDescription(`您即将完成本次比赛，此操作**不可逆转**！\n\n**完赛后将发生以下变化：**\n• 🚫 投稿入口将被永久关闭\n• 📝 不再接受任何新的投稿\n• 🏆 获奖清单将被公布并置顶\n• ⚙️ 比赛状态将被标记为已结束\n\n**当前统计：**\n• 获奖作品数量：${awardedSubmissionsCount} 个\n\n**请再次确认您要完成此次比赛。此操作一旦执行无法撤销！**`)
        .setColor('#FF4444') // 红色警告色
        .setTimestamp();

    const components = [
        new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`final_confirm_cancel_${contestChannelId}`)
                    .setLabel('❌ 取消操作')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`final_confirm_proceed_${contestChannelId}`)
                    .setLabel('✅ 确认完赛（不可逆）')
                    .setStyle(ButtonStyle.Danger)
            )
    ];

    return { embed, components };
}

module.exports = {
    createFinalConfirmation
}; 