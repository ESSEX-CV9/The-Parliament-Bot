// src/modules/botMessage/commands/editBotMessageContext.js
const {
    ContextMenuCommandBuilder,
    ApplicationCommandType,
    PermissionFlagsBits,
    MessageFlags,
} = require('discord.js');

const {
    ensurePermission,
    buildEditPicker,
    canOpenModalDirectly,
} = require('../services/botMessageService');
const { buildContentModal, buildEmbedModal } = require('../components/messageModals');

const data = new ContextMenuCommandBuilder()
    .setName('编辑机器人消息')
    .setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages);

async function execute(interaction) {
    if (!await ensurePermission(interaction)) return;

    const message = interaction.targetMessage;
    const botId = interaction.client.user.id;

    if (message.author?.id !== botId) {
        await interaction.reply({
            content: [
                `❌ 这条消息不是由本机器人（<@${botId}>）发出的，无法编辑。`,
                '',
                'Discord 只允许机器人编辑自己发出的消息。',
            ].join('\n'),
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    if (!message.editable) {
        await interaction.reply({
            content: '❌ 这条消息当前不可编辑（常见原因：所在子区已归档或被锁定，请先解除归档/锁定后重试）。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    // 简单消息直接弹窗，省掉一次点击；复杂消息（多卡片 / 带按钮）先给选择面板
    const fastPath = canOpenModalDirectly(message);

    if (fastPath === 'content') {
        await interaction.showModal(buildContentModal(message));
        return;
    }

    if (fastPath === 'embed0') {
        const modalResult = buildEmbedModal(message, 0);
        if (modalResult.ok) {
            await interaction.showModal(modalResult.modal);
        } else {
            await interaction.reply({ content: modalResult.error, flags: MessageFlags.Ephemeral });
        }
        return;
    }

    const picker = buildEditPicker(message);
    await interaction.reply({ ...picker, flags: MessageFlags.Ephemeral });
}

module.exports = {
    data,
    execute,
};
