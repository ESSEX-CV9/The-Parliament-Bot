// src/modules/botMessage/index.js
const { initializeBotMessageDatabase } = require('./services/botMessageDatabase');
const { IDS } = require('./components/messageModals');
const {
    handlePickerButton,
    handleContentModalSubmit,
    handleEmbedModalSubmit,
    handleSendTextModalSubmit,
    handleSendEmbedModalSubmit,
} = require('./services/botMessageService');

// interactionCreate 用这个前缀把交互整体转发给本模块
const BOT_MESSAGE_CUSTOM_ID_PREFIX = 'botmsg_';

async function startBotMessageSystem() {
    initializeBotMessageDatabase();
    console.log('[BotMessage] ✅ 机器人消息管理模块已启动');
}

/**
 * 统一处理本模块的按钮 / 模态窗口交互
 * @returns {Promise<boolean>} 是否已被本模块处理
 */
async function handleBotMessageInteraction(interaction) {
    const customId = interaction.customId || '';
    if (!customId.startsWith(BOT_MESSAGE_CUSTOM_ID_PREFIX)) return false;

    if (interaction.isButton()) {
        if (
            customId === IDS.BTN_CANCEL
            || customId.startsWith(`${IDS.BTN_PICK_CONTENT}:`)
            || customId.startsWith(`${IDS.BTN_PICK_EMBED}:`)
        ) {
            await handlePickerButton(interaction);
            return true;
        }
        return false;
    }

    if (interaction.isModalSubmit()) {
        if (customId.startsWith(`${IDS.MODAL_EDIT_CONTENT}:`)) {
            await handleContentModalSubmit(interaction);
            return true;
        }
        if (customId.startsWith(`${IDS.MODAL_EDIT_EMBED}:`)) {
            await handleEmbedModalSubmit(interaction);
            return true;
        }
        if (customId.startsWith(`${IDS.MODAL_SEND_TEXT}:`)) {
            await handleSendTextModalSubmit(interaction);
            return true;
        }
        if (customId.startsWith(`${IDS.MODAL_SEND_EMBED}:`)) {
            await handleSendEmbedModalSubmit(interaction);
            return true;
        }
        return false;
    }

    return false;
}

module.exports = {
    startBotMessageSystem,
    handleBotMessageInteraction,
    BOT_MESSAGE_CUSTOM_ID_PREFIX,
};
