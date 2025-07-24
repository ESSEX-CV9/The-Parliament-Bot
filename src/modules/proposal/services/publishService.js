// src/modules/proposal/services/publishService.js
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getProposalDeadline } = require('../../../core/config/timeconfig');
const { saveMessage, getNextId } = require('../../../core/utils/database');

/**
 * 将议案发布到投票频道
 * @param {Client} client - Discord客户端
 * @param {Object} applicationData - 议案申请数据
 * @param {Object} settings - 议案设置
 * @returns {Object} 发布结果
 */
async function publishProposalToVoting(client, applicationData, settings) {
    try {
        // 获取目标频道
        const targetChannel = await client.channels.fetch(settings.targetChannelId);
        
        if (!targetChannel) {
            return {
                success: false,
                error: '找不到目标投票频道。请联系管理员修复设置。'
            };
        }
        
        // 计算截止日期（24小时后）
        const deadlineDate = getProposalDeadline();
        const deadlineTimestamp = Math.floor(deadlineDate.getTime() / 1000);
        
        // 获取下一个顺序ID（用于投票系统）
        const proposalId = getNextId();
        
        const formData = applicationData.formData;
        
        // 创建嵌入消息
        const embed = new EmbedBuilder()
            .setTitle(formData.title)
            .setDescription(`提案人：<@${applicationData.authorId}>\n议事截止日期：<t:${deadlineTimestamp}:f>\n\n**提案原因**\n${formData.reason}\n\n**议案动议**\n${formData.motion}\n\n**执行方案**\n${formData.implementation}\n\n**议案执行人**\n${formData.executor}`)
            .setColor('#0099ff')
            .setFooter({ 
                text: `再次点击支持按钮可以撤掉支持 | 提案ID ${proposalId}`, 
                iconURL: client.users.cache.get(applicationData.authorId)?.displayAvatarURL() || null
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
            formData: formData,
            requiredVotes: settings.requiredVotes,
            currentVotes: 0,
            voters: [],
            forumChannelId: settings.forumChannelId,
            authorId: applicationData.authorId,
            deadline: deadlineDate.toISOString(),
            status: 'pending',
            // 关联审核数据
            reviewThreadId: applicationData.threadId,
            originalProposalId: applicationData.proposalId
        });

        console.log(`成功发布议案到投票频道 - 消息ID: ${message.id}, 投票提案ID: ${proposalId}, 原议案ID: ${applicationData.proposalId}`);
        
        return {
            success: true,
            messageId: message.id,
            messageUrl: message.url,
            votingProposalId: proposalId
        };
        
    } catch (error) {
        console.error('发布议案到投票频道时出错:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * 检查议案是否可以发布
 * @param {Object} applicationData - 议案申请数据
 * @returns {Object} 检查结果
 */
function canPublishProposal(applicationData) {
    // 检查议案状态
    if (applicationData.status !== 'approved') {
        return {
            canPublish: false,
            reason: '只有已通过审核的议案可以发布'
        };
    }
    
    // 检查是否已经发布
    if (applicationData.publishData && applicationData.publishData.messageId) {
        return {
            canPublish: false,
            reason: '议案已经发布过了'
        };
    }
    
    // 检查表单数据是否完整
    const formData = applicationData.formData;
    if (!formData || !formData.title || !formData.reason || !formData.motion || !formData.implementation || !formData.executor) {
        return {
            canPublish: false,
            reason: '议案数据不完整'
        };
    }
    
    return {
        canPublish: true,
        reason: null
    };
}

/**
 * 获取议案发布状态信息
 * @param {Object} applicationData - 议案申请数据
 * @returns {Object} 状态信息
 */
function getPublishStatus(applicationData) {
    if (!applicationData.publishData) {
        return {
            isPublished: false,
            publishedAt: null,
            messageId: null,
            channelId: null
        };
    }
    
    return {
        isPublished: true,
        publishedAt: applicationData.publishData.publishedAt,
        messageId: applicationData.publishData.messageId,
        channelId: applicationData.publishData.channelId
    };
}

/**
 * 根据投票消息ID获取原始议案数据
 * @param {string} votingMessageId - 投票消息ID
 * @returns {Object|null} 原始议案数据
 */
async function getOriginalProposalByVotingMessage(votingMessageId) {
    try {
        const { getMessage } = require('../../../core/utils/database');
        const votingData = await getMessage(votingMessageId);
        
        if (!votingData || !votingData.originalProposalId) {
            return null;
        }
        
        const { getProposalApplication } = require('../utils/proposalDatabase');
        return await getProposalApplication(votingData.originalProposalId);
    } catch (error) {
        console.error('获取原始议案数据时出错:', error);
        return null;
    }
}

module.exports = {
    publishProposalToVoting,
    canPublishProposal,
    getPublishStatus,
    getOriginalProposalByVotingMessage
}; 