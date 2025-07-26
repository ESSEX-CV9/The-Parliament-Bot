// src/modules/proposal/components/proposalEditModal.js
const { 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    ActionRowBuilder 
} = require('discord.js');

function createProposalEditModal(proposalData) {
    const modal = new ModalBuilder()
        .setCustomId(`proposal_edit_submission_${proposalData.proposalId}`)
        .setTitle('编辑议案内容');
    
    const titleInput = new TextInputBuilder()
        .setCustomId('title')
        .setLabel('议案标题')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('请保持标题简洁明了，尽量不超过30字')
        .setValue(proposalData.formData.title || '');
        
    const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('提案原因')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setPlaceholder('说明提出此动议的原因')
        .setValue(proposalData.formData.reason || '');
        
    const motionInput = new TextInputBuilder()
        .setCustomId('motion')
        .setLabel('议案动议')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setPlaceholder('详细说明您的议案内容')
        .setValue(proposalData.formData.motion || '');
        
    const implementationInput = new TextInputBuilder()
        .setCustomId('implementation')
        .setLabel('执行方案')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setPlaceholder('说明如何落实此动议')
        .setValue(proposalData.formData.implementation || '');
        
    const executorInput = new TextInputBuilder()
        .setCustomId('executor')
        .setLabel('议案执行人')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('指定负责执行此议案的人员或部门')
        .setValue(proposalData.formData.executor || '');
    
    // 构建表单行
    const row1 = new ActionRowBuilder().addComponents(titleInput);
    const row2 = new ActionRowBuilder().addComponents(reasonInput);
    const row3 = new ActionRowBuilder().addComponents(motionInput);
    const row4 = new ActionRowBuilder().addComponents(implementationInput);
    const row5 = new ActionRowBuilder().addComponents(executorInput);
    
    modal.addComponents(row1, row2, row3, row4, row5);
    
    return modal;
}

module.exports = { createProposalEditModal }; 