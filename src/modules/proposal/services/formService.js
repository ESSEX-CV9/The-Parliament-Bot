// src/services/formService.js
const { MessageFlags } = require('discord.js');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getSettings, saveMessage, getNextId } = require('../../../core/utils/database');
const { getProposalDeadline } = require('../../../core/config/timeconfig');

async function processFormSubmission(interaction) {
    // 立即defer以防止超时
    await interaction.deferReply({ ephemeral: true });
    
    try {
        // 获取表单数据
        const title = interaction.fields.getTextInputValue('title');
        const reason = interaction.fields.getTextInputValue('reason');
        const motion = interaction.fields.getTextInputValue('motion');
        const implementation = interaction.fields.getTextInputValue('implementation');
        const voteTime = interaction.fields.getTextInputValue('voteTime');
        
        // 从数据库获取设置
        const settings = await getSettings(interaction.guild.id);
        console.log('处理表单提交，获取设置:', settings);
        
        if (!settings) {
            return interaction.editReply({ 
                content: '找不到表单设置。请联系管理员设置表单。'
            });
        }
        
        // 获取目标频道
        const targetChannel = await interaction.client.channels.fetch(settings.targetChannelId);
        
        if (!targetChannel) {
            return interaction.editReply({ 
                content: '找不到目标频道。请联系管理员修复设置。'
            });
        }
        
        // 计算截止日期（24小时后）
        const deadlineDate = getProposalDeadline();
        const deadlineTimestamp = Math.floor(deadlineDate.getTime() / 1000);
        
        // 获取下一个顺序ID
        const proposalId = getNextId();
        
        // 创建嵌入消息
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(`提案人：<@${interaction.user.id}>\n议事截止日期：<t:${deadlineTimestamp}:f>\n\n**提案原因**\n${reason}\n\n**议案动议**\n${motion}\n\n**执行方案**\n${implementation}\n\n**投票时间**\n${voteTime}`)
            .setColor('#0099ff')
            .setFooter({ 
                text: `再次点击支持按钮可以撤掉支持 | 提案ID ${proposalId}`, 
                iconURL: interaction.user.displayAvatarURL() 
            })
            .setTimestamp(); 
        
        // 发送消息到目标频道
        const message = await targetChannel.send({
            embeds: [embed],
            components: []
        });

        // 创建只有支持按钮的组件
        const buttonRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`support_${message.id}`)
                    .setLabel(`支持 (0/${settings.requiredVotes})`)
                    .setStyle(ButtonStyle.Primary)
            );

        // 编辑消息添加按钮
        await message.edit({
            embeds: [embed],
            components: [buttonRow]
        });
        
        // 使用Discord消息ID作为键存储到数据库
        await saveMessage({
            messageId: message.id,
            channelId: targetChannel.id,
            proposalId: proposalId,
            formData: { 
                title, 
                reason, 
                motion, 
                implementation, 
                voteTime 
            },
            requiredVotes: settings.requiredVotes,
            currentVotes: 0,
            voters: [],
            forumChannelId: settings.forumChannelId,
            authorId: interaction.user.id,
            deadline: deadlineDate.toISOString(),
            status: 'pending'
        });

        console.log(`成功创建表单消息 ID: ${message.id}, 提案ID: ${proposalId}, 截止日期: ${deadlineDate.toISOString()}`);
        
        // 回复用户
        await interaction.editReply({ 
            content: '您的议案已成功提交！'
        });
    } catch (error) {
        console.error('处理表单提交时出错:', error);
        await interaction.editReply({
            content: '处理表单提交时出现错误，请稍后重试。'
        });
    }
}

module.exports = {
    processFormSubmission
};