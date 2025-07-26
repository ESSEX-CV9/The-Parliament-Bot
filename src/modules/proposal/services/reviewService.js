// src/modules/proposal/services/reviewService.js
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { 
    getProposalApplication,
    updateProposalApplication,
    getProposalSettings
} = require('../utils/proposalDatabase');
const { 
    ensureProposalStatusTags, 
    updateProposalThreadStatusTag, 
    getTagStatusFromProposalStatus 
} = require('../utils/forumTagManager');
const { getSettings, saveMessage, getNextId } = require('../../../core/utils/database');
const { getProposalDeadline } = require('../../../core/config/timeconfig');

async function processProposalReview(interaction, proposalId, reviewResult, reason = '') {
    try {
        await interaction.deferReply({ ephemeral: true });
        
        console.log(`处理议案审核 - ID: ${proposalId}, 结果: ${reviewResult}, 审核员: ${interaction.user.tag}`);
        
        const applicationData = await getProposalApplication(proposalId);
        if (!applicationData) {
            return interaction.editReply({
                content: `❌ 找不到议案ID为 \`${proposalId}\` 的申请。`
            });
        }
        
        // 检查申请状态
        if (applicationData.status === 'approved' && reviewResult === 'approved') {
            return interaction.editReply({
                content: `❌ 议案ID \`${proposalId}\` 已经审核通过了。`
            });
        }
        
        if (applicationData.status === 'rejected' && reviewResult === 'rejected') {
            return interaction.editReply({
                content: `❌ 议案ID \`${proposalId}\` 已经被拒绝了。`
            });
        }
        
        // 更新申请状态
        const reviewData = {
            reviewerId: interaction.user.id,
            result: reviewResult,
            reason: reason,
            reviewedAt: new Date().toISOString()
        };
        
        await updateProposalApplication(proposalId, {
            status: reviewResult,
            reviewData: reviewData,
            updatedAt: new Date().toISOString()
        });
        
        // 准备结果消息
        const resultMessages = {
            'approved': `✅ 议案ID \`${proposalId}\` 已审核通过！议案现在可以发布到投票频道了。`,
            'rejected': `❌ 议案ID \`${proposalId}\` 已被拒绝。${reason ? `\n**拒绝原因：** ${reason}` : ''}`,
            'modification_required': `⚠️ 议案ID \`${proposalId}\` 需要修改。${reason ? `\n**修改要求：** ${reason}` : ''}\n申请人可以继续编辑议案内容。`
        };
        
        // 更新审核帖子
        await interaction.editReply({
            content: '⏳ 正在更新审核帖子...'
        });
        
        try {
            await updateReviewThreadStatus(interaction.client, applicationData, reviewData);
            
            // 如果审核通过，自动发布到投票频道
            if (reviewResult === 'approved') {
                await publishToVoteChannel(interaction.client, applicationData);
            }
            
            // 更新成功，显示最终结果
            await interaction.editReply({
                content: resultMessages[reviewResult] || '✅ 审核完成。'
            });
            
        } catch (threadUpdateError) {
            console.error('更新审核帖子时出错:', threadUpdateError);
            
            // 即使帖子更新失败，也要告知用户审核已完成
            await interaction.editReply({
                content: `${resultMessages[reviewResult] || '✅ 审核完成。'}\n\n⚠️ 注意：审核帖子更新可能失败，但审核结果已保存。`
            });
        }
        
        console.log(`议案审核完成 - ID: ${proposalId}, 结果: ${reviewResult}`);
        
    } catch (error) {
        console.error('处理议案审核时出错:', error);
        
        try {
            await interaction.editReply({
                content: `❌ 处理审核时出现错误：${error.message}`
            });
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

async function updateReviewThreadStatus(client, applicationData, reviewData) {
    try {
        const thread = await client.channels.fetch(applicationData.threadId);
        const firstMessage = await thread.fetchStarterMessage();
        
        if (!firstMessage) {
            throw new Error('找不到要更新的初始消息');
        }
        
        // 确保论坛标签
        const tagMap = await ensureProposalStatusTags(thread.parent);
        
        const statusEmojis = {
            'approved': '✅',
            'rejected': '❌',
            'modification_required': '⚠️'
        };
        
        const statusTexts = {
            'approved': '审核通过',
            'rejected': '审核拒绝',
            'modification_required': '需要修改'
        };
        
        // 构建更新的内容
        const formData = applicationData.formData;
        const updatedContent = `👤 **提案人：** <@${applicationData.authorId}>
📅 **提交时间：** <t:${Math.floor(new Date(applicationData.createdAt).getTime() / 1000)}:f>
🆔 **议案ID：** \`${applicationData.proposalId}\`
👨‍💼 **审核员：** <@${reviewData.reviewerId}>
📅 **审核时间：** <t:${Math.floor(new Date(reviewData.reviewedAt).getTime() / 1000)}:f>

---

🏷️ **议案标题**
${formData.title}

📝 **提案原因**
${formData.reason}

📋 **议案动议**
${formData.motion}

🔧 **执行方案**
${formData.implementation}

👨‍💼 **议案执行人**
${formData.executor}

---

${statusEmojis[reviewData.result]} **状态：** ${statusTexts[reviewData.result]}

${reviewData.reason ? `💬 **审核意见：** ${reviewData.reason}\n\n` : ''}`;
        
        // 根据审核结果显示不同按钮
        let components = [];
        
        if (reviewData.result === 'approved') {
            // 审核通过：显示已发布状态（因为会自动发布）
            components = [
                new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`proposal_published_${applicationData.proposalId}`)
                            .setLabel('✅ 已发布到投票频道')
                            .setStyle(ButtonStyle.Success)
                            .setDisabled(true)
                    )
            ];
        } else if (reviewData.result === 'modification_required') {
            // 需要修改：保留编辑按钮
            components = [
                new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`proposal_edit_${applicationData.proposalId}`)
                            .setLabel('✏️ 编辑议案')
                            .setStyle(ButtonStyle.Secondary)
                    )
            ];
        }
        // rejected状态不显示任何按钮
        
        await firstMessage.edit({
            content: updatedContent,
            components: components
        });
        
        // 更新标签状态
        const tagStatus = getTagStatusFromProposalStatus(reviewData.result);
        await updateProposalThreadStatusTag(thread, tagStatus, tagMap);
        
        // 更新标题
        if (reviewData.result === 'approved') {
            await thread.setName(`【已通过】${formData.title}`);
        } else if (reviewData.result === 'rejected') {
            await thread.setName(`【未通过】${formData.title}`);
        }
        // modification_required 保持【待审核】标题，依靠标签显示状态
        
        // 发送审核记录消息
        await postReviewHistoryMessage(thread, reviewData, applicationData.authorId);
        
        console.log(`审核帖子状态已更新 - 帖子: ${thread.id}, 状态: ${reviewData.result}`);
        
    } catch (error) {
        console.error('更新审核帖子状态时出错:', error);
        
        // 检查是否是频道不存在的错误
        if (error.code === 10003) {
            console.warn(`⚠️ 审核帖子不存在或已被删除 - 帖子ID: ${applicationData.threadId}, 议案ID: ${applicationData.proposalId}`);
            console.warn('审核结果已保存到数据库，但无法更新帖子状态');
            return; // 不抛出错误，让审核流程继续
        }
        
        // 其他错误仍然抛出
        throw error;
    }
}

async function postReviewHistoryMessage(thread, reviewData, authorId) {
    try {
        // 根据审核结果设置不同的emoji和文本
        const resultConfig = {
            'approved': {
                emoji: '✅',
                text: '审核通过',
                color: '🟢',
                followUp: '✅ 议案已自动发布到投票频道，开始收集支持票数。'
            },
            'rejected': {
                emoji: '❌',
                text: '审核拒绝',
                color: '🔴',
                followUp: '📝 如有疑问，申请人可以联系审核员了解详细情况。'
            },
            'modification_required': {
                emoji: '⚠️',
                text: '需要修改',
                color: '🟡',
                followUp: '💡 申请人可以点击上方的 **"✏️ 编辑议案"** 按钮进行修改。修改后将进入再次审核流程。'
            }
        };
        
        const config = resultConfig[reviewData.result] || resultConfig['modification_required'];
        
        const historyMessage = `<@${authorId}> 您的议案已被审核！
## 📋 审核记录       
👨‍💼 **审核员：** <@${reviewData.reviewerId}>
📅 **审核时间：** <t:${Math.floor(new Date(reviewData.reviewedAt).getTime() / 1000)}:f>
${config.emoji} **审核结果：** ${config.text}

💬 **审核意见：**
${reviewData.reason || '无具体意见'}
---
${config.followUp}`;

        await thread.send({
            content: historyMessage
        });
        
        console.log(`审核记录消息已发送 - 帖子: ${thread.id}, 结果: ${reviewData.result}`);
        
    } catch (error) {
        console.error('发送审核记录消息时出错:', error);
        // 不抛出错误，避免影响主流程
    }
}

async function publishToVoteChannel(client, applicationData) {
    try {
        // 获取设置
        const proposalSettings = await getProposalSettings(applicationData.guildId);
        const legacySettings = await getSettings(applicationData.guildId);
        
        const targetChannelId = proposalSettings?.targetChannelId || legacySettings?.targetChannelId;
        const requiredVotes = proposalSettings?.requiredVotes || legacySettings?.requiredVotes;
        
        if (!targetChannelId) {
            throw new Error('找不到投票频道设置');
        }
        
        // 获取目标频道
        const targetChannel = await client.channels.fetch(targetChannelId);
        if (!targetChannel) {
            throw new Error('找不到投票频道');
        }
        
        // 计算截止日期（24小时后）
        const deadlineDate = getProposalDeadline();
        const deadlineTimestamp = Math.floor(deadlineDate.getTime() / 1000);
        
        const formData = applicationData.formData;
        
        // 创建嵌入消息
        const embed = new EmbedBuilder()
            .setTitle(formData.title)
            .setDescription(`提案人：<@${applicationData.authorId}>\n议事截止日期：<t:${deadlineTimestamp}:f>\n\n**提案原因**\n${formData.reason}\n\n**议案动议**\n${formData.motion}\n\n**执行方案**\n${formData.implementation}\n\n**议案执行人**\n${formData.executor}`)
            .setColor('#0099ff')
            .setFooter({ 
                text: `再次点击支持按钮可以撤掉支持 | 提案ID ${applicationData.proposalId}`, 
                iconURL: client.users.cache.get(applicationData.authorId)?.displayAvatarURL() 
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
                    .setLabel(`支持 (0/${requiredVotes})`)
                    .setStyle(ButtonStyle.Primary)
            );

        // 编辑消息添加按钮
        await message.edit({
            embeds: [embed],
            components: [buttonRow]
        });
        
        // 保存投票消息到数据库
        await saveMessage({
            messageId: message.id,
            channelId: targetChannel.id,
            proposalId: applicationData.proposalId,
            formData: formData,
            requiredVotes: requiredVotes,
            currentVotes: 0,
            voters: [],
            forumChannelId: proposalSettings?.forumChannelId || legacySettings?.forumChannelId,
            authorId: applicationData.authorId,
            deadline: deadlineDate.toISOString(),
            status: 'pending'
        });
        
        // 更新议案申请状态为已发布
        await updateProposalApplication(applicationData.proposalId, {
            status: 'published',
            publishData: {
                messageId: message.id,
                channelId: targetChannel.id,
                publishedAt: new Date().toISOString()
            },
            updatedAt: new Date().toISOString()
        });

        console.log(`议案已发布到投票频道 - 议案ID: ${applicationData.proposalId}, 消息ID: ${message.id}`);
        
    } catch (error) {
        console.error('发布到投票频道时出错:', error);
        throw error;
    }
}

module.exports = {
    processProposalReview
}; 