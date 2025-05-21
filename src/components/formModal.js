// src/components/formModal.js
const { 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    ActionRowBuilder 
} = require('discord.js');

function createFormModal() {
    const modal = new ModalBuilder()
        .setCustomId('form_submission')
        .setTitle('提交表单信息');
    
    const titleInput = new TextInputBuilder()
        .setCustomId('title')
        .setLabel('标题')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
        
    const descriptionInput = new TextInputBuilder()
        .setCustomId('description')
        .setLabel('描述')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);
        
    const contactInput = new TextInputBuilder()
        .setCustomId('contact')
        .setLabel('联系方式')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
    
    const row1 = new ActionRowBuilder().addComponents(titleInput);
    const row2 = new ActionRowBuilder().addComponents(descriptionInput);
    const row3 = new ActionRowBuilder().addComponents(contactInput);
    
    modal.addComponents(row1, row2, row3);
    
    return modal;
}

module.exports = { createFormModal };