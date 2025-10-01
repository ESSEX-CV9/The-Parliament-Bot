// src/modules/selfRole/services/approvalService.js

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
// 引入“被拒后冷却期”设置函数
const { getSelfRoleApplication, saveSelfRoleApplication, deleteSelfRoleApplication, getSelfRoleSettings, setSelfRoleCooldown } = require('../../../core/utils/database');

/**
 * 处理审核投票按钮的交互
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function processApprovalVote(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guild.id;
    const member = interaction.member;
    const messageId = interaction.message.id;
    const [action, roleId, applicantId] = interaction.customId.replace('self_role_', '').split('_');

    const settings = await getSelfRoleSettings(guildId);
    const roleConfig = settings.roles.find(r => r.roleId === roleId);
    if (!roleConfig || !roleConfig.conditions.approval) {
        interaction.editReply({ content: '❌ 找不到该申请的配置信息。' });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return;
    }

    const { allowedVoterRoles, requiredApprovals, requiredRejections } = roleConfig.conditions.approval;

    // 1. 权限检查
    if (!member.roles.cache.some(role => allowedVoterRoles.includes(role.id))) {
        interaction.editReply({ content: '❌ 您没有权限参与此投票。' });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return;
    }

    const application = await getSelfRoleApplication(messageId);
    if (!application) {
        // 如果找不到申请，可能已经被处理，直接禁用按钮并告知用户
        const disabledRow = new ActionRowBuilder().addComponents(
            ButtonBuilder.from(interaction.message.components[0].components[0]).setDisabled(true),
            ButtonBuilder.from(interaction.message.components[0].components[1]).setDisabled(true)
        );
        await interaction.message.edit({ components: [disabledRow] }).catch(() => {});
        interaction.editReply({ content: '❌ 此申请已处理完毕或已失效。' });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return;
    }
    
    // 竞态条件修复：如果申请状态不是pending，则说明已经被其他进程处理
    if (application.status !== 'pending') {
        interaction.editReply({ content: '❌ 投票正在处理中或已结束，您的操作未被记录。' });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return;
    }

    // 2. 更新投票数据
    // 移除用户在另一方的投票（如果存在）
    application.approvers = application.approvers.filter(id => id !== member.id);
    application.rejecters = application.rejecters.filter(id => id !== member.id);

    // 添加新的投票
    if (action === 'approve') {
        application.approvers.push(member.id);
    } else {
        application.rejecters.push(member.id);
    }

    await saveSelfRoleApplication(messageId, application);

    // 3. 检查阈值
    const approvalCount = application.approvers.length;
    const rejectionCount = application.rejecters.length;
    let finalStatus = 'pending';

    if (approvalCount >= requiredApprovals) {
        finalStatus = 'approved';
    } else if (rejectionCount >= requiredRejections) {
        finalStatus = 'rejected';
    }

    // 4. 更新或终结投票
    if (finalStatus !== 'pending') {
        await finalizeApplication(interaction, application, finalStatus, roleConfig);
    } else {
        await updateApprovalPanel(interaction, application, roleConfig);
        await interaction.editReply({ content: '✅ 您的投票已记录！' });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
    }
}

/**
 * 更新投票面板上的票数显示
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {object} application
 * @param {object} roleConfig
 */
async function updateApprovalPanel(interaction, application, roleConfig) {
    const originalEmbed = interaction.message.embeds[0];
    const { requiredApprovals, requiredRejections } = roleConfig.conditions.approval;

    const updatedEmbed = new EmbedBuilder(originalEmbed.data)
        .setFields(
            ...originalEmbed.fields.map(field => {
                if (field.name === '支持票数') {
                    return { ...field, value: `${application.approvers.length} / ${requiredApprovals}` };
                }
                if (field.name === '反对票数') {
                    return { ...field, value: `${application.rejecters.length} / ${requiredRejections}` };
                }
                return field;
            })
        );
    
    await interaction.message.edit({ embeds: [updatedEmbed] });
}

/**
 * 终结一个申请（批准或拒绝）
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {object} application
 * @param {string} finalStatus - 'approved' or 'rejected'
 * @param {object} roleConfig
 */
async function finalizeApplication(interaction, application, finalStatus, roleConfig) {
    // 竞态条件修复：立即更新数据库状态为 "processing" 防止重复处理
    application.status = 'processing';
    await saveSelfRoleApplication(interaction.message.id, application);

    const applicant = await interaction.guild.members.fetch(application.applicantId).catch(() => null);
    const role = await interaction.guild.roles.fetch(application.roleId);

    let finalDescription = `申请 **${roleConfig.label}** 的投票已结束。`;
    let finalColor = 0;
    let finalStatusText = '';
    let dmMessage = '';

    if (finalStatus === 'approved') {
        finalColor = 0x57F287; // Green
        finalStatusText = '✅ 已批准';
        dmMessage = `🎉 恭喜！您申请的身份组 **${roleConfig.label}** 已通过社区审核。`;
        if (applicant) {
            try {
                await applicant.roles.add(role.id);
                finalDescription += `\n\n用户 <@${applicant.id}> 已被授予 **${role.name}** 身份组。`;
            } catch (error) {
                console.error(`[SelfRole] ❌ 授予身份组时出错: ${error}`);
                finalDescription += `\n\n⚠️ 授予身份组时出错，请检查机器人权限。`;
                dmMessage += `\n\n但机器人授予身份组时失败，请联系管理员。`;
            }
        } else {
            finalDescription += `\n\n⚠️ 无法找到申请人，未能授予身份组。`;
        }
    } else { // rejected
        finalColor = 0xED4245; // Red
        finalStatusText = '❌ 已拒绝';
        dmMessage = `很遗憾，您申请的身份组 **${roleConfig.label}** 未能通过社区审核。`;
        finalDescription += `\n\n用户 <@${applicant?.id || application.applicantId}> 的申请已被拒绝。`;

        // 被拒绝后冷却期逻辑（仅当配置了 cooldownDays 时生效）
        try {
            const cooldownDays = roleConfig?.conditions?.approval?.cooldownDays;
            if (typeof cooldownDays === 'number' && cooldownDays > 0) {
                // 写入“被拒后冷却期”记录，单位为天（内部转换为过期时间戳）
                await setSelfRoleCooldown(interaction.guild.id, application.roleId, application.applicantId, cooldownDays);
                console.log(`[SelfRole] 🧊 已为用户 ${application.applicantId} 设置身份组 ${application.roleId} 的被拒后冷却期: ${cooldownDays} 天`);
                dmMessage += `\n\n提示：您已进入 **${cooldownDays}** 天冷却期，期间无法再次申请此身份组。`;
            }
        } catch (err) {
            console.error('[SelfRole] ❌ 设置被拒后冷却期时出错:', err);
        }
    }

    // 尝试给用户发送私信通知
    if (applicant) {
        await applicant.send(dmMessage).catch(err => {
            console.error(`[SelfRole] ❌ 无法向 ${applicant.user.tag} 发送私信: ${err}`);
        });
    }

    // 获取投票人列表
    const approversList = await getVoterList(interaction.guild, application.approvers);
    const rejectersList = await getVoterList(interaction.guild, application.rejecters);

    const originalEmbed = interaction.message.embeds[0];
    const finalEmbed = new EmbedBuilder(originalEmbed.data)
        .setColor(finalColor)
        .setDescription(finalDescription)
        .setFields(
            originalEmbed.fields.find(f => f.name === '申请人'),
            originalEmbed.fields.find(f => f.name === '申请身份组'),
            { name: '状态', value: finalStatusText, inline: true },
            { name: '✅ 支持者', value: approversList || '无', inline: false },
            { name: '❌ 反对者', value: rejectersList || '无', inline: false }
        );

    // 禁用按钮
    const disabledRow = new ActionRowBuilder().addComponents(
        ButtonBuilder.from(interaction.message.components[0].components[0]).setDisabled(true),
        ButtonBuilder.from(interaction.message.components[0].components[1]).setDisabled(true)
    );

    await interaction.message.edit({ embeds: [finalEmbed], components: [disabledRow] });
    
    await interaction.editReply({ content: `✅ 投票已结束，申请已处理。` });
    setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
    console.log(`[SelfRole] 🗳️ 申请 ${interaction.message.id} 已终结，状态: ${finalStatus}`);

    // 在所有交互完成后再删除数据库记录
    await deleteSelfRoleApplication(interaction.message.id);
}

/**
 * 获取投票人列表字符串
 * @param {import('discord.js').Guild} guild
 * @param {string[]} userIds
 * @returns {Promise<string>}
 */
async function getVoterList(guild, userIds) {
    if (!userIds || userIds.length === 0) return null;
    const members = await Promise.all(userIds.map(id => guild.members.fetch(id).catch(() => ({ user: { tag: `未知用户 (${id})` } }))));
    return members.map(m => `${m.user.tag} (\`${m.id}\`)`).join('\n');
}

module.exports = {
    processApprovalVote,
};