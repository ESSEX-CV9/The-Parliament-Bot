// src/components/withdrawModal.js
const { 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    ActionRowBuilder 
} = require('discord.js');

function createWithdrawModal(messageId) {
    const modal = new ModalBuilder()
        .setCustomId(`withdraw_submission_${messageId}`)
        .setTitle('撤回提案');
    
    const reasonInput = new TextInputBuilder()
        .setCustomId('withdraw_reason')
        .setLabel('撤回原因')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setPlaceholder('请输入撤回此提案的原因...')
        .setMaxLength(500);
    
    const row = new ActionRowBuilder().addComponents(reasonInput);
    modal.addComponents(row);
    
    return modal;
}

module.exports = { createWithdrawModal };