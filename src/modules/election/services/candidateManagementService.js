const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { ElectionData, RegistrationData } = require('../data/electionDatabase');
const { formatChineseTime } = require('../utils/timeUtils');

/**
 * 候选人管理服务
 */
class CandidateManagementService {
    constructor(client) {
        this.client = client;
    }

    /**
     * 获取候选人详细信息
     * @param {string} userId - 候选人用户ID
     * @param {string} electionId - 募选ID
     * @returns {object} 候选人信息
     */
    async getCandidateInfo(userId, electionId) {
        try {
            // 获取募选信息
            const election = await ElectionData.getById(electionId);
            if (!election) {
                throw new Error('募选不存在');
            }

            // 获取候选人报名信息
            const registration = await RegistrationData.getByUserAndElectionWithAllStatuses(userId, electionId);
            if (!registration) {
                throw new Error('该用户未报名此次募选');
            }

            const firstPosition = election.positions[registration.firstChoicePosition];
            const secondPosition = registration.secondChoicePosition ? 
                election.positions[registration.secondChoicePosition] : null;

            return {
                registration,
                election,
                firstPosition,
                secondPosition
            };
        } catch (error) {
            console.error('获取候选人信息时出错:', error);
            throw error;
        }
    }

    /**
     * 打回候选人报名
     * @param {string} userId - 候选人用户ID
     * @param {string} electionId - 募选ID
     * @param {string} reason - 打回原因
     * @param {string} operatorId - 操作人ID
     * @returns {object} 操作结果
     */
    async rejectCandidate(userId, electionId, reason, operatorId) {
        try {
            const candidateInfo = await this.getCandidateInfo(userId, electionId);
            const { registration, election } = candidateInfo;

            if (registration.status !== 'active') {
                throw new Error(`候选人当前状态为: ${registration.status}，无法打回`);
            }

            // 更新数据库状态
            const updatedRegistration = await RegistrationData.rejectCandidate(
                registration.registrationId, 
                reason, 
                operatorId
            );

            // 更新候选人简介消息（如果存在）
            await this.updateIntroductionMessage(
                registration, 
                'rejected', 
                reason,
                operatorId
            );

            // 发送私信通知
            await this.sendCandidateNotification(
                userId, 
                'rejected', 
                reason, 
                election
            );

            return {
                success: true,
                registration: updatedRegistration,
                action: 'rejected'
            };

        } catch (error) {
            console.error('打回候选人时出错:', error);
            throw error;
        }
    }

    /**
     * 撤销候选人资格
     * @param {string} userId - 候选人用户ID
     * @param {string} electionId - 募选ID
     * @param {string} reason - 撤销原因
     * @param {string} operatorId - 操作人ID
     * @returns {object} 操作结果
     */
    async revokeCandidate(userId, electionId, reason, operatorId) {
        try {
            const candidateInfo = await this.getCandidateInfo(userId, electionId);
            const { registration, election } = candidateInfo;

            if (registration.status !== 'active') {
                throw new Error(`候选人当前状态为: ${registration.status}，无法撤销`);
            }

            // 更新数据库状态
            const updatedRegistration = await RegistrationData.revokeCandidate(
                registration.registrationId, 
                reason, 
                operatorId
            );

            // 更新候选人简介消息（如果存在）
            await this.updateIntroductionMessage(
                registration, 
                'revoked', 
                reason,
                operatorId
            );

            // 发送私信通知
            await this.sendCandidateNotification(
                userId, 
                'revoked', 
                reason, 
                election
            );

            return {
                success: true,
                registration: updatedRegistration,
                action: 'revoked'
            };

        } catch (error) {
            console.error('撤销候选人时出错:', error);
            throw error;
        }
    }

    /**
     * 更新候选人简介消息
     * @param {object} registration - 报名信息
     * @param {string} newStatus - 新状态
     * @param {string} reason - 原因
     * @param {string} operatorId - 操作人ID
     */
    async updateIntroductionMessage(registration, newStatus, reason, operatorId) {
        try {
            if (!registration.introductionMessageId || !registration.introductionChannelId) {
                console.log(`候选人 ${registration.userId} 的简介消息ID未记录，跳过消息更新`);
                return;
            }

            const channel = this.client.channels.cache.get(registration.introductionChannelId);
            if (!channel) {
                console.error(`找不到频道: ${registration.introductionChannelId}`);
                return;
            }

            const message = await channel.messages.fetch(registration.introductionMessageId).catch(() => null);
            if (!message) {
                console.error(`找不到消息: ${registration.introductionMessageId}`);
                return;
            }

            // 创建更新后的嵌入消息
            const statusEmbed = this.createStatusUpdateEmbed(registration, newStatus, reason);
            
            await message.edit({ embeds: [statusEmbed] });
            console.log(`已更新候选人 ${registration.userId} 的简介消息状态为: ${newStatus}`);

        } catch (error) {
            console.error('更新候选人简介消息时出错:', error);
        }
    }

    /**
     * 创建状态更新的嵌入消息
     * @param {object} registration - 报名信息
     * @param {string} status - 状态
     * @param {string} reason - 原因
     * @returns {EmbedBuilder} 嵌入消息
     */
    createStatusUpdateEmbed(registration, status, reason) {
        const timestamp = Math.floor(Date.now() / 1000);
        
        if (status === 'rejected') {
            return new EmbedBuilder()
                .setTitle(`候选人介绍 ⚠️ 已打回`)
                .setColor('#f39c12')
                .addFields(
                    { name: '候选人', value: `<@${registration.userId}>`, inline: true },
                    { name: '状态', value: '⚠️ 报名已打回', inline: true },
                    { name: '打回原因', value: reason || '无', inline: false },
                    { name: '打回时间', value: `<t:${timestamp}:f>`, inline: true }
                );
        } else if (status === 'revoked') {
            return new EmbedBuilder()
                .setTitle(`候选人介绍 ❌ 已撤销`)
                .setColor('#e74c3c')
                .addFields(
                    { name: '候选人', value: `<@${registration.userId}>`, inline: true },
                    { name: '状态', value: '❌ 参选资格已撤销', inline: true },
                    { name: '撤销原因', value: reason || '无', inline: false },
                    { name: '撤销时间', value: `<t:${timestamp}:f>`, inline: true }
                );
        }
    }

    /**
     * 发送私信通知给候选人
     * @param {string} userId - 候选人用户ID
     * @param {string} action - 操作类型
     * @param {string} reason - 原因
     * @param {object} election - 募选信息
     */
    async sendCandidateNotification(userId, action, reason, election) {
        try {
            const user = await this.client.users.fetch(userId).catch(() => null);
            if (!user) {
                console.error(`找不到用户: ${userId}`);
                return;
            }

            const embed = this.createNotificationEmbed(action, reason, election);
            const messageData = { embeds: [embed] };

            // 只有打回才提供申诉按钮
            if (action === 'rejected') {
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`appeal_registration_${election.electionId}_${userId}`)
                        .setLabel('修改报名')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('✏️'),
                    new ButtonBuilder()
                        .setCustomId(`withdraw_registration_${election.electionId}_${userId}`)
                        .setLabel('放弃参选')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('❌')
                );
                messageData.components = [row];
            }

            await user.send(messageData);
            console.log(`已向候选人 ${userId} 发送${action === 'rejected' ? '打回' : '撤销'}通知`);

        } catch (error) {
            console.error('发送候选人通知时出错:', error);
        }
    }

    /**
     * 创建通知嵌入消息
     * @param {string} action - 操作类型
     * @param {string} reason - 原因
     * @param {object} election - 募选信息
     * @returns {EmbedBuilder} 嵌入消息
     */
    createNotificationEmbed(action, reason, election) {
        const timestamp = Math.floor(Date.now() / 1000);

        if (action === 'rejected') {
            return new EmbedBuilder()
                .setTitle('📋 报名被打回')
                .setDescription(`您在 **${election.name}** 的参选报名已被打回。`)
                .setColor('#e74c3c')
                .addFields(
                    { name: '打回原因', value: reason || '无', inline: false },
                    { name: '打回时间', value: `<t:${timestamp}:f>`, inline: true },
                    { name: '后续操作', value: '您可以选择修改报名信息重新提交，或放弃本次参选。', inline: false }
                );
        } else {
            return new EmbedBuilder()
                .setTitle('❌ 参选资格被撤销')
                .setDescription(`您在 **${election.name}** 的参选资格已被撤销。`)
                .setColor('#f39c12')
                .addFields(
                    { name: '撤销原因', value: reason || '无', inline: false },
                    { name: '撤销时间', value: `<t:${timestamp}:f>`, inline: true }
                );
        }
    }

    /**
     * 创建候选人信息嵌入消息
     * @param {object} candidateInfo - 候选人信息
     * @returns {EmbedBuilder} 嵌入消息
     */
    createCandidateInfoEmbed(candidateInfo) {
        const { registration, election, firstPosition, secondPosition } = candidateInfo;
        
        const statusMap = {
            'active': registration.isAppealed ? '🔄 恢复参选' : '✅ 正常参选',
            'rejected': '⚠️ 已打回',
            'revoked': '❌ 已撤销',
            'withdrawn': '🚫 已撤回'
        };

        const statusColor = {
            'active': registration.isAppealed ? '#9b59b6' : '#2ecc71',
            'rejected': '#e74c3c',
            'revoked': '#f39c12',
            'withdrawn': '#95a5a6'
        };

        const embed = new EmbedBuilder()
            .setTitle('📊 候选人详细信息')
            .setColor(statusColor[registration.status] || '#3498db')
            .addFields(
                { name: '候选人', value: `<@${registration.userId}>`, inline: true },
                { name: '参选状态', value: statusMap[registration.status] || registration.status, inline: true },
                { name: '第一志愿', value: firstPosition?.name || '未知职位', inline: true }
            );

        if (secondPosition) {
            embed.addFields(
                { name: '第二志愿', value: secondPosition.name, inline: true }
            );
        }

        if (registration.selfIntroduction) {
            embed.addFields(
                { name: '自我介绍', value: registration.selfIntroduction, inline: false }
            );
        }

        embed.addFields(
            { name: '报名时间', value: `<t:${Math.floor(new Date(registration.registeredAt).getTime() / 1000)}:f>`, inline: true }
        );

        // 如果是申诉后恢复，添加申诉信息
        if (registration.isAppealed && registration.appealedAt) {
            embed.addFields(
                { name: '申诉恢复时间', value: `<t:${Math.floor(new Date(registration.appealedAt).getTime() / 1000)}:f>`, inline: true }
            );
        }

        // 显示状态变更信息
        if (registration.status === 'rejected' && registration.rejectedAt) {
            embed.addFields(
                { name: '打回时间', value: `<t:${Math.floor(new Date(registration.rejectedAt).getTime() / 1000)}:f>`, inline: true },
                { name: '打回原因', value: registration.rejectedReason || '无', inline: false }
            );
        } else if (registration.status === 'revoked' && registration.revokedAt) {
            embed.addFields(
                { name: '撤销时间', value: `<t:${Math.floor(new Date(registration.revokedAt).getTime() / 1000)}:f>`, inline: true },
                { name: '撤销原因', value: registration.revokedReason || '无', inline: false }
            );
        }

        return embed;
    }
}

module.exports = { CandidateManagementService }; 