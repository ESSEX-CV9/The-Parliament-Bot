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
    
    const row1 = new ActionRowBuilder().addComponents(linkInput);
    modal.addComponents(row1);
    
    return modal;
}

module.exports = { 
    createSubmissionModal
};