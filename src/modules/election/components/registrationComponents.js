const { 
    ActionRowBuilder, 
    StringSelectMenuBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle 
} = require('discord.js');
const { ElectionData, RegistrationData } = require('../data/electionDatabase');
const { validateRegistration, getRegistrationPermissionDetails, sanitizeInput } = require('../utils/validationUtils');
const { 
    createRegistrationSuccessEmbed, 
    createErrorEmbed, 
    createSuccessEmbed 
} = require('../utils/messageUtils');

/**
 * 处理报名按钮点击
 */
async function handleRegistrationButton(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });

        const parts = interaction.customId.split('_');
        const electionId = parts.slice(2).join('_'); // 从index 2开始拼接
        const userId = interaction.user.id;
        const userDisplayName = interaction.user.displayName || interaction.user.username;
        const guildId = interaction.guild.id;

        // ===== 新增：详细权限验证 =====
        console.log(`检查用户 ${interaction.user.tag} (${userId}) 的报名权限...`);
        const permissionDetails = await getRegistrationPermissionDetails(interaction.member, guildId);
        
        if (!permissionDetails.hasPermission) {
            console.log(`用户 ${interaction.user.tag} 报名权限不足`);
            
            let errorMessage = '你缺少可以参与此募选报名的身份组。';
            
            if (permissionDetails.allowedRoles && permissionDetails.allowedRoles.length > 0) {
                const allowedRoleNames = permissionDetails.allowedRoles.map(role => `**${role.name}**`).join('、');
                errorMessage += `\n\n**允许报名的身份组：**\n${allowedRoleNames}`;
                
                if (permissionDetails.userRoles && permissionDetails.userRoles.length > 0) {
                    const userRoleNames = permissionDetails.userRoles.map(role => role.name).join('、');
                    errorMessage += `\n\n**你当前的身份组：**\n${userRoleNames}`;
                } else {
                    errorMessage += `\n\n**你当前的身份组：**\n无特殊身份组`;
                }
            }
            
            errorMessage += '\n\n请联系服务器管理员了解报名身份组要求。';
            
            const errorEmbed = createErrorEmbed('权限不足', errorMessage);
            return await interaction.editReply({ embeds: [errorEmbed] });
        }
        console.log(`用户 ${interaction.user.tag} 报名权限验证通过`);
        // ===== 权限验证结束 =====

        // 获取募选信息
        const election = await ElectionData.getById(electionId);
        if (!election) {
            const errorEmbed = createErrorEmbed('募选不存在', '该募选可能已被删除或不存在');
            return await interaction.editReply({ embeds: [errorEmbed] });
        }

        // 检查募选状态
        const now = new Date();
        const regStartTime = new Date(election.schedule.registrationStartTime);
        const regEndTime = new Date(election.schedule.registrationEndTime);

        if (now < regStartTime) {
            const errorEmbed = createErrorEmbed('报名未开始', '报名时间还未到，请稍后再试');
            return await interaction.editReply({ embeds: [errorEmbed] });
        }

        if (now > regEndTime) {
            const errorEmbed = createErrorEmbed('报名已结束', '报名时间已结束，无法再报名');
            return await interaction.editReply({ embeds: [errorEmbed] });
        }

        // 检查用户是否已报名（只检查活跃状态的报名）
        const existingRegistration = await RegistrationData.getByUserAndElection(userId, electionId);
        
        if (existingRegistration) {
            // 显示已有报名信息和操作选项
            return await showExistingRegistration(interaction, existingRegistration, election);
        } else {
            // 开始新的报名流程
            return await startRegistrationFlow(interaction, election, userId, userDisplayName);
        }

    } catch (error) {
        console.error('处理报名按钮时出错:', error);
        const errorEmbed = createErrorEmbed('系统错误', '处理报名时发生错误，请稍后重试');
        
        if (interaction.deferred) {
            await interaction.editReply({ embeds: [errorEmbed] });
        } else {
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }
    }
}

/**
 * 显示已有的报名信息
 */
async function showExistingRegistration(interaction, registration, election) {
    const embed = createRegistrationSuccessEmbed(registration, election);
    embed.setTitle('📝 你的报名信息');
    embed.setDescription('你已经报名过了，以下是你的报名信息：');

    const editButton = new ButtonBuilder()
        .setCustomId(`election_edit_registration_${election.electionId}`)
        .setLabel('编辑报名')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('✏️');

    const withdrawButton = new ButtonBuilder()
        .setCustomId(`election_withdraw_registration_${election.electionId}`)
        .setLabel('撤回报名')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🗑️');

    const row = new ActionRowBuilder().addComponents(editButton, withdrawButton);

    await interaction.editReply({ embeds: [embed], components: [row] });
}

/**
 * 开始报名流程
 */
async function startRegistrationFlow(interaction, election, userId, userDisplayName) {
    // 创建第一志愿选择器
    const positions = Object.values(election.positions);
    const options = positions.map(pos => ({
        label: pos.name,
        value: pos.id,
        description: `募选 ${pos.maxWinners} 人` + (pos.description ? ` - ${pos.description}` : ''),
        emoji: '🎯'
    }));

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`election_select_first_choice_${election.electionId}`)
        .setPlaceholder('请选择你的第一志愿职位')
        .addOptions(options)
        .setMaxValues(1);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    await interaction.editReply({
        content: '**第一步：选择第一志愿**\n请从下方选择你想要竞选的第一志愿职位：',
        components: [row]
    });
}

/**
 * 处理第一志愿选择
 */
async function handleFirstChoiceSelection(interaction) {
    try {
        // 修复募选ID提取逻辑
        // customId格式: election_select_first_choice_election_1749951053733_0pb907
        const customIdParts = interaction.customId.split('_');
        const electionId = customIdParts.slice(4).join('_'); // 从索引4开始拼接所有部分
        const firstChoice = interaction.values[0];
        const userId = interaction.user.id;

        // 获取募选信息
        const election = await ElectionData.getById(electionId);
        if (!election) {
            const errorEmbed = createErrorEmbed('募选不存在', '该募选可能已被删除或不存在');
            return await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }

        const selectedPosition = election.positions[firstChoice];
        if (!selectedPosition) {
            const errorEmbed = createErrorEmbed('职位不存在', '所选职位可能已被删除');
            return await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }

        // 创建第二志愿选择器（排除第一志愿）
        const positions = Object.values(election.positions).filter(pos => pos.id !== firstChoice);
        
        if (positions.length > 0) {
            // 有其他职位可选，更新消息显示第二志愿选择器
            await interaction.deferUpdate();
            
            const options = positions.map(pos => ({
                label: pos.name,
                value: pos.id,
                description: `募选 ${pos.maxWinners} 人` + (pos.description ? ` - ${pos.description}` : ''),
                emoji: '🎯'
            }));

            // 添加跳过选项
            options.push({
                label: '跳过第二志愿',
                value: 'skip_second_choice',
                description: '不设置第二志愿',
                emoji: '⏭️'
            });

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`election_select_second_choice_${election.electionId}_${firstChoice}`)
                .setPlaceholder('请选择你的第二志愿职位（可选）')
                .addOptions(options)
                .setMaxValues(1);

            const row = new ActionRowBuilder().addComponents(selectMenu);

            await interaction.editReply({
                content: `**第二步：选择第二志愿**\n你的第一志愿：**${selectedPosition.name}**\n\n请选择你的第二志愿职位（可选）：`,
                components: [row]
            });
        } else {
            // 没有其他职位可选，直接进入自我介绍环节
            // 不调用 deferUpdate()，直接显示模态框
            await showIntroductionModal(interaction, election, firstChoice, null);
        }

    } catch (error) {
        console.error('处理第一志愿选择时出错:', error);
        const errorEmbed = createErrorEmbed('系统错误', '处理选择时发生错误，请稍后重试');
        
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        } else if (interaction.deferred) {
            await interaction.editReply({ embeds: [errorEmbed], components: [] });
        }
    }
}

/**
 * 处理第二志愿选择
 */
async function handleSecondChoiceSelection(interaction) {
    try {
        // 不要调用 deferUpdate()，因为我们需要显示模态框
        const parts = interaction.customId.split('_');
        // customId格式: election_select_second_choice_election_1749951053733_0pb907_1
        const firstChoice = parts[parts.length - 1]; // 最后一个是第一志愿
        const electionId = parts.slice(4, -1).join('_'); // 中间部分是募选ID
        const secondChoice = interaction.values[0] === 'skip_second_choice' ? null : interaction.values[0];

        // 获取募选信息
        const election = await ElectionData.getById(electionId);
        if (!election) {
            const errorEmbed = createErrorEmbed('募选不存在', '该募选可能已被删除或不存在');
            return await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }

        // 显示自我介绍模态框
        await showIntroductionModal(interaction, election, firstChoice, secondChoice);

    } catch (error) {
        console.error('处理第二志愿选择时出错:', error);
        const errorEmbed = createErrorEmbed('系统错误', '处理选择时发生错误，请稍后重试');
        
        // 如果还没有回复，则回复错误消息
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }
    }
}

/**
 * 显示自我介绍模态框
 */
async function showIntroductionModal(interaction, election, firstChoice, secondChoice) {
    const modal = new ModalBuilder()
        .setCustomId(`election_introduction_modal_${election.electionId}_${firstChoice}_${secondChoice || 'none'}`)
        .setTitle('自我介绍');

    const introductionInput = new TextInputBuilder()
        .setCustomId('self_introduction')
        .setLabel('自我介绍（可选）')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('请简要介绍你自己，包括你的经验、能力和竞选理由...')
        .setRequired(false)
        .setMaxLength(500);

    const row = new ActionRowBuilder().addComponents(introductionInput);
    modal.addComponents(row);

    await interaction.showModal(modal);
}

/**
 * 处理自我介绍模态框提交
 */
async function handleIntroductionModal(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });

        const parts = interaction.customId.split('_');
        // 修复募选ID提取：election_introduction_modal_election_1749951053733_0pb907_1_none
        const electionId = parts.slice(3, -2).join('_'); // 提取募选ID部分
        const firstChoice = parts[parts.length - 2];
        const secondChoice = parts[parts.length - 1] === 'none' ? null : parts[parts.length - 1];

        const selfIntroduction = sanitizeInput(interaction.fields.getTextInputValue('self_introduction'), 500);
        const userId = interaction.user.id;
        const userDisplayName = interaction.user.displayName || interaction.user.username;

        // 获取募选信息
        const election = await ElectionData.getById(electionId);
        if (!election) {
            const errorEmbed = createErrorEmbed('募选不存在', '该募选可能已被删除或不存在');
            return await interaction.editReply({ embeds: [errorEmbed] });
        }

        // 构建报名数据
        const registrationData = {
            electionId,
            userId,
            userDisplayName,
            firstChoicePosition: firstChoice,
            secondChoicePosition: secondChoice,
            selfIntroduction: selfIntroduction || null
        };

        // 验证报名数据
        const validation = validateRegistration(registrationData, election);
        if (!validation.isValid) {
            const errorEmbed = createErrorEmbed('报名数据无效', validation.errors);
            return await interaction.editReply({ embeds: [errorEmbed] });
        }

        // 保存报名数据
        const registration = await RegistrationData.create(registrationData);
        if (!registration) {
            const errorEmbed = createErrorEmbed('报名失败', '无法保存报名信息，请稍后重试');
            return await interaction.editReply({ embeds: [errorEmbed] });
        }

        // 显示报名成功信息
        const successEmbed = createRegistrationSuccessEmbed(registration, election);
        await interaction.editReply({ embeds: [successEmbed] });

    } catch (error) {
        console.error('处理自我介绍模态框时出错:', error);
        const errorEmbed = createErrorEmbed('系统错误', '处理报名时发生错误，请稍后重试');
        
        if (interaction.deferred) {
            await interaction.editReply({ embeds: [errorEmbed] });
        } else {
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }
    }
}

/**
 * 处理编辑报名按钮
 */
async function handleEditRegistration(interaction) {
    try {
        // 先延迟回复
        await interaction.deferReply({ ephemeral: true });

        // 修复募选ID提取：election_edit_registration_election_1749951053733_0pb907
        const customIdParts = interaction.customId.split('_');
        const electionId = customIdParts.slice(3).join('_'); // 从索引3开始拼接
        const userId = interaction.user.id;

        // 获取募选和报名信息
        const election = await ElectionData.getById(electionId);
        const registration = await RegistrationData.getByUserAndElection(userId, electionId);

        if (!election || !registration || registration.status !== 'active') {
            const errorEmbed = createErrorEmbed('数据不存在', '募选或报名信息不存在');
            return await interaction.editReply({ embeds: [errorEmbed] });
        }

        // 检查是否还在报名期间
        const now = new Date();
        const regEndTime = new Date(election.schedule.registrationEndTime);

        if (now > regEndTime) {
            const errorEmbed = createErrorEmbed('报名已结束', '报名时间已结束，无法编辑报名信息');
            return await interaction.editReply({ embeds: [errorEmbed] });
        }

        // 重新开始报名流程
        await startRegistrationFlow(interaction, election, userId, registration.userDisplayName);

    } catch (error) {
        console.error('处理编辑报名时出错:', error);
        const errorEmbed = createErrorEmbed('系统错误', '处理编辑时发生错误，请稍后重试');
        
        if (interaction.deferred) {
            await interaction.editReply({ embeds: [errorEmbed] });
        } else {
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }
    }
}

/**
 * 处理撤回报名按钮
 */
async function handleWithdrawRegistration(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });

        // 修复募选ID提取：election_withdraw_registration_election_1749951053733_0pb907
        const customIdParts = interaction.customId.split('_');
        const electionId = customIdParts.slice(3).join('_'); // 从索引3开始拼接
        const userId = interaction.user.id;

        // 获取报名信息
        const registration = await RegistrationData.getByUserAndElection(userId, electionId);
        if (!registration) {
            const errorEmbed = createErrorEmbed('报名不存在', '未找到你的报名信息');
            return await interaction.editReply({ embeds: [errorEmbed] });
        }

        // 撤回报名
        const regId = `reg_${electionId}_${userId}`;
        await RegistrationData.withdraw(regId);

        const successEmbed = createSuccessEmbed('报名已撤回', '你的报名已成功撤回，如需重新报名请点击报名按钮');
        await interaction.editReply({ embeds: [successEmbed] });

    } catch (error) {
        console.error('处理撤回报名时出错:', error);
        const errorEmbed = createErrorEmbed('系统错误', '处理撤回时发生错误，请稍后重试');
        
        if (interaction.deferred) {
            await interaction.editReply({ embeds: [errorEmbed] });
        } else {
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }
    }
}

module.exports = {
    handleRegistrationButton,
    handleFirstChoiceSelection,
    handleSecondChoiceSelection,
    handleIntroductionModal,
    handleEditRegistration,
    handleWithdrawRegistration
}; 