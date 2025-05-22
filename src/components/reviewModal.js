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
        .setPlaceholder('请输入Discord帖子的完整链接，例如：https://discord.com/channels/...');
        
    const descriptionInput = new TextInputBuilder()
        .setCustomId('description')
        .setLabel('补充说明（可选）')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setPlaceholder('可以添加一些关于您帖子的说明...');
    
    // 构建表单行
    const row1 = new ActionRowBuilder().addComponents(postLinkInput);
    const row2 = new ActionRowBuilder().addComponents(descriptionInput);
    
    modal.addComponents(row1, row2);
    
    return modal;
}

module.exports = { createReviewModal };