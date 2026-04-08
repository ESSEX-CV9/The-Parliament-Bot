// src\modules\selfModeration\commands\seriousMute.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getSelfModerationSettings, checkUserGlobalCooldown, updateUserLastUsage } = require('../../../core/utils/database');
const { checkSelfModerationPermission, checkSelfModerationChannelPermission, getSelfModerationPermissionDeniedMessage, checkSelfModerationBlacklist, getSelfModerationBlacklistMessage } = require('../../../core/utils/permissionManager');
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
            .setRequired(true))
    .addBooleanOption(option =>
        option.setName('是否提前删除消息')
            .setDescription('达到5个🚫时是否立即删除原消息')
            .setRequired(false))
    .addStringOption(option =>
        option.setName('原消息描述')
            .setDescription('在投票公告中展示的对原消息的简要描述')
            .setRequired(false)
            .setMaxLength(200));

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

        // 检查用户是否在黑名单中
        const blacklistCheck = await checkSelfModerationBlacklist(interaction.guild.id, interaction.user.id);
        if (blacklistCheck.isBlacklisted) {
            return interaction.editReply({
                content: getSelfModerationBlacklistMessage(blacklistCheck.reason, blacklistCheck.expiresAt)
            });
        }

        // 全局冷却校验（独立于普通禁言）
        const cooldownCheck = await checkUserGlobalCooldown(interaction.guild.id, interaction.user.id, 'serious_mute');
        if (cooldownCheck.inCooldown) {
            const hours = Math.floor(cooldownCheck.remainingMinutes / 60);
            const minutes = cooldownCheck.remainingMinutes % 60;
            let timeText = '';
            if (hours > 0) timeText += `${hours}小时`;
            if (minutes > 0) timeText += `${minutes}分钟`;

            return interaction.editReply({
                content: `❌ 您的严肃禁言功能正在冷却中，请等待 **${timeText}** 后再试。`
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
        const earlyDeleteOpt = interaction.options.getBoolean('是否提前删除消息');
        const earlyDelete = (earlyDeleteOpt === null ? true : earlyDeleteOpt); // 若未提供，默认 true 以保持当前行为
        const originalDesc = interaction.options.getString('原消息描述');

        // 校验：选择提前删除但未提供描述
        if (earlyDelete === true && (!originalDesc || originalDesc.trim().length === 0)) {
            return interaction.editReply({
                content: '❌ 选择了提前删除，需要提供原消息的简单描述。'
            });
        }

        console.log(`用户 ${interaction.user.tag} 在频道 ${interaction.channel.name} 发起严肃禁言投票`);
        console.log(`目标消息链接: ${messageUrl}`);

        // 统一走通用流程：
        // 仅差异：type 使用 'serious_mute'，并附加 { severity: 'serious' } 透传（当前通用函数可忽略多余参数，后续子任务接入）。
        const result = await processMessageUrlSubmission(interaction, 'serious_mute', messageUrl, { severity: 'serious', earlyDelete, originalDescription: originalDesc });

        // 仅在成功创建新投票时消耗冷却时间（独立于普通禁言）
        if (result?.isNewVote === true) {
            await updateUserLastUsage(interaction.guild.id, interaction.user.id, 'serious_mute');
        }

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
