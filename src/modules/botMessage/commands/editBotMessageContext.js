// src/modules/botMessage/commands/editBotMessageContext.js
const {
    ContextMenuCommandBuilder,
    ApplicationCommandType,
} = require('discord.js');

const {
    ensurePermission,
    buildEditPicker,
    canOpenModalDirectly,
    safeRespond,
} = require('../services/botMessageService');
const { buildContentModal, buildEmbedModal } = require('../components/messageModals');
const { describeEditBlock } = require('../utils/messageResolver');

const data = new ContextMenuCommandBuilder()
    .setName('编辑机器人消息')
    .setType(ApplicationCommandType.Message)
    // 同 /机器人消息：默认对所有人隐藏，由服主在「整合 → 权限」里显式放行
    .setDefaultMemberPermissions(0);

async function execute(interaction) {
    if (!await ensurePermission(interaction)) return;

    const message = interaction.targetMessage;
    const botId = interaction.client.user.id;

    if (message.author?.id !== botId) {
        await safeRespond(interaction, {
            content: [
                `❌ 这条消息不是由本机器人（<@${botId}>）发出的，无法编辑。`,
                '',
                'Discord 只允许机器人编辑自己发出的消息。',
            ].join('\n'),
        });
        return;
    }

    // 已归档的子区不算阻塞：编辑时会自动临时解除归档，改完再归档回去
    const block = describeEditBlock(message);
    if (block) {
        await safeRespond(interaction, { content: block });
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
            await safeRespond(interaction, { content: modalResult.error });
        }
        return;
    }

    await safeRespond(interaction, buildEditPicker(message));
}

module.exports = {
    data,
    execute,
};
