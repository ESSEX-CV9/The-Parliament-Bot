const { 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    ActionRowBuilder 
} = require('discord.js');

function createAwardModal(contestChannelId, submissionId) {
    const modal = new ModalBuilder()
        .setCustomId(`award_modal_${contestChannelId}_${submissionId}`)
        .setTitle('设置获奖作品');
    
    const awardNameInput = new TextInputBuilder()
        .setCustomId('award_name')
        .setLabel('获得的奖项')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100)
        .setPlaceholder('例如：一等奖、最佳创意奖、特别奖等');
        
    const awardMessageInput = new TextInputBuilder()
        .setCustomId('award_message')
        .setLabel('额外提示内容')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(500)
        .setPlaceholder('获奖感言、评语或其他补充信息（可选）');
    
    const row1 = new ActionRowBuilder().addComponents(awardNameInput);
    const row2 = new ActionRowBuilder().addComponents(awardMessageInput);
    
    modal.addComponents(row1, row2);
    
    return modal;
}

module.exports = {
    createAwardModal
}; 