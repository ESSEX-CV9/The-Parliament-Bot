// src/services/withdrawService.js
const { MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getMessage, updateMessage } = require('../utils/database');

async function processWithdraw(interaction) {
    try {
        // 从模态窗口ID中提取消息ID
        const messageId = interaction.customId.replace('withdraw_submission_', '');
        const withdrawReason = interaction.fields.getTextInputValue('withdraw_reason');
        
        console.log(`处理撤回: 消息ID=${messageId}, 原因=${withdrawReason}`);
        
        // 从数据库获取消息数据
        const messageData = await getMessage(messageId);
        
        if (!messageData) {
            return interaction.reply({
                content: '在数据库中找不到此消息。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 如果消息已经发布到论坛或已经被撤回，不允许撤回
        if (messageData.status === 'posted') {
            return interaction.reply({
                content: '此议案已经发布到论坛，无法撤回。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        if (messageData.status === 'withdrawn') {
            return interaction.reply({
                content: '此议案已经被撤回。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 创建撤回后的嵌入消息
        const withdrawnEmbed = new EmbedBuilder()
            .setTitle(messageData.formData.title)
            .setDescription(`提案人：<@${messageData.authorId}>\n\n此提案被管理员<@${interaction.user.id}>撤回，理由：${withdrawReason}`)
            .setColor('#FF0000') // 红色表示撤回
            .setFooter({ 
                text: `提案ID ${messageData.proposalId} | 已撤回`,
                iconURL: interaction.guild.iconURL()
            })
            .setTimestamp();
        
        // 创建禁用的按钮
        const disabledButton = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`withdrawn_${messageId}`)
                    .setLabel('已撤回')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true)
            );
        
        // 更新原消息
        await interaction.message.edit({
            embeds: [withdrawnEmbed],
            components: [disabledButton]
        });
        
        // 更新数据库状态
        await updateMessage(messageId, {
            status: 'withdrawn',
            withdrawnBy: interaction.user.id,
            withdrawReason: withdrawReason,
            withdrawnAt: new Date().toISOString()
        });
        
        console.log(`成功撤回提案ID ${messageData.proposalId}`);
        
        // 回复管理员
        await interaction.reply({
            content: '提案已成功撤回。',
            flags: MessageFlags.Ephemeral
        });
        
    } catch (error) {
        console.error('处理撤回时出错:', error);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '处理撤回时出现错误。',
                    flags: MessageFlags.Ephemeral
                });
            }
        } catch (replyError) {
            console.error('回复错误:', replyError);
        }
    }
}

module.exports = {
    processWithdraw
};