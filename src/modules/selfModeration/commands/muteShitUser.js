// src\modules\selfModeration\commands\muteShitUser.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getSelfModerationSettings } = require('../../../core/utils/database');
const { checkSelfModerationPermission, checkSelfModerationChannelPermission, getSelfModerationPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const { validateChannel } = require('../utils/channelValidator');
const { processMessageUrlSubmission } = require('../services/moderationService');

const data = new SlashCommandBuilder()
    .setName('禁言搬屎用户')
    .setDescription('发起禁言搬屎用户的投票')
    .addStringOption(option => 
        option.setName('消息链接')
            .setDescription('搬屎用户发送的消息链接（右键消息 -> 复制消息链接）')
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
        const hasPermission = checkSelfModerationPermission(interaction.member, 'mute', settings);
        if (!hasPermission) {
            return interaction.editReply({
                content: getSelfModerationPermissionDeniedMessage('mute')
            });
        }

        // 检查频道权限
        const channelAllowed = await validateChannel(interaction.channel.id, settings, interaction.channel);
        if (!channelAllowed) {
            return interaction.editReply({
                content: '❌ 此频道不允许使用自助管理功能。请在管理员设置的允许频道中使用此指令。'
            });
        }

        const messageUrl = interaction.options.getString('消息链接');
        
        console.log(`用户 ${interaction.user.tag} 在频道 ${interaction.channel.name} 发起禁言用户投票`);
        console.log(`目标消息链接: ${messageUrl}`);

        // 调用通用的消息处理函数
        await processMessageUrlSubmission(interaction, 'mute', messageUrl);
        
    } catch (error) {
        console.error('执行禁言搬屎用户指令时出错:', error);
        
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