const { 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    ActionRowBuilder 
} = require('discord.js');

function createRejectionModal(submissionId, contestChannelId) {
    const modal = new ModalBuilder()
        .setCustomId(`rejection_reason_${submissionId}_${contestChannelId}`)
        .setTitle('删除投稿 - 拒稿说明');
    
    const reasonInput = new TextInputBuilder()
        .setCustomId('rejection_reason')
        .setLabel('拒稿说明（可选）')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(500)
        .setPlaceholder('请输入拒稿原因或说明（可选）\n例如：不符合比赛主题、质量不达标等...');
    
    const row = new ActionRowBuilder().addComponents(reasonInput);
    modal.addComponents(row);
    
    return modal;
}

module.exports = {
    createRejectionModal
}; 