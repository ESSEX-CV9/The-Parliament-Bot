// src\modules\selfModeration\commands\deleteShitMessage.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getSelfModerationSettings,checkUserGlobalCooldown, updateUserLastUsage } = require('../../../core/utils/database');
const { checkSelfModerationPermission, checkSelfModerationChannelPermission, getSelfModerationPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const { validateChannel } = require('../utils/channelValidator');
const { processMessageUrlSubmission } = require('../services/moderationService');

const data = new SlashCommandBuilder()
    .setName('删除搬屎消息')
    .setDescription('发起删除搬屎消息的投票')
    .addStringOption(option => 
        option.setName('消息链接')
            .setDescription('要删除的消息链接（右键消息 -> 复制消息链接）')
            .setRequired(true));

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

        // 获取设置
        const settings = await getSelfModerationSettings(interaction.guild.id);
        if (!settings) {
            return interaction.editReply({
                content: '❌ 该服务器未配置自助管理功能，请联系管理员设置。'
            });
        }

        // 检查用户权限
        const hasPermission = checkSelfModerationPermission(interaction.member, 'delete', settings);
        if (!hasPermission) {
            return interaction.editReply({
                content: getSelfModerationPermissionDeniedMessage('delete')
            });
        }

        // 检查全局冷却时间
        const cooldownCheck = await checkUserGlobalCooldown(interaction.guild.id, interaction.user.id, 'delete');
        if (cooldownCheck.inCooldown) {
            const hours = Math.floor(cooldownCheck.remainingMinutes / 60);
            const minutes = cooldownCheck.remainingMinutes % 60;
            let timeText = '';
            if (hours > 0) timeText += `${hours}小时`;
            if (minutes > 0) timeText += `${minutes}分钟`;
            
            return interaction.editReply({
                content: `❌ 您的删除消息功能正在冷却中，请等待 **${timeText}** 后再试。`
            });
        }

         // 检查当前频道权限（用户使用指令的频道）
        const currentChannelAllowed = await validateChannel(interaction.channel.id, settings, interaction.channel);
        if (!currentChannelAllowed) {
            return interaction.editReply({
                content: '❌ 此频道不允许使用自助管理功能。请在管理员设置的允许频道中使用此指令。'
            });
        }

        const messageUrl = interaction.options.getString('消息链接');
        
        console.log(`用户 ${interaction.user.tag} 在频道 ${interaction.channel.name} 发起删除消息投票`);
        console.log(`目标消息链接: ${messageUrl}`);

        // 调用通用的消息处理函数
        await processMessageUrlSubmission(interaction, 'delete', messageUrl);
        
        // 更新用户最后使用时间（在成功处理后）
        await updateUserLastUsage(interaction.guild.id, interaction.user.id, 'delete');
        
    } catch (error) {
        console.error('执行删除搬屎消息指令时出错:', error);
        
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