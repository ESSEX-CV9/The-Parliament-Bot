const { 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    ActionRowBuilder 
} = require('discord.js');

function createRejectionModal(submissionId, contestChannelId) {
    const modal = new ModalBuilder()
        .setCustomId(`rejection_reason_${submissionId}_${contestChannelId}`)
        .setTitle('拒稿退回 - 说明理由');
    
    const reasonInput = new TextInputBuilder()
        .setCustomId('rejection_reason')
        .setLabel('拒稿理由（可选）')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(500)
        .setPlaceholder('请输入拒稿理由或说明（可选）\n例如：不符合比赛主题等...');
    
    const row = new ActionRowBuilder().addComponents(reasonInput);
    modal.addComponents(row);
    
    return modal;
}

module.exports = {
    createRejectionModal
}; 