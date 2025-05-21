// src/services/formService.js
const { MessageFlags } = require('discord.js'); // 添加这行
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getSettings, saveMessage } = require('../utils/database'); // 确保正确导入

async function processFormSubmission(interaction) {
    // 获取表单数据
    const title = interaction.fields.getTextInputValue('title');
    const description = interaction.fields.getTextInputValue('description');
    const contact = interaction.fields.getTextInputValue('contact');
    
    // 从数据库获取设置 - 使用正确的键
    const settings = await getSettings(interaction.guild.id);
    console.log('处理表单提交，获取设置:', settings); // 添加调试日志
    
    if (!settings) {
        return interaction.reply({ 
            content: '找不到表单设置。请联系管理员设置表单。',
            flags: MessageFlags.Ephemeral // 修复弃用警告
        });
    }
    
    // 获取目标频道
    const targetChannel = await interaction.client.channels.fetch(settings.targetChannelId);
    
    if (!targetChannel) {
        return interaction.reply({ 
            content: '找不到目标频道。请联系管理员修复设置。',
            ephemeral: true 
        });
    }
    
    // 创建嵌入消息
    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .addFields({ name: '联系方式', value: contact })
        .setColor('#0099ff')
        .setTimestamp()
        .setFooter({ 
            text: `由 ${interaction.user.tag} 提交`, 
            iconURL: interaction.user.displayAvatarURL() 
        });
    
    // 创建支持按钮
    const messageId = Date.now().toString();
    const supportButton = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`support_PLACEHOLDER`) // 临时占位符
                .setLabel(`支持 (0/${settings.requiredVotes})`)
                .setStyle(ButtonStyle.Primary)
        );

    // 发送消息到目标频道
    const message = await targetChannel.send({
        embeds: [embed],
        components: [] // 先不添加按钮
    })

    // 使用真实消息ID更新按钮
    const updatedButton = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`support_${message.id}`) // 使用真实的消息ID
                .setLabel(`支持 (0/${settings.requiredVotes})`)
                .setStyle(ButtonStyle.Primary)
        );

    // 编辑消息添加正确的按钮
    await message.edit({
        embeds: [embed],
        components: [updatedButton]
    });
    
    // 使用Discord消息ID作为键存储到数据库
    await saveMessage({
        messageId: message.id, // 使用Discord消息ID
        channelId: targetChannel.id,
        formData: { title, description, contact },
        requiredVotes: settings.requiredVotes,
        currentVotes: 0,
        voters: [],
        forumChannelId: settings.forumChannelId,
        authorId: interaction.user.id
    });

    console.log(`成功创建表单消息 ID: ${message.id}, 使用的custom_id: support_${message.id}`);
    
    // 回复用户
    await interaction.reply({ 
        content: '您的表单已成功提交！', 
        ephemeral: true 
    });
}

module.exports = {
    processFormSubmission
};