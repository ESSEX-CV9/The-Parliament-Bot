// src\modules\selfModeration\commands\checkMyCooldown.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { checkUserGlobalCooldown } = require('../../../core/utils/database');

const data = new SlashCommandBuilder()
    .setName('搬石公投-查看我的冷却')
    .setDescription('查看您当前的自助管理功能冷却状态');

async function execute(interaction) {
    try {
        // 检查是否在服务器中使用
        if (!interaction.guild) {
            return interaction.reply({
                content: '❌ 此指令只能在服务器中使用，不能在私信中使用。',
                flags: MessageFlags.Ephemeral
            });
        }

        // 立即defer以防止超时
        await interaction.deferReply({ ephemeral: true });

        // 检查删除消息冷却
        const deleteCooldown = await checkUserGlobalCooldown(interaction.guild.id, interaction.user.id, 'delete');
        // 检查禁言用户冷却
        const muteCooldown = await checkUserGlobalCooldown(interaction.guild.id, interaction.user.id, 'mute');
        // 检查严肃禁言冷却
        const seriousMuteCooldown = await checkUserGlobalCooldown(interaction.guild.id, interaction.user.id, 'serious_mute');

        let response = `**🕐 您的冷却状态**\n\n`;

        // 删除消息状态
        if (deleteCooldown.cooldownMinutes === 0) {
            response += `🗑️ **删除消息：** 无冷却限制\n`;
        } else if (deleteCooldown.inCooldown) {
            const hours = Math.floor(deleteCooldown.remainingMinutes / 60);
            const minutes = deleteCooldown.remainingMinutes % 60;
            let timeText = '';
            if (hours > 0) timeText += `${hours}小时`;
            if (minutes > 0) timeText += `${minutes}分钟`;
            
            response += `🗑️ **删除消息：** ❌ 冷却中，还需等待 **${timeText}**\n`;
        } else {
            response += `🗑️ **删除消息：** ✅ 可以使用\n`;
        }

        // 禁言用户状态
        if (muteCooldown.cooldownMinutes === 0) {
            response += `🔇 **禁言用户：** 无冷却限制\n`;
        } else if (muteCooldown.inCooldown) {
            const hours = Math.floor(muteCooldown.remainingMinutes / 60);
            const minutes = muteCooldown.remainingMinutes % 60;
            let timeText = '';
            if (hours > 0) timeText += `${hours}小时`;
            if (minutes > 0) timeText += `${minutes}分钟`;
            
            response += `🔇 **禁言用户：** ❌ 冷却中，还需等待 **${timeText}**\n`;
        } else {
            response += `🔇 **禁言用户：** ✅ 可以使用\n`;
        }

        // 严肃禁言状态
        if (seriousMuteCooldown.cooldownMinutes === 0) {
            response += `🚨 **严肃禁言：** 无冷却限制\n`;
        } else if (seriousMuteCooldown.inCooldown) {
            const hours = Math.floor(seriousMuteCooldown.remainingMinutes / 60);
            const minutes = seriousMuteCooldown.remainingMinutes % 60;
            let timeText = '';
            if (hours > 0) timeText += `${hours}小时`;
            if (minutes > 0) timeText += `${minutes}分钟`;

            response += `🚨 **严肃禁言：** ❌ 冷却中，还需等待 **${timeText}**\n`;
        } else {
            response += `🚨 **严肃禁言：** ✅ 可以使用\n`;
        }

        await interaction.editReply({ content: response });

    } catch (error) {
        console.error('执行查看冷却状态指令时出错:', error);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ 处理指令时出现错误，请稍后重试。',
                    flags: MessageFlags.Ephemeral
                });
            } else {
                await interaction.editReply({
                    content: '❌ 处理指令时出现错误，请稍后重试。'
                });
            }
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

module.exports = {
    data,
    execute,
};
