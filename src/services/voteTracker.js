// src/services/voteTracker.js
const { MessageFlags, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const { getMessage, updateMessage } = require('../utils/database');
const { createForumPost } = require('./forumPoster');

async function processVote(interaction) {
    // 从按钮ID中提取消息ID
    const messageId = interaction.customId.replace('support_', '');
    console.log(`处理投票: 按钮ID=${interaction.customId}, 提取的消息ID=${messageId}`);
    
    // 从数据库获取消息数据
    const messageData = await getMessage(messageId);
    console.log(`查询消息数据: ID=${messageId}, 结果=`, messageData);
    
    if (!messageData) {
        console.error(`在数据库中找不到消息ID: ${messageId}`);
        console.log(`当前数据库中的所有消息ID:`, Object.keys(require('fs').readFileSync(require('path').join(__dirname, '../../data/messages.json'), 'utf8') || '{}'));
        
        return interaction.reply({ 
            content: '在数据库中找不到此消息。这可能是因为机器人重启或数据丢失。',
            flags: MessageFlags.Ephemeral
        });
    }
    
    // 检查用户是否已经投票
    if (messageData.voters.includes(interaction.user.id)) {
        return interaction.reply({ 
            content: '您已经支持过这个提交。',
            flags: MessageFlags.Ephemeral 
        });
    }
    
    // 更新投票
    messageData.currentVotes += 1;
    messageData.voters.push(interaction.user.id);
    
    // 更新按钮标签
    const updatedButton = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`support_${messageId}`)
                .setLabel(`支持 (${messageData.currentVotes}/${messageData.requiredVotes})`)
                .setStyle(ButtonStyle.Primary)
        );
    
    await interaction.message.edit({
        components: [updatedButton]
    });
    
    // 更新数据库
    await updateMessage(messageId, {
        currentVotes: messageData.currentVotes,
        voters: messageData.voters
    });
    
    // 检查是否达到所需票数
    if (messageData.currentVotes >= messageData.requiredVotes) {
        // 创建论坛帖子
        await createForumPost(interaction.client, messageData);
        
        // 更新消息，表示已发布到论坛
        const disabledButton = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`complete_${messageId}`)
                    .setLabel(`已发布到论坛 ✅`)
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(true)
            );
        
        await interaction.message.edit({
            components: [disabledButton]
        });
    }
    
    await interaction.reply({ 
        content: '您的支持已记录！', 
        flags: MessageFlags.Ephemeral 
    });
}

module.exports = {
    processVote
};