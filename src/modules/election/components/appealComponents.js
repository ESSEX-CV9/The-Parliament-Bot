const { EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { ElectionData, RegistrationData } = require('../data/electionDatabase');
const { validateRegistration } = require('../utils/validationUtils');

/**
 * 处理修改报名按钮点击
 */
async function handleAppealRegistration(interaction) {
    try {
        const customIdParts = interaction.customId.split('_');
        const electionId = customIdParts.slice(2, -1).join('_'); // 提取募选ID
        const userId = customIdParts[customIdParts.length - 1];

        // 验证是否为本人操作
        if (interaction.user.id !== userId) {
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 权限错误')
                .setDescription('您只能修改自己的报名信息')
                .setColor('#e74c3c');
            return await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }

        // 获取募选信息
        const election = await ElectionData.getById(electionId);
        if (!election) {
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 错误')
                .setDescription('募选不存在')
                .setColor('#e74c3c');
            return await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }

        // 获取当前报名信息
        const registration = await RegistrationData.getByUserAndElectionWithAllStatuses(userId, electionId);
        if (!registration || registration.status !== 'rejected') {
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 错误')
                .setDescription('无法找到被打回的报名记录')
                .setColor('#e74c3c');
            return await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }

        // 检查募选状态
        // if (election.status !== 'registration') {
        //     const errorEmbed = new EmbedBuilder()
        //         .setTitle('❌ 错误')
        //         .setDescription('当前募选不在报名阶段，无法修改报名')
        //         .setColor('#e74c3c');
        //     return await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        // }

        // 如果募选已进入投票阶段，且用户不是被打回状态，不允许修改
        if (election.status === 'voting' && registration.status !== 'rejected') {
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 错误')
                .setDescription('投票已开始，无法修改报名')
                .setColor('#e74c3c');
            return await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }

        if (election.status === 'completed') {
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 错误')
                .setDescription('募选已完成，无法修改报名')
                .setColor('#e74c3c');
            return await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }

        // 创建修改报名的模态框
        const modal = createAppealModal(election, registration);
        await interaction.showModal(modal);

    } catch (error) {
        console.error('处理申诉报名时出错:', error);
        const errorEmbed = new EmbedBuilder()
            .setTitle('❌ 系统错误')
            .setDescription('处理申诉时发生错误，请稍后重试')
            .setColor('#e74c3c');
        
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
        } else {
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }
    }
}

/**
 * 处理放弃参选按钮点击
 */
async function handleWithdrawRegistration(interaction) {
    try {
        const customIdParts = interaction.customId.split('_');
        const electionId = customIdParts.slice(2, -1).join('_'); // 提取募选ID
        const userId = customIdParts[customIdParts.length - 1];

        // 验证是否为本人操作
        if (interaction.user.id !== userId) {
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 权限错误')
                .setDescription('您只能撤回自己的报名')
                .setColor('#e74c3c');
            return await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }

        // 获取募选信息
        const election = await ElectionData.getById(electionId);
        if (!election) {
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 错误')
                .setDescription('募选不存在')
                .setColor('#e74c3c');
            return await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }

        // 获取当前报名信息
        const registration = await RegistrationData.getByUserAndElectionWithAllStatuses(userId, electionId);
        if (!registration || registration.status !== 'rejected') {
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 错误')
                .setDescription('无法找到被打回的报名记录')
                .setColor('#e74c3c');
            return await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }

        // 撤回报名
        await RegistrationData.withdraw(registration.registrationId);

        const successEmbed = new EmbedBuilder()
            .setTitle('✅ 放弃参选')
            .setDescription(`您已成功放弃参加 **${election.name}** 的募选`)
            .setColor('#95a5a6')
            .addFields(
                { name: '操作时间', value: `<t:${Math.floor(Date.now() / 1000)}:f>`, inline: true },
                { name: '说明', value: '如需重新参选，请等待下次募选机会', inline: false }
            );

        await interaction.reply({ embeds: [successEmbed], ephemeral: true });

    } catch (error) {
        console.error('处理放弃参选时出错:', error);
        const errorEmbed = new EmbedBuilder()
            .setTitle('❌ 系统错误')
            .setDescription('处理放弃参选时发生错误，请稍后重试')
            .setColor('#e74c3c');
        
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
        } else {
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }
    }
}

/**
 * 创建申诉表单模态框
 */
function createAppealModal(election, registration) {
    const modal = new ModalBuilder()
        .setCustomId(`appeal_modal_${election.electionId}_${registration.userId}`)
        .setTitle(`修改报名 - ${election.name}`);

    // 职位选择 - 预填充当前第一志愿
    const positionOptions = Object.entries(election.positions)
        .map(([id, pos]) => `${id}:${pos.name}`)
        .join('\n');

    const firstChoiceInput = new TextInputBuilder()
        .setCustomId('first_choice')
        .setLabel('第一志愿职位ID（必填）')
        .setStyle(TextInputStyle.Short)
        .setValue(registration.firstChoicePosition || '')
        .setPlaceholder('请填写职位ID')
        .setRequired(true);

    const secondChoiceInput = new TextInputBuilder()
        .setCustomId('second_choice')
        .setLabel('第二志愿职位ID（选填）')
        .setStyle(TextInputStyle.Short)
        .setValue(registration.secondChoicePosition || '')
        .setPlaceholder('请填写职位ID，不填则视为无第二志愿')
        .setRequired(false);

    const selfIntroductionInput = new TextInputBuilder()
        .setCustomId('self_introduction')
        .setLabel('自我介绍（选填，最多1000字符）')
        .setStyle(TextInputStyle.Paragraph)
        .setValue(registration.selfIntroduction || '')
        .setPlaceholder('请简要介绍自己...')
        .setMaxLength(1000)
        .setRequired(false);

    const positionListInput = new TextInputBuilder()
        .setCustomId('position_list')
        .setLabel('可选职位列表（仅供参考，请勿修改）')
        .setStyle(TextInputStyle.Paragraph)
        .setValue(positionOptions)
        .setRequired(false);

    const row1 = new ActionRowBuilder().addComponents(firstChoiceInput);
    const row2 = new ActionRowBuilder().addComponents(secondChoiceInput);
    const row3 = new ActionRowBuilder().addComponents(selfIntroductionInput);
    const row4 = new ActionRowBuilder().addComponents(positionListInput);

    modal.addComponents(row1, row2, row3, row4);
    return modal;
}

/**
 * 处理申诉表单提交
 */
async function handleAppealModal(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });

        const customIdParts = interaction.customId.split('_');
        const electionId = customIdParts.slice(2, -1).join('_'); // 提取募选ID
        const userId = customIdParts[customIdParts.length - 1];

        // 验证是否为本人操作
        if (interaction.user.id !== userId) {
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 权限错误')
                .setDescription('您只能修改自己的报名信息')
                .setColor('#e74c3c');
            return await interaction.editReply({ embeds: [errorEmbed] });
        }

        // 获取表单数据
        const firstChoice = interaction.fields.getTextInputValue('first_choice').trim();
        const secondChoice = interaction.fields.getTextInputValue('second_choice').trim() || null;
        const selfIntroduction = interaction.fields.getTextInputValue('self_introduction').trim() || null;

        // 获取募选信息
        const election = await ElectionData.getById(electionId);
        if (!election) {
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 错误')
                .setDescription('募选不存在')
                .setColor('#e74c3c');
            return await interaction.editReply({ embeds: [errorEmbed] });
        }

        // 获取当前报名信息
        const registration = await RegistrationData.getByUserAndElectionWithAllStatuses(userId, electionId);
        if (!registration || registration.status !== 'rejected') {
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 错误')
                .setDescription('无法找到被打回的报名记录')
                .setColor('#e74c3c');
            return await interaction.editReply({ embeds: [errorEmbed] });
        }

        // 构建新的报名数据
        const newRegistrationData = {
            electionId,
            userId,
            userDisplayName: interaction.user.displayName || interaction.user.username,
            firstChoicePosition: firstChoice,
            secondChoicePosition: secondChoice,
            selfIntroduction
        };

        // 验证报名数据
        const validation = validateRegistration(newRegistrationData, election);
        if (!validation.isValid) {
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 数据验证失败')
                .setDescription('报名信息有误，请检查后重新提交')
                .setColor('#e74c3c')
                .addFields(
                    { name: '错误详情', value: validation.errors.join('\n'), inline: false }
                );
            return await interaction.editReply({ embeds: [errorEmbed] });
        }

        // 更新报名数据
        const updatedRegistration = await RegistrationData.update(registration.registrationId, {
            firstChoicePosition: firstChoice,
            secondChoicePosition: secondChoice,
            selfIntroduction,
            status: 'active', // 重置为正常状态
            rejectedAt: null,
            rejectedBy: null,
            rejectedReason: null,
            appealedAt: new Date().toISOString(), // 记录申诉时间
            isAppealed: true // 标记为申诉后恢复
        });

        // 更新候选人介绍消息（如果存在）
        await updateAppealedIntroductionMessage(updatedRegistration, election, interaction);

        const firstPosition = election.positions[firstChoice];
        const secondPosition = secondChoice ? election.positions[secondChoice] : null;

        const successEmbed = new EmbedBuilder()
            .setTitle('✅ 报名修改成功')
            .setDescription(`您已成功修改在 **${election.name}** 的报名信息`)
            .setColor('#2ecc71')
            .addFields(
                { name: '第一志愿', value: firstPosition?.name || '未知职位', inline: true }
            );

        if (secondPosition) {
            successEmbed.addFields(
                { name: '第二志愿', value: secondPosition.name, inline: true }
            );
        }

        if (selfIntroduction) {
            successEmbed.addFields(
                { name: '自我介绍', value: selfIntroduction, inline: false }
            );
        }

        successEmbed.addFields(
            { name: '修改时间', value: `<t:${Math.floor(Date.now() / 1000)}:f>`, inline: true },
            { name: '参选状态', value: '✅ 恢复参选', inline: true },
            { name: '后续流程', value: '候选人简介已更新，请等待募选流程继续进行', inline: false }
        );

        await interaction.editReply({ embeds: [successEmbed] });

    } catch (error) {
        console.error('处理申诉表单时出错:', error);
        const errorEmbed = new EmbedBuilder()
            .setTitle('❌ 系统错误')
            .setDescription('处理申诉时发生错误，请稍后重试')
            .setColor('#e74c3c');
        
        if (interaction.deferred) {
            await interaction.editReply({ embeds: [errorEmbed] });
        } else {
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }
    }
}

/**
 * 更新申诉后的候选人介绍消息
 * @param {object} registration - 更新后的报名信息
 * @param {object} election - 募选信息
 * @param {object} interaction - Discord交互对象（用于获取client）
 */
async function updateAppealedIntroductionMessage(registration, election, interaction) {
    try {
        if (!registration.introductionMessageId || !registration.introductionChannelId) {
            console.log(`候选人 ${registration.userId} 的简介消息ID未记录，跳过消息更新`);
            return;
        }

        // 从候选人管理服务中获取client实例
        // 由于我们在组件中，需要通过其他方式获取client
        // 我们可以从interaction中获取
        const client = interaction.client;
        
        const channel = client.channels.cache.get(registration.introductionChannelId);
        if (!channel) {
            console.error(`找不到频道: ${registration.introductionChannelId}`);
            return;
        }

        const message = await channel.messages.fetch(registration.introductionMessageId).catch(() => null);
        if (!message) {
            console.error(`找不到消息: ${registration.introductionMessageId}`);
            return;
        }

        // 创建申诉后恢复的嵌入消息
        const firstPosition = election.positions[registration.firstChoicePosition];
        const secondPosition = registration.secondChoicePosition ? 
            election.positions[registration.secondChoicePosition] : null;

        const { EmbedBuilder } = require('discord.js');
        const embed = new EmbedBuilder()
            .setTitle(`候选人介绍 🔄 修改后恢复`)
            .setColor('#9b59b6') // 紫色表示申诉后恢复
            .addFields(
                { name: '候选人', value: `<@${registration.userId}>`, inline: true },
                { name: '状态', value: '🔄 恢复参选', inline: true },
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
        } else {
            embed.addFields(
                { name: '自我介绍', value: '该候选人未填写自我介绍', inline: false }
            );
        }

        embed.addFields(
            { name: '原报名时间', value: `<t:${Math.floor(new Date(registration.registeredAt).getTime() / 1000)}:f>`, inline: true },
            { name: '报名恢复时间', value: `<t:${Math.floor(new Date(registration.appealedAt).getTime() / 1000)}:f>`, inline: true }
        );

        // 添加特殊说明
        embed.addFields(
            { name: '⚠️ 特别说明', value: '此候选人原先被打回，经修改报名后重新参选', inline: false }
        );
        
        await message.edit({ 
            embeds: [embed],
            allowedMentions: { 
                users: [registration.userId]
            }
        });
        
        console.log(`已更新候选人 ${registration.userId} 的申诉后简介消息`);

    } catch (error) {
        console.error('更新申诉后候选人简介消息时出错:', error);
    }
}

module.exports = {
    handleAppealRegistration,
    handleWithdrawRegistration,
    handleAppealModal,
    createAppealModal,
    updateAppealedIntroductionMessage
}; 