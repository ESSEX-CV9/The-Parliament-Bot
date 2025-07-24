// src\modules\proposal\components\formModal.js
const { 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    ActionRowBuilder 
} = require('discord.js');

function createFormModal() {
    const modal = new ModalBuilder()
        .setCustomId('form_submission')
        .setTitle('提交议案');
    
    const titleInput = new TextInputBuilder()
        .setCustomId('title')
        .setLabel('议案标题')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('请保持标题简洁明了，尽量不超过30字');
        
    const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('提案原因')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setPlaceholder('说明提出此动议的原因');
        
    const motionInput = new TextInputBuilder()
        .setCustomId('motion')
        .setLabel('议案动议')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setPlaceholder('详细说明您的议案内容');
        
    const implementationInput = new TextInputBuilder()
        .setCustomId('implementation')
        .setLabel('执行方案')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setPlaceholder('说明如何落实此动议');
        
    const voteTimeInput = new TextInputBuilder()
        .setCustomId('voteTime')
        .setLabel('议案执行人')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('指定负责执行此议案的人员或部门');
    
    // 构建表单行
    const row1 = new ActionRowBuilder().addComponents(titleInput);
    const row2 = new ActionRowBuilder().addComponents(reasonInput);
    const row3 = new ActionRowBuilder().addComponents(motionInput);
    const row4 = new ActionRowBuilder().addComponents(implementationInput);
    const row5 = new ActionRowBuilder().addComponents(voteTimeInput);
    
    modal.addComponents(row1, row2, row3, row4, row5);
    
    return modal;
}

module.exports = { createFormModal };