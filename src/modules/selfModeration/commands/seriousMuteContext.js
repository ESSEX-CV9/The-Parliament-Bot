// src\modules\selfModeration\commands\seriousMuteContext.js
const {
    ContextMenuCommandBuilder,
    ApplicationCommandType,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    MessageFlags
} = require('discord.js');
const { runSelfModerationPreChecks } = require('../utils/entryGuard');
const { SERIOUS_MUTE_CONTEXT_MODAL_PREFIX } = require('../services/moderationService');

/**
 * 「禁言极端不适发言用户」的右键入口。
 *
 * 该指令有「是否提前删除消息」和「原消息描述」两个参数，而右键指令无法携带参数，
 * 因此右键后弹窗收集这两项。弹窗的提交由 moderationService.handleSelfModerationModal
 * 统一处理（customId 以 selfmod_modal_ 开头，走已有的路由分支）。
 *
 * 注意：showModal 必须是本次交互的首个响应，所以这里不能先 deferReply，
 * 前置校验全部走内存/本地文件读取，不会触发 3 秒超时。
 */
const data = new ContextMenuCommandBuilder()
    .setName('禁言此极端不适发言用户')
    .setType(ApplicationCommandType.Message);

async function execute(interaction) {
    try {
        // 仅限服务器中使用
        if (!interaction.guild) {
            return interaction.reply({
                content: '❌ 此指令只能在服务器中使用，不能在私信中使用。',
                flags: MessageFlags.Ephemeral
            });
        }

        // 通用前置校验：配置 / 权限 / 黑名单 / 冷却 / 当前频道
        // （弹窗提交后还会再校验一次，防止填表期间状态变化）
        const preCheck = await runSelfModerationPreChecks(interaction, 'serious_mute');
        if (!preCheck.ok) {
            return interaction.reply({
                content: preCheck.message,
                flags: MessageFlags.Ephemeral
            });
        }

        const targetMessage = interaction.targetMessage;

        // 把目标消息定位信息编码进 customId，弹窗提交时交互对象已拿不到 targetMessage
        const modal = new ModalBuilder()
            .setCustomId(`${SERIOUS_MUTE_CONTEXT_MODAL_PREFIX}${targetMessage.channelId}_${targetMessage.id}`)
            .setTitle('禁言极端不适发言用户');

        const descInput = new TextInputBuilder()
            .setCustomId('original_description')
            .setLabel('原消息描述')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(200)
            .setPlaceholder('在投票公告中展示的对原消息的简要描述（选择提前删除时必填）');

        const earlyDeleteInput = new TextInputBuilder()
            .setCustomId('early_delete')
            .setLabel('是否提前删除消息（是 / 否）')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(4)
            .setPlaceholder('留空默认为「是」：达到5个🚫时立即删除原消息');

        modal.addComponents(
            new ActionRowBuilder().addComponents(descInput),
            new ActionRowBuilder().addComponents(earlyDeleteInput)
        );

        await interaction.showModal(modal);

        console.log(`用户 ${interaction.user.tag} 在频道 ${interaction.channel.name} 通过右键打开严肃禁言弹窗，目标消息: ${targetMessage.id}`);

    } catch (error) {
        console.error('执行右键严肃禁言指令时出错:', error);

        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ 处理指令时出现错误，请稍后重试。',
                    flags: MessageFlags.Ephemeral
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
