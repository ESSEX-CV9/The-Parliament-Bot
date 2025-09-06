// src\modules\selfModeration\commands\seriousMute.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getSelfModerationSettings, checkUserGlobalCooldown, updateUserLastUsage } = require('../../../core/utils/database');
const { checkSelfModerationPermission, checkSelfModerationChannelPermission, getSelfModerationPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const { validateChannel } = require('../utils/channelValidator');
const { processMessageUrlSubmission } = require('../services/moderationService');

/**
 * 本指令为“严肃禁言”入口。仅新增命令文件，复用现有校验与通用流程。
 * 后续由 type=serious_mute 的分支在 reactionTracker/moderationChecker/punishmentExecutor 等处实现差异逻辑。
 */
const data = new SlashCommandBuilder()
    .setName('禁言极端不适发言用户')
    .setDescription('发起对极端不适用户的禁言投票')
    .addStringOption(option =>
        option.setName('消息链接')
            .setDescription('目标用户发送的消息链接（右键消息 -> 复制消息链接）')
            .setRequired(true));

async function execute(interaction) {
    try {
        // 仅限服务器中使用
        if (!interaction.guild) {
            return interaction.reply({
                content: '❌ 此指令只能在服务器中使用，不能在私信中使用。',
                flags: MessageFlags.Ephemeral
            });
        }

        // 立即 defer，避免超时
        await interaction.deferReply({ ephemeral: true });

        // 获取设置
        const settings = await getSelfModerationSettings(interaction.guild.id);
        if (!settings) {
            return interaction.editReply({
                content: '❌ 该服务器未配置自助管理功能，请联系管理员设置。'
            });
        }

        // 权限校验（沿用 mute 权限域，最小改动）
        const hasPermission = checkSelfModerationPermission(interaction.member, 'mute', settings);
        if (!hasPermission) {
            return interaction.editReply({
                content: getSelfModerationPermissionDeniedMessage('mute')
            });
        }

        // 全局冷却校验（沿用 mute 冷却键，最小改动）
        const cooldownCheck = await checkUserGlobalCooldown(interaction.guild.id, interaction.user.id, 'mute');
        if (cooldownCheck.inCooldown) {
            const hours = Math.floor(cooldownCheck.remainingMinutes / 60);
            const minutes = cooldownCheck.remainingMinutes % 60;
            let timeText = '';
            if (hours > 0) timeText += `${hours}小时`;
            if (minutes > 0) timeText += `${minutes}分钟`;

            return interaction.editReply({
                content: `❌ 您的禁言用户功能正在冷却中，请等待 **${timeText}** 后再试。`
            });
        }

        // 当前频道允许校验
        const currentChannelAllowed = await validateChannel(interaction.channel.id, settings, interaction.channel);
        if (!currentChannelAllowed) {
            return interaction.editReply({
                content: '❌ 此频道不允许使用自助管理功能。请在管理员设置的允许频道中使用此指令。'
            });
        }

        const messageUrl = interaction.options.getString('消息链接');

        console.log(`用户 ${interaction.user.tag} 在频道 ${interaction.channel.name} 发起严肃禁言投票`);
        console.log(`目标消息链接: ${messageUrl}`);

        // 统一走通用流程：
        // 仅差异：type 使用 'serious_mute'，并附加 { severity: 'serious' } 透传（当前通用函数可忽略多余参数，后续子任务接入）。
        await processMessageUrlSubmission(interaction, 'serious_mute', messageUrl, { severity: 'serious' });

        // 成功后更新最后使用时间（沿用 mute 键，最小改动）
        await updateUserLastUsage(interaction.guild.id, interaction.user.id, 'mute');

    } catch (error) {
        console.error('执行严肃禁言指令时出错:', error);

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