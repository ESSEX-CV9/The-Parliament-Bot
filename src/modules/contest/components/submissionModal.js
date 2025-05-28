// src/modules/contest/components/submissionModal.js
const { 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    ActionRowBuilder 
} = require('discord.js');

function createSubmissionModal(contestChannelId) {
    const modal = new ModalBuilder()
        .setCustomId(`contest_submission_${contestChannelId}`)
        .setTitle('投稿作品');
    
    const linkInput = new TextInputBuilder()
        .setCustomId('submission_link')
        .setLabel('作品帖子链接')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('请粘贴您的作品帖子链接（支持消息链接和频道链接）');
    
    const descriptionInput = new TextInputBuilder()
        .setCustomId('submission_description')
        .setLabel('稿件说明（可选）')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(150)
        .setPlaceholder('请简要描述您的作品内容、创作思路等（最多150字，可选填）');
    
    const row1 = new ActionRowBuilder().addComponents(linkInput);
    const row2 = new ActionRowBuilder().addComponents(descriptionInput);
    
    modal.addComponents(row1, row2);
    
    return modal;
}

module.exports = { 
    createSubmissionModal
};