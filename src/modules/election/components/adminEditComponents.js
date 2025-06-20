const { EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { ElectionData, RegistrationData } = require('../data/electionDatabase');
const { CandidateManagementService } = require('../services/candidateManagementService');
const { validateRegistration, sanitizeInput } = require('../utils/validationUtils');

/**
 * 处理管理员状态变更选择
 */
async function handleAdminStatusChange(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });

        const customIdParts = interaction.customId.split('_');
        const electionId = customIdParts.slice(3, -1).join('_'); // 提取募选ID
        const userId = customIdParts[customIdParts.length - 1]; // 最后一部分是用户ID
        const action = interaction.values[0];

        // 获取募选信息
        const election = await ElectionData.getById(electionId);
        if (!election) {
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 错误')
                .setDescription('募选不存在')
                .setColor('#e74c3c');
            return await interaction.editReply({ embeds: [errorEmbed] });
        }

        // 获取候选人信息
        const candidateService = new CandidateManagementService(interaction.client);
        const candidateInfo = await candidateService.getCandidateInfo(userId, electionId);
        const { registration } = candidateInfo;

        // 如果是需要原因的操作，显示原因输入模态框
        if (action === 'reject' || action === 'revoke') {
            await showReasonModal(interaction, electionId, userId, action);
            return;
        }

        // 执行状态变更
        let result;
        let successMessage = '';
        let operatorId = interaction.user.id;

        switch (action) {
            case 'activate':
                result = await activateCandidate(registration.registrationId, operatorId);
                successMessage = '候选人已激活为正常参选状态';
                break;
                
            case 'mark_appealed':
                result = await markAsAppealed(registration.registrationId, operatorId);
                successMessage = '已标记为申诉恢复状态';
                break;
                
            case 'unmark_appealed':
                result = await unmarkAsAppealed(registration.registrationId, operatorId);
                successMessage = '已取消申诉恢复标记';
                break;
                
            default:
                throw new Error(`未知的状态操作: ${action}`);
        }

        // 更新候选人简介消息
        await candidateService.updateIntroductionMessage(
            result, 
            'active', 
            `管理员操作: ${successMessage}`,
            operatorId
        );

        // 发送成功消息
        const successEmbed = new EmbedBuilder()
            .setTitle('✅ 操作成功')
            .setDescription(`已成功${successMessage}`)
            .setColor('#2ecc71')
            .addFields(
                { name: '候选人', value: `<@${userId}>`, inline: true },
                { name: '操作人', value: `<@${operatorId}>`, inline: true },
                { name: '操作时间', value: `<t:${Math.floor(Date.now() / 1000)}:f>`, inline: true },
                { name: '募选', value: election.name, inline: false }
            );

        await interaction.editReply({ embeds: [successEmbed] });

    } catch (error) {
        console.error('处理管理员状态变更时出错:', error);
        
        const errorEmbed = new EmbedBuilder()
            .setTitle('❌ 系统错误')
            .setDescription('处理状态变更时发生错误，请稍后重试')
            .setColor('#e74c3c');

        if (interaction.deferred) {
            await interaction.editReply({ embeds: [errorEmbed] });
        } else {
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }
    }
}

/**
 * 显示原因输入模态框
 */
async function showReasonModal(interaction, electionId, userId, action) {
    const actionName = action === 'reject' ? '打回' : '撤销';
    
    const modal = new ModalBuilder()
        .setCustomId(`admin_reason_${action}_${electionId}_${userId}`)
        .setTitle(`${actionName}候选人 - 输入原因`);

    const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel(`${actionName}原因`)
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(500)
        .setPlaceholder(`请输入${actionName}该候选人的原因...`);

    const row = new ActionRowBuilder().addComponents(reasonInput);
    modal.addComponents(row);

    await interaction.showModal(modal);
}

/**
 * 处理原因模态框提交
 */
async function handleReasonModal(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });

        const customIdParts = interaction.customId.split('_');
        const action = customIdParts[2]; // reject 或 revoke
        const electionId = customIdParts.slice(3, -1).join('_');
        const userId = customIdParts[customIdParts.length - 1];
        const reason = sanitizeInput(interaction.fields.getTextInputValue('reason'), 500);

        // 获取募选信息
        const election = await ElectionData.getById(electionId);
        if (!election) {
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 错误')
                .setDescription('募选不存在')
                .setColor('#e74c3c');
            return await interaction.editReply({ embeds: [errorEmbed] });
        }

        // 执行操作
        const candidateService = new CandidateManagementService(interaction.client);
        let result;
        let actionName;

        if (action === 'reject') {
            result = await candidateService.rejectCandidate(
                userId, 
                electionId, 
                reason, 
                interaction.user.id
            );
            actionName = '打回';
        } else if (action === 'revoke') {
            result = await candidateService.revokeCandidate(
                userId, 
                electionId, 
                reason, 
                interaction.user.id
            );
            actionName = '撤销';
        }

        // 发送成功消息
        const successEmbed = new EmbedBuilder()
            .setTitle('✅ 操作成功')
            .setDescription(`已成功${actionName}候选人`)
            .setColor(action === 'reject' ? '#f39c12' : '#e74c3c')
            .addFields(
                { name: '候选人', value: `<@${userId}>`, inline: true },
                { name: '操作类型', value: actionName, inline: true },
                { name: '操作人', value: `<@${interaction.user.id}>`, inline: true },
                { name: '操作原因', value: reason, inline: false },
                { name: '募选', value: election.name, inline: true },
                { name: '操作时间', value: `<t:${Math.floor(Date.now() / 1000)}:f>`, inline: true }
            );

        if (action === 'reject') {
            successEmbed.addFields(
                { name: '后续处理', value: '候选人将收到私信通知，可选择修改报名或放弃参选', inline: false }
            );
        } else {
            successEmbed.addFields(
                { name: '后续处理', value: '候选人将收到私信通知，资格已永久撤销', inline: false }
            );
        }

        await interaction.editReply({ embeds: [successEmbed] });

    } catch (error) {
        console.error('处理原因模态框时出错:', error);
        
        const errorEmbed = new EmbedBuilder()
            .setTitle('❌ 系统错误')
            .setDescription('处理操作时发生错误，请稍后重试')
            .setColor('#e74c3c');

        if (interaction.deferred) {
            await interaction.editReply({ embeds: [errorEmbed] });
        } else {
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }
    }
}

/**
 * 处理信息编辑模态框提交
 */
async function handleAdminEditInfo(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });

        const customIdParts = interaction.customId.split('_');
        const electionId = customIdParts.slice(3, -1).join('_');
        const userId = customIdParts[customIdParts.length - 1];

        // 获取表单数据
        const displayName = sanitizeInput(interaction.fields.getTextInputValue('display_name'), 32);
        const firstChoice = sanitizeInput(interaction.fields.getTextInputValue('first_choice'), 50);
        const secondChoice = sanitizeInput(interaction.fields.getTextInputValue('second_choice') || '', 50) || null;
        const selfIntroduction = interaction.fields.getTextInputValue('self_introduction')?.trim().substring(0, 2000) || null;

        // 获取募选信息
        const election = await ElectionData.getById(electionId);
        if (!election) {
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 错误')
                .setDescription('募选不存在')
                .setColor('#e74c3c');
            return await interaction.editReply({ embeds: [errorEmbed] });
        }

        // 验证职位是否存在
        if (!election.positions[firstChoice]) {
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 数据验证失败')
                .setDescription('第一志愿职位不存在')
                .setColor('#e74c3c');
            return await interaction.editReply({ embeds: [errorEmbed] });
        }

        if (secondChoice && !election.positions[secondChoice]) {
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 数据验证失败')
                .setDescription('第二志愿职位不存在')
                .setColor('#e74c3c');
            return await interaction.editReply({ embeds: [errorEmbed] });
        }

        // 验证第一志愿和第二志愿不能相同
        if (secondChoice && firstChoice === secondChoice) {
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 数据验证失败')
                .setDescription('第一志愿和第二志愿不能相同')
                .setColor('#e74c3c');
            return await interaction.editReply({ embeds: [errorEmbed] });
        }

        // 获取原始注册信息
        const registration = await RegistrationData.getByUserAndElectionWithAllStatuses(userId, electionId);
        if (!registration) {
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 错误')
                .setDescription('找不到候选人报名信息')
                .setColor('#e74c3c');
            return await interaction.editReply({ embeds: [errorEmbed] });
        }

        // 更新报名数据
        const updatedData = {
            userDisplayName: displayName,
            firstChoicePosition: firstChoice,
            secondChoicePosition: secondChoice,
            selfIntroduction: selfIntroduction,
            lastModifiedAt: new Date().toISOString()
        };

        await RegistrationData.update(registration.registrationId, updatedData);

        // 更新候选人简介消息（如果存在）
        const candidateService = new CandidateManagementService(interaction.client);
        const updatedRegistration = { ...registration, ...updatedData };
        
        if (registration.status === 'active') {
            await candidateService.updateIntroductionMessage(
                updatedRegistration, 
                'active', 
                '管理员编辑了候选人信息',
                interaction.user.id
            );
        }

        // 构建变更详情
        const changes = [];
        if (registration.userDisplayName !== displayName) {
            changes.push(`显示名称: "${registration.userDisplayName}" → "${displayName}"`);
        }
        if (registration.firstChoicePosition !== firstChoice) {
            const oldPos = election.positions[registration.firstChoicePosition]?.name || '未知';
            const newPos = election.positions[firstChoice]?.name || '未知';
            changes.push(`第一志愿: "${oldPos}" → "${newPos}"`);
        }
        if (registration.secondChoicePosition !== secondChoice) {
            const oldPos = registration.secondChoicePosition ? 
                (election.positions[registration.secondChoicePosition]?.name || '未知') : '无';
            const newPos = secondChoice ? 
                (election.positions[secondChoice]?.name || '未知') : '无';
            changes.push(`第二志愿: "${oldPos}" → "${newPos}"`);
        }
        if (registration.selfIntroduction !== selfIntroduction) {
            changes.push('自我介绍已更新');
        }

        // 发送成功消息
        const successEmbed = new EmbedBuilder()
            .setTitle('✅ 编辑成功')
            .setDescription('候选人信息已成功更新')
            .setColor('#2ecc71')
            .addFields(
                { name: '候选人', value: `<@${userId}>`, inline: true },
                { name: '操作人', value: `<@${interaction.user.id}>`, inline: true },
                { name: '操作时间', value: `<t:${Math.floor(Date.now() / 1000)}:f>`, inline: true },
                { name: '募选', value: election.name, inline: false }
            );

        if (changes.length > 0) {
            successEmbed.addFields(
                { name: '变更内容', value: changes.join('\n'), inline: false }
            );
        } else {
            successEmbed.addFields(
                { name: '变更内容', value: '无变更（所有信息保持原样）', inline: false }
            );
        }

        await interaction.editReply({ embeds: [successEmbed] });

    } catch (error) {
        console.error('处理信息编辑时出错:', error);
        
        const errorEmbed = new EmbedBuilder()
            .setTitle('❌ 系统错误')
            .setDescription('编辑候选人信息时发生错误，请稍后重试')
            .setColor('#e74c3c');

        if (interaction.deferred) {
            await interaction.editReply({ embeds: [errorEmbed] });
        } else {
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }
    }
}

/**
 * 激活候选人（将非active状态改为active）
 */
async function activateCandidate(registrationId, operatorId) {
    const updateData = {
        status: 'active',
        rejectedAt: null,
        rejectedBy: null,
        rejectedReason: null,
        revokedAt: null,
        revokedBy: null,
        revokedReason: null,
        lastModifiedAt: new Date().toISOString()
    };

    return await RegistrationData.update(registrationId, updateData);
}

/**
 * 标记为申诉恢复
 */
async function markAsAppealed(registrationId, operatorId) {
    const updateData = {
        isAppealed: true,
        appealedAt: new Date().toISOString(),
        lastModifiedAt: new Date().toISOString()
    };

    return await RegistrationData.update(registrationId, updateData);
}

/**
 * 取消申诉恢复标记
 */
async function unmarkAsAppealed(registrationId, operatorId) {
    const updateData = {
        isAppealed: false,
        appealedAt: null,
        lastModifiedAt: new Date().toISOString()
    };

    return await RegistrationData.update(registrationId, updateData);
}

module.exports = {
    handleAdminStatusChange,
    handleReasonModal,
    handleAdminEditInfo
}; 