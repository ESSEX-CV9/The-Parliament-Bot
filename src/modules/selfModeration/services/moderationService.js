// src\modules\selfModeration\services\moderationService.js
const { EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { getSelfModerationSettings } = require('../../../core/utils/database');
const { checkSelfModerationPermission, checkSelfModerationChannelPermission, getSelfModerationPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const { parseMessageUrl, isMessageFromSameGuild, formatMessageLink } = require('../utils/messageParser');
const { validateChannel, checkBotPermissions } = require('../utils/channelValidator');
const { createOrMergeVote, checkConflictingVote, formatVoteInfo } = require('./votingManager');
const { getShitReactionCount } = require('./reactionTracker');

/**
 * 处理自助管理交互（按钮点击和模态窗口提交）
 * @param {Interaction} interaction - Discord交互对象
 */
async function processSelfModerationInteraction(interaction) {
    try {
        if (interaction.isButton()) {
            await handleSelfModerationButton(interaction);
        } else if (interaction.isModalSubmit()) {
            await handleSelfModerationModal(interaction);
        }
    } catch (error) {
        console.error('处理自助管理交互时出错:', error);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '处理请求时出现错误，请稍后重试。',
                    ephemeral: true
                });
            }
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

/**
 * 处理自助管理按钮点击
 * @param {ButtonInteraction} interaction - 按钮交互
 */
async function handleSelfModerationButton(interaction) {
    const customId = interaction.customId;
    
    if (customId === 'selfmod_delete_message') {
        await showMessageInputModal(interaction, 'delete');
    } else if (customId === 'selfmod_mute_user') {
        await showMessageInputModal(interaction, 'mute');
    }
}

/**
 * 处理自助管理模态窗口提交
 * @param {ModalSubmitInteraction} interaction - 模态窗口交互
 */
async function handleSelfModerationModal(interaction) {
    await interaction.deferReply({ ephemeral: true });
    
    const customId = interaction.customId;
    
    if (customId.startsWith('selfmod_modal_')) {
        const type = customId.replace('selfmod_modal_', '');
        const messageUrl = interaction.fields.getTextInputValue('message_url');
        
        await processMessageUrlSubmission(interaction, type, messageUrl);
    }
}

/**
 * 显示消息链接输入模态窗口
 * @param {ButtonInteraction} interaction - 按钮交互
 * @param {string} type - 操作类型 ('delete' 或 'mute')
 */
async function showMessageInputModal(interaction, type) {
    const actionName = type === 'delete' ? '删除搬屎消息' : '禁言搬屎用户';
    
    const modal = new ModalBuilder()
        .setCustomId(`selfmod_modal_${type}`)
        .setTitle(actionName);
    
    const messageUrlInput = new TextInputBuilder()
        .setCustomId('message_url')
        .setLabel('消息链接')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('请粘贴要处理的消息链接（右键消息 -> 复制消息链接）');
    
    const row = new ActionRowBuilder().addComponents(messageUrlInput);
    modal.addComponents(row);
    
    await interaction.showModal(modal);
}

/**
 * 处理消息链接提交
 * @param {ModalSubmitInteraction} interaction - 模态窗口交互
 * @param {string} type - 操作类型
 * @param {string} messageUrl - 消息链接
 */
async function processMessageUrlSubmission(interaction, type, messageUrl) {
    try {
        // 获取设置
        const settings = await getSelfModerationSettings(interaction.guild.id);
        if (!settings) {
            return interaction.editReply({
                content: '❌ 该服务器未配置自助管理功能，请联系管理员设置。'
            });
        }
        
        // 检查用户权限
        const hasPermission = checkSelfModerationPermission(interaction.member, type, settings);
        if (!hasPermission) {
            return interaction.editReply({
                content: getSelfModerationPermissionDeniedMessage(type)
            });
        }
        
        // 检查频道权限
        const channelAllowed = checkSelfModerationChannelPermission(interaction.channel.id, settings);
        if (!channelAllowed) {
            return interaction.editReply({
                content: '❌ 此频道不允许使用自助管理功能。'
            });
        }
        
        // 解析消息链接
        const parsed = parseMessageUrl(messageUrl);
        if (!parsed) {
            return interaction.editReply({
                content: '❌ 消息链接格式无效，请确保链接是完整的Discord消息链接。'
            });
        }
        
        // 检查是否是同一服务器的消息
        if (parsed.guildId !== interaction.guild.id) {
            return interaction.editReply({
                content: '❌ 只能处理本服务器内的消息。'
            });
        }
        
        // 获取并验证目标消息
        const messageInfo = await validateTargetMessage(interaction.client, parsed);
        if (!messageInfo.success) {
            return interaction.editReply({
                content: `❌ ${messageInfo.error}`
            });
        }
        
        // 检查机器人权限
        const botPermissions = checkBotPermissions(messageInfo.channel, interaction.guild.members.me, type);
        if (!botPermissions.hasPermission) {
            return interaction.editReply({
                content: `❌ 机器人权限不足，缺少以下权限：${botPermissions.missingPermissions.join(', ')}`
            });
        }
        
        // 创建或合并投票
        const voteData = {
            guildId: interaction.guild.id,
            channelId: interaction.channel.id,
            targetChannelId: parsed.channelId,
            targetMessageId: parsed.messageId,
            targetUserId: messageInfo.message.author.id,
            targetMessageUrl: messageUrl,
            type: type,
            initiatorId: interaction.user.id
        };
        
        const voteResult = await createOrMergeVote(voteData);
        
        // 发送投票结果
        await sendVoteStartNotification(interaction, voteResult, messageInfo);
        
        // 回复用户
        await interaction.editReply({
            content: `✅ ${voteResult.message}`
        });
        
    } catch (error) {
        console.error('处理消息链接提交时出错:', error);
        await interaction.editReply({
            content: '❌ 处理请求时出现错误，请稍后重试。'
        });
    }
}

/**
 * 验证目标消息
 * @param {Client} client - Discord客户端
 * @param {object} parsed - 解析后的消息信息
 * @returns {object} 验证结果
 */
async function validateTargetMessage(client, parsed) {
    try {
        const { guildId, channelId, messageId } = parsed;
        
        // 获取频道
        const channel = await client.channels.fetch(channelId);
        if (!channel) {
            return { success: false, error: '找不到目标频道，可能已被删除或机器人无权访问。' };
        }
        
        // 获取消息
        const message = await channel.messages.fetch(messageId);
        if (!message) {
            return { success: false, error: '找不到目标消息，可能已被删除。' };
        }
        
        // 检查消息是否是机器人发送的
        if (message.author.bot) {
            return { success: false, error: '不能对机器人发送的消息执行自助管理操作。' };
        }
        
        return {
            success: true,
            channel,
            message
        };
        
    } catch (error) {
        console.error('验证目标消息时出错:', error);
        return { success: false, error: '验证消息时出现错误。' };
    }
}

/**
 * 发送投票开始通知
 * @param {ModalSubmitInteraction} interaction - 交互对象
 * @param {object} voteResult - 投票结果
 * @param {object} messageInfo - 消息信息
 */
async function sendVoteStartNotification(interaction, voteResult, messageInfo) {
    try {
        const { voteData, isNewVote } = voteResult;
        const { type, targetMessageUrl, endTime, currentReactionCount } = voteData;
        
        if (!isNewVote) return; // 如果不是新投票，不发送通知
        
        const actionName = type === 'delete' ? '删除搬屎消息' : '禁言搬屎用户';
        const endTimestamp = Math.floor(new Date(endTime).getTime() / 1000);
        
        // 获取当前⚠️反应数量
        const initialReactionCount = await getShitReactionCount(
            interaction.client,
            voteData.guildId,
            voteData.targetChannelId,
            voteData.targetMessageId
        );
        
        const embed = new EmbedBuilder()
            .setTitle(`🗳️ ${actionName}投票已启动`)
            .setDescription(`有用户发起了${actionName}投票，请大家前往目标消息添加⚠️反应来表达支持。\n\n**目标消息：** ${formatMessageLink(targetMessageUrl)}\n**消息作者：** <@${messageInfo.message.author.id}>\n**发起人：** <@${voteData.initiatorId}>\n**投票结束时间：** <t:${endTimestamp}:f>\n**当前⚠️数量：** ${initialReactionCount}\n**执行条件：** ${type === 'delete' ? '20个⚠️删除消息' : '20个⚠️开始禁言'}`)
            .setColor('#FFA500')
            .setTimestamp()
            .setFooter({
                text: '⚠️反应数量会实时检查，达到条件后会自动执行相应操作'
            });
        
        // 检查是否有冲突的投票
        const conflictingVote = await checkConflictingVote(voteData.guildId, voteData.targetMessageId, type);
        if (conflictingVote) {
            const conflictActionName = conflictingVote.type === 'delete' ? '删除消息' : '禁言用户';
            embed.addFields({
                name: '⚠️ 注意',
                value: `该消息同时存在${conflictActionName}投票，如果删除消息投票先达到条件，将等待禁言投票结束后再删除消息。`,
                inline: false
            });
        }
        
        await interaction.channel.send({ embeds: [embed] });
        
    } catch (error) {
        console.error('发送投票通知时出错:', error);
    }
}

module.exports = {
    processSelfModerationInteraction,
    validateTargetMessage,
    processMessageUrlSubmission
};