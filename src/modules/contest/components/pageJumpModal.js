const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

function createPageJumpModal(contestChannelId, currentPage, totalPages) {
    const modal = new ModalBuilder()
        .setCustomId(`contest_page_jump_${contestChannelId}`)
        .setTitle('跳转到指定页面');

    const pageInput = new TextInputBuilder()
        .setCustomId('target_page')
        .setLabel('请输入要跳转的页码')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(`请输入 1 到 ${totalPages} 之间的页码`)
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(String(totalPages).length)
        .setValue(String(currentPage));

    const pageRow = new ActionRowBuilder().addComponents(pageInput);
    modal.addComponents(pageRow);

    return modal;
}

module.exports = {
    createPageJumpModal
}; 