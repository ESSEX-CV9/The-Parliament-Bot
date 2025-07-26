// src/modules/selfRole/services/selfRoleService.js

const { ActionRowBuilder, StringSelectMenuBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getSelfRoleSettings, getUserActivity, saveSelfRoleApplication } = require('../../../core/utils/database');

/**
 * 处理自助身份组申请按钮的点击event
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleSelfRoleButton(interaction) {
    const guildId = interaction.guild.id;
    const settings = await getSelfRoleSettings(guildId);

    if (!settings || !settings.roles || settings.roles.length === 0) {
        return interaction.reply({ content: '❌ 当前没有任何可申请的身份组。', ephemeral: true });
    }

    const memberRoles = interaction.member.roles.cache;
    const options = settings.roles
        .filter(roleConfig => !memberRoles.has(roleConfig.roleId)) // 过滤掉用户已有的身份组
        .map(roleConfig => ({
            label: roleConfig.label,
            description: roleConfig.description || `申请 ${roleConfig.label} 身份组`,
            value: roleConfig.roleId,
        }));

    if (options.length === 0) {
        return interaction.reply({ content: '✅ 您已拥有所有可申请的身份组。', ephemeral: true });
    }

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('self_role_select_menu')
        .setPlaceholder('请选择要申请的身份组...')
        .addOptions(options);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    await interaction.reply({
        content: '请从下面的菜单中选择您想申请的身份组：',
        components: [row],
        ephemeral: true,
    });
}

/**
 * 处理用户在下拉菜单中选择身份组后的提交event
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
async function handleSelfRoleSelect(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guild.id;
    const member = interaction.member;
    const selectedRoleIds = interaction.values;

    const settings = await getSelfRoleSettings(guildId);
    const userActivity = await getUserActivity(guildId);

    let results = [];

    for (const roleId of selectedRoleIds) {
        const roleConfig = settings.roles.find(r => r.roleId === roleId);
        if (!roleConfig) continue;

        const { conditions } = roleConfig;
        let canApply = true;
        let reason = '';
        let requiresApproval = false;

        // 1. 检查前置身份组
        if (conditions.prerequisiteRoleId && !member.roles.cache.has(conditions.prerequisiteRoleId)) {
            canApply = false;
            const requiredRole = await interaction.guild.roles.fetch(conditions.prerequisiteRoleId);
            reason = `需要拥有 **${requiredRole.name}** 身份组。`;
        }

        // 2. 检查活跃度
        if (canApply && conditions.activity) {
            const { channelId, requiredMessages, requiredMentions } = conditions.activity;
            const activity = userActivity[channelId]?.[member.id] || { messageCount: 0, mentionedCount: 0 };
            
            if (activity.messageCount < requiredMessages && activity.mentionedCount < requiredMentions) {
                canApply = false;
                const channel = await interaction.guild.channels.fetch(channelId);
                reason = `在 <#${channel.id}> 频道中，需要 **${requiredMessages}** 发言数 (您有 ${activity.messageCount}) 或 **${requiredMentions}** 被提及数 (您有 ${activity.mentionedCount})。`;
            }
        }

        // 如果资格预审通过，检查是否需要审核
        if (canApply && conditions.approval) {
            requiresApproval = true;
            try {
                await createApprovalPanel(interaction, roleConfig);
                results.push(`⏳ **${roleConfig.label}**: 资格审查通过，已提交社区审核。`);
            } catch (error) {
                results.push(`❌ **${roleConfig.label}**: 提交审核失败，请联系管理员。`);
            }
        }
        // 如果资格预审通过且无需审核，则直接授予
        else if (canApply) {
            try {
                await member.roles.add(roleId);
                results.push(`✅ **${roleConfig.label}**: 成功获取！`);
            } catch (error) {
                console.error(`[SelfRole] ❌ 授予身份组 ${roleConfig.label} 时出错:`, error);
                results.push(`❌ **${roleConfig.label}**: 授予失败，可能是机器人权限不足。`);
            }
        }
        // 如果资格预审不通过
        else {
            results.push(`❌ **${roleConfig.label}**: 申请失败，原因：${reason}`);
        }
    }

    await interaction.editReply({
        content: `**身份组申请结果:**\n\n${results.join('\n')}`,
    });
}

module.exports = {
    handleSelfRoleButton,
    handleSelfRoleSelect,
};

/**
 * 创建一个审核面板
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 * @param {object} roleConfig - The configuration for the role being applied for.
 */
async function createApprovalPanel(interaction, roleConfig) {
    const { approval } = roleConfig.conditions;
    const applicant = interaction.user;
    const role = await interaction.guild.roles.fetch(roleConfig.roleId);

    const approvalChannel = await interaction.client.channels.fetch(approval.channelId);
    if (!approvalChannel) {
        throw new Error(`找不到配置的审核频道: ${approval.channelId}`);
    }

    const embed = new EmbedBuilder()
        .setTitle(`📜 身份组申请审核: ${roleConfig.label}`)
        .setDescription(`用户 **${applicant.tag}** (${applicant.id}) 申请获取 **${role.name}** 身份组，已通过资格预审，现进入社区投票审核阶段。`)
        .addFields(
            { name: '申请人', value: `<@${applicant.id}>`, inline: true },
            { name: '申请身份组', value: `<@&${role.id}>`, inline: true },
            { name: '状态', value: '🗳️ 投票中...', inline: true },
            { name: '支持票数', value: `0 / ${approval.requiredApprovals}`, inline: true },
            { name: '反对票数', value: `0 / ${approval.requiredRejections}`, inline: true }
        )
        .setColor(0xFEE75C) // Yellow
        .setTimestamp();

    const approveButton = new ButtonBuilder()
        .setCustomId(`self_role_approve_${roleConfig.roleId}_${applicant.id}`)
        .setLabel('✅ 支持')
        .setStyle(ButtonStyle.Success);

    const rejectButton = new ButtonBuilder()
        .setCustomId(`self_role_reject_${roleConfig.roleId}_${applicant.id}`)
        .setLabel('❌ 反对')
        .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(approveButton, rejectButton);

    const approvalMessage = await approvalChannel.send({ embeds: [embed], components: [row] });

    // 在数据库中创建申请记录
    await saveSelfRoleApplication(approvalMessage.id, {
        applicantId: applicant.id,
        roleId: roleConfig.roleId,
        status: 'pending',
        approvers: [],
        rejecters: [],
    });

    console.log(`[SelfRole] ✅ 为 ${applicant.tag} 的 ${roleConfig.label} 申请创建了审核面板: ${approvalMessage.id}`);
}