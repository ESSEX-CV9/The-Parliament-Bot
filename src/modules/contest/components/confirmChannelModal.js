// src/modules/contest/components/confirmChannelModal.js
const { 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    ActionRowBuilder 
} = require('discord.js');

function createConfirmChannelModal(applicationData, allowedExternalServers = []) {
    const modal = new ModalBuilder()
        .setCustomId(`contest_confirm_channel_${applicationData.id}`)
        .setTitle('确认建立赛事频道');
    
    // 预构建频道内容
    const defaultContent = buildDefaultChannelContent(applicationData.formData);
    
    const channelNameInput = new TextInputBuilder()
        .setCustomId('channel_name')
        .setLabel('频道名称')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100)
        .setValue(applicationData.formData.title)
        .setPlaceholder('赛事频道的名称');
        
    const channelContentInput = new TextInputBuilder()
        .setCustomId('channel_content')
        .setLabel('首条消息内容')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(4000)
        .setValue(defaultContent)
        .setPlaceholder('赛事频道首条消息的内容，将显示赛事详情');
    
    const row1 = new ActionRowBuilder().addComponents(channelNameInput);
    const row2 = new ActionRowBuilder().addComponents(channelContentInput);
    
    // 如果有外部服务器，添加外部服务器选项
    if (allowedExternalServers.length > 0) {
        const externalServersInput = new TextInputBuilder()
            .setCustomId('external_servers')
            .setLabel('允许外部服务器投稿 (可选)')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(1000)
            .setValue(buildExternalServersText(allowedExternalServers))
            .setPlaceholder('输入"是"允许外部服务器投稿，或留空仅允许本服务器投稿');
        
        const row3 = new ActionRowBuilder().addComponents(externalServersInput);
        modal.addComponents(row1, row2, row3);
    } else {
        modal.addComponents(row1, row2);
    }
    
    return modal;
}

function buildDefaultChannelContent(formData) {
    return `🏆 **${formData.title}**

📝 **主题和参赛要求**
${formData.theme}

⏰ **比赛持续时间**
${formData.duration}

🎖️ **奖项设置和评价标准**
${formData.awards}

${formData.notes ? `📋 **注意事项**\n${formData.notes}\n\n` : ''}---

欢迎参加本次比赛！请在下方投稿入口提交您的作品。`;
}

function buildExternalServersText(allowedExternalServers) {
    if (allowedExternalServers.length === 0) return '';
    
    let text = '可用的外部服务器：\n';
    allowedExternalServers.forEach((serverId, index) => {
        text += `${index + 1}. 服务器ID: ${serverId}\n`;
    });
    text += '\n输入"是"允许这些外部服务器的用户投稿，或留空仅允许本服务器投稿。';
    return text;
}

module.exports = { 
    createConfirmChannelModal,
    buildDefaultChannelContent
};