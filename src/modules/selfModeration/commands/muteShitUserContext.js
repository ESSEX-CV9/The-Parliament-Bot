// src\modules\selfModeration\commands\muteShitUserContext.js
const { ContextMenuCommandBuilder, ApplicationCommandType, MessageFlags } = require('discord.js');
const { updateUserLastUsage } = require('../../../core/utils/database');
const { runSelfModerationPreChecks } = require('../utils/entryGuard');
const { processMessageUrlSubmission } = require('../services/moderationService');

/**
 * 「禁言搬屎用户」的右键入口。
 * 行为与斜杠指令 /禁言搬屎用户 完全一致，只是消息链接直接取自被右键的消息，
 * 不需要用户手动复制粘贴。
 */
const data = new ContextMenuCommandBuilder()
    .setName('禁言此搬屎用户')
    .setType(ApplicationCommandType.Message);

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

        // 通用前置校验：配置 / 权限 / 黑名单 / 冷却 / 当前频道
        const preCheck = await runSelfModerationPreChecks(interaction, 'mute');
        if (!preCheck.ok) {
            return interaction.editReply({ content: preCheck.message });
        }

        // 直接使用被右键消息的链接
        const messageUrl = interaction.targetMessage.url;

        console.log(`用户 ${interaction.user.tag} 在频道 ${interaction.channel.name} 通过右键发起禁言用户投票`);
        console.log(`目标消息链接: ${messageUrl}`);

        // 调用通用的消息处理函数
        const result = await processMessageUrlSubmission(interaction, 'mute', messageUrl);

        // 仅在成功创建新投票时消耗冷却时间
        if (result?.isNewVote === true) {
            await updateUserLastUsage(interaction.guild.id, interaction.user.id, 'mute');
        }

    } catch (error) {
        console.error('执行右键禁言搬屎用户指令时出错:', error);

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
