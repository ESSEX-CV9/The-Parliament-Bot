const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const { ElectionData } = require('../data/electionDatabase');
const { CandidateManagementService } = require('../services/candidateManagementService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('编辑候选人信息')
        .setDescription('管理员编辑候选人信息和状态')
        .addUserOption(option =>
            option.setName('候选人')
                .setDescription('要编辑的候选人')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('操作类型')
                .setDescription('选择操作类型')
                .setRequired(true)
                .addChoices(
                    { name: '📊 状态管理', value: 'status_management' },
                    { name: '✏️ 信息编辑', value: 'info_edit' }
                ))
        .addStringOption(option =>
            option.setName('募选id')
                .setDescription('募选ID（可选，默认为当前活跃募选）')
                .setRequired(false)),

    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            // 权限检查
            if (!checkAdminPermission(interaction.member)) {
                const embed = new EmbedBuilder()
                    .setColor('#ff0000')
                    .setDescription(getPermissionDeniedMessage());
                return await interaction.editReply({ embeds: [embed] });
            }

            const candidate = interaction.options.getUser('候选人');
            const operationType = interaction.options.getString('操作类型');
            let electionId = interaction.options.getString('募选id');

            // 如果没有指定募选ID，获取当前活跃募选
            if (!electionId) {
                const activeElection = await ElectionData.getActiveElectionByGuild(interaction.guild.id);
                if (!activeElection) {
                    const errorEmbed = new EmbedBuilder()
                        .setTitle('❌ 错误')
                        .setDescription('当前没有活跃的募选，请指定募选ID')
                        .setColor('#e74c3c');
                    return await interaction.editReply({ embeds: [errorEmbed] });
                }
                electionId = activeElection.electionId;
            }

            // 验证募选是否存在
            const election = await ElectionData.getById(electionId);
            if (!election) {
                const errorEmbed = new EmbedBuilder()
                    .setTitle('❌ 错误')
                    .setDescription('指定的募选不存在')
                    .setColor('#e74c3c');
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            // 验证募选是否属于当前服务器
            if (election.guildId !== interaction.guild.id) {
                const errorEmbed = new EmbedBuilder()
                    .setTitle('❌ 错误')
                    .setDescription('指定的募选不属于当前服务器')
                    .setColor('#e74c3c');
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            // 获取候选人信息
            const candidateService = new CandidateManagementService(interaction.client);
            
            try {
                const candidateInfo = await candidateService.getCandidateInfo(candidate.id, electionId);
                
                if (operationType === 'status_management') {
                    await showStatusManagementMenu(interaction, candidateInfo, election);
                } else if (operationType === 'info_edit') {
                    await showInfoEditModal(interaction, candidateInfo, election);
                }

            } catch (error) {
                if (error.message === '该用户未报名此次募选') {
                    const errorEmbed = new EmbedBuilder()
                        .setTitle('❌ 操作失败')
                        .setDescription(`用户 ${candidate.tag} 未报名 **${election.name}**`)
                        .setColor('#e74c3c');
                    return await interaction.editReply({ embeds: [errorEmbed] });
                } else {
                    throw error;
                }
            }

        } catch (error) {
            console.error('编辑候选人信息时出错:', error);
            
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
};

/**
 * 显示状态管理菜单
 */
async function showStatusManagementMenu(interaction, candidateInfo, election) {
    const { registration } = candidateInfo;
    
    // 根据当前状态显示可用操作
    const options = [];
    
    if (registration.status === 'rejected') {
        options.push({
            label: '✅ 激活候选人',
            value: 'activate',
            description: '将打回状态改为正常参选',
            emoji: '✅'
        });
        options.push({
            label: '❌ 撤销资格',
            value: 'revoke',
            description: '永久撤销参选资格（不可申诉）',
            emoji: '❌'
        });
        options.push({
            label: '🔄 标记申诉恢复',
            value: 'mark_appealed',
            description: '标记为申诉后恢复状态',
            emoji: '🔄'
        });
    } else if (registration.status === 'revoked') {
        options.push({
            label: '✅ 激活候选人',
            value: 'activate',
            description: '恢复参选资格',
            emoji: '✅'
        });
        options.push({
            label: '🔄 标记申诉恢复',
            value: 'mark_appealed',
            description: '标记为申诉后恢复状态',
            emoji: '🔄'
        });
    } else if (registration.status === 'active') {
        options.push({
            label: '⚠️ 打回报名',
            value: 'reject',
            description: '打回报名（候选人可申诉）',
            emoji: '⚠️'
        });
        options.push({
            label: '❌ 撤销资格',
            value: 'revoke',
            description: '永久撤销参选资格（不可申诉）',
            emoji: '❌'
        });
        
        if (!registration.isAppealed) {
            options.push({
                label: '🔄 标记申诉恢复',
                value: 'mark_appealed',
                description: '标记为申诉后恢复状态',
                emoji: '🔄'
            });
        } else {
            options.push({
                label: '📝 取消申诉标记',
                value: 'unmark_appealed',
                description: '取消申诉恢复标记',
                emoji: '📝'
            });
        }
    } else if (registration.status === 'withdrawn') {
        options.push({
            label: '✅ 激活候选人',
            value: 'activate',
            description: '恢复参选资格',
            emoji: '✅'
        });
    }

    if (options.length === 0) {
        const errorEmbed = new EmbedBuilder()
            .setTitle('❌ 无可用操作')
            .setDescription(`候选人当前状态 \`${registration.status}\` 无可用的状态操作`)
            .setColor('#e74c3c');
        return await interaction.editReply({ embeds: [errorEmbed] });
    }

    const statusMap = {
        'active': registration.isAppealed ? '🔄 恢复参选' : '✅ 正常参选',
        'rejected': '⚠️ 已打回',
        'revoked': '❌ 已撤销',
        'withdrawn': '🚫 已撤回'
    };

    const embed = new EmbedBuilder()
        .setTitle('📊 候选人状态管理')
        .setDescription(`管理候选人 ${candidateInfo.registration.userDisplayName} 的状态`)
        .setColor('#3498db')
        .addFields(
            { name: '候选人', value: `<@${registration.userId}>`, inline: true },
            { name: '当前状态', value: statusMap[registration.status] || registration.status, inline: true },
            { name: '募选', value: election.name, inline: true }
        );

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`admin_status_change_${election.electionId}_${registration.userId}`)
        .setPlaceholder('选择要执行的状态操作')
        .addOptions(options);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    await interaction.editReply({ embeds: [embed], components: [row] });
}

/**
 * 显示信息编辑模态框
 */
async function showInfoEditModal(interaction, candidateInfo, election) {
    const { registration } = candidateInfo;
    
    const modal = new ModalBuilder()
        .setCustomId(`admin_edit_info_${election.electionId}_${registration.userId}`)
        .setTitle('编辑候选人信息');

    // 显示名称
    const displayNameInput = new TextInputBuilder()
        .setCustomId('display_name')
        .setLabel('显示名称')
        .setStyle(TextInputStyle.Short)
        .setValue(registration.userDisplayName || '')
        .setRequired(true)
        .setMaxLength(32);

    // 第一志愿
    const firstChoiceInput = new TextInputBuilder()
        .setCustomId('first_choice')
        .setLabel('第一志愿职位ID')
        .setStyle(TextInputStyle.Short)
        .setValue(registration.firstChoicePosition || '')
        .setRequired(true)
        .setPlaceholder('输入职位ID');

    // 第二志愿
    const secondChoiceInput = new TextInputBuilder()
        .setCustomId('second_choice')
        .setLabel('第二志愿职位ID（可选）')
        .setStyle(TextInputStyle.Short)
        .setValue(registration.secondChoicePosition || '')
        .setRequired(false)
        .setPlaceholder('输入职位ID或留空');

    // 自我介绍
    const introductionInput = new TextInputBuilder()
        .setCustomId('self_introduction')
        .setLabel('自我介绍')
        .setStyle(TextInputStyle.Paragraph)
        .setValue(registration.selfIntroduction || '')
        .setRequired(false)
        .setMaxLength(2000)
        .setPlaceholder('候选人的自我介绍...');

    const row1 = new ActionRowBuilder().addComponents(displayNameInput);
    const row2 = new ActionRowBuilder().addComponents(firstChoiceInput);
    const row3 = new ActionRowBuilder().addComponents(secondChoiceInput);
    const row4 = new ActionRowBuilder().addComponents(introductionInput);

    modal.addComponents(row1, row2, row3, row4);

    await interaction.showModal(modal);
} 