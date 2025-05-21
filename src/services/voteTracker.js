// src/services/voteTracker.js
const { MessageFlags, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const { getMessage, updateMessage } = require('../utils/database');
const { createForumPost } = require('./forumPoster');

async function processVote(interaction) {
    try {
        // 立即回复延迟消息，防止交互超时
        await interaction.deferReply({ ephemeral: true });
        
        // 从按钮ID中提取消息ID
        const messageId = interaction.customId.replace('support_', '');
        console.log(`处理投票: 按钮ID=${interaction.customId}, 提取的消息ID=${messageId}`);
        
        // 从数据库获取消息数据
        const messageData = await getMessage(messageId);
        console.log(`查询消息数据: ID=${messageId}, 结果=`, messageData);
        
        if (!messageData) {
            console.error(`在数据库中找不到消息ID: ${messageId}`);
            return interaction.editReply({ 
                content: '在数据库中找不到此消息。这可能是因为机器人重启或数据丢失。'
            });
        }
        
        // 如果消息已经发布到论坛或被撤回，不允许再更改投票
        if (messageData.status === 'posted') {
            return interaction.editReply({ 
                content: '此议案已经发布到论坛，不能再更改支持状态。'
            });
        }
        
        if (messageData.status === 'withdrawn') {
            return interaction.editReply({ 
                content: '此议案已被撤回，不能再更改支持状态。'
            });
        }
        
        // 检查用户是否已经投票
        const userIndex = messageData.voters.indexOf(interaction.user.id);
        let replyContent = '';
        
        if (userIndex !== -1) {
            // 用户已投票，撤销投票
            messageData.currentVotes -= 1;
            messageData.voters.splice(userIndex, 1);
            replyContent = '您已撤销对此议案的支持！';
        } else {
            // 用户未投票，添加投票
            messageData.currentVotes += 1;
            messageData.voters.push(interaction.user.id);
            replyContent = '您的支持已记录！';
        }
        
        // 更新按钮 - 包括支持按钮和撤回按钮
        const updatedButtons = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`support_${messageId}`)
                    .setLabel(`支持 (${messageData.currentVotes}/${messageData.requiredVotes})`)
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId(`withdraw_${messageId}`)
                    .setLabel('撤回提案')
                    .setStyle(ButtonStyle.Danger)
            );
        
        await interaction.message.edit({
            components: [updatedButtons]
        });
        
        // 更新数据库
        await updateMessage(messageId, {
            currentVotes: messageData.currentVotes,
            voters: messageData.voters
        });
        
        // 检查是否达到所需票数
        if (messageData.currentVotes >= messageData.requiredVotes) {
            try {
                // 通知用户正在处理
                await interaction.editReply({
                    content: '您的支持已记录！议案正在发布到论坛...'
                });
                
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
                
                // 更新数据库中的状态
                await updateMessage(messageId, {
                    status: 'posted'
                });
                
                // 更新回复
                replyContent = '您的支持已记录！议案已成功发布到论坛。';
            } catch (error) {
                console.error('发布到论坛时出错:', error);
                replyContent = '您的支持已记录，但发布到论坛时出现错误。请联系管理员。';
            }
        }
        
        // 最终更新回复
        await interaction.editReply({ 
            content: replyContent
        });
    } catch (error) {
        console.error('处理投票时出错:', error);
        
        // 尝试优雅地处理错误
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ 
                    content: '处理您的请求时出现错误。', 
                    ephemeral: true 
                });
            } else {
                await interaction.editReply({
                    content: '处理您的请求时出现错误。'
                });
            }
        } catch (replyError) {
            console.error('回复错误:', replyError);
        }
    }
}

module.exports = {
    processVote
};