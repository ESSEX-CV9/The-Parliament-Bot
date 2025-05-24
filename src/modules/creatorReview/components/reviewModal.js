// src/components/reviewModal.js
const { 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    ActionRowBuilder 
} = require('discord.js');

function createReviewModal() {
    const modal = new ModalBuilder()
        .setCustomId('review_submission')
        .setTitle('提交帖子审核');
    
    const postLinkInput = new TextInputBuilder()
        .setCustomId('post_link')
        .setLabel('帖子链接')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('支持两种格式：帖子整体链接或帖子首条消息链接');
        
    const row1 = new ActionRowBuilder().addComponents(postLinkInput);
    
    modal.addComponents(row1);
    
    return modal;
}

module.exports = { createReviewModal };