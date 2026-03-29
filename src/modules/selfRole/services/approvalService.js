// src/modules/selfRole/services/approvalService.js

const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');

// 引入“被拒后冷却期”设置函数
const {
    getSelfRoleApplication,
    saveSelfRoleApplication,
    deleteSelfRoleApplication,
    getSelfRoleSettings,
    setSelfRoleCooldown,
    getSelfRoleApplicationV2ByReviewMessageId,
    resolveSelfRoleApplicationV2,
    createSelfRoleGrant,
} = require('../../../core/utils/database');

const { scheduleActiveUserSelfRolePanelsRefresh } = require('./panelService');
const { reportSelfRoleAlertOnce } = require('./alertReporter');

/**
 * 处理审核投票按钮的交互（支持/反对无理由）
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function processApprovalVote(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
        const [action, roleId, applicantId] = interaction.customId.replace('self_role_', '').split('_');
        await applyVote({
            interaction,
            action,
            roleId,
            applicantId,
            voteMessage: interaction.message,
            rejectReason: null,
        });
    } catch (error) {
        console.error('[SelfRole] ❌ 处理审核投票按钮时出错:', error);
        await interaction.editReply({ content: '❌ 处理投票时发生错误，请稍后重试。' });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
    }
}

/**
 * 处理“反对并说明”按钮：弹出可选理由模态框
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function showRejectReasonModal(interaction) {
    try {
        const payload = interaction.customId.replace('self_role_reason_reject_', '');
        const [roleId, applicantId] = payload.split('_');

        if (!roleId || !applicantId) {
            await interaction.reply({ content: '❌ 无法解析投票信息，请重试。', ephemeral: true });
            setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
            return;
        }

        const modal = new ModalBuilder()
            .setCustomId(`self_role_reason_reject_modal_${roleId}_${applicantId}_${interaction.message.id}`)
            .setTitle('填写反对理由（可选）');

        const reasonInput = new TextInputBuilder()
            .setCustomId('reject_reason')
            .setLabel('反对理由（可选）')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('可选：简要说明反对原因，便于申请人理解改进方向。')
            .setRequired(false)
            .setMaxLength(300);

        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
        await interaction.showModal(modal);
    } catch (error) {
        console.error('[SelfRole] ❌ 打开“反对并说明”模态窗口时出错:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '❌ 无法打开理由填写窗口，请稍后重试。', ephemeral: true }).catch(() => {});
            setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        }
    }
}

/**
 * 处理“反对并说明”模态提交
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
async function processRejectReasonModalSubmit(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
        const payload = interaction.customId.replace('self_role_reason_reject_modal_', '');
        const [roleId, applicantId, messageId] = payload.split('_');

        if (!roleId || !applicantId || !messageId) {
            await interaction.editReply({ content: '❌ 无法解析投票信息，请重试。' });
            setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
            return;
        }

        if (!interaction.channel || !interaction.channel.isTextBased()) {
            await interaction.editReply({ content: '❌ 无法定位投票消息所在频道。' });
            setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
            return;
        }

        const voteMessage = await interaction.channel.messages.fetch(messageId).catch(() => null);
        if (!voteMessage) {
            await interaction.editReply({ content: '❌ 找不到对应投票面板，可能已结束。' });
            setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
            return;
        }

        const rawReason = interaction.fields.getTextInputValue('reject_reason') || '';
        const rejectReason = sanitizeRejectReason(rawReason);

        await applyVote({
            interaction,
            action: 'reject',
            roleId,
            applicantId,
            voteMessage,
            rejectReason,
        });
    } catch (error) {
        console.error('[SelfRole] ❌ 处理“反对并说明”提交时出错:', error);
        await interaction.editReply({ content: '❌ 处理投票时发生错误，请稍后重试。' });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
    }
}

/**
 * 统一处理投票写入逻辑（支持/反对）
 * @param {object} params
 * @param {import('discord.js').ButtonInteraction|import('discord.js').ModalSubmitInteraction} params.interaction
 * @param {'approve'|'reject'} params.action
 * @param {string} params.roleId
 * @param {string} params.applicantId
 * @param {import('discord.js').Message} params.voteMessage
 * @param {string|null} params.rejectReason
 */
async function applyVote({ interaction, action, roleId, applicantId, voteMessage, rejectReason }) {
    const guildId = interaction.guild.id;
    const member = interaction.member;
    const messageId = voteMessage.id;

    // v2 申请状态校验：若已过期/撤回/结算，直接禁用面板并拒绝投票
    try {
        const v2 = await getSelfRoleApplicationV2ByReviewMessageId(messageId);
        if (v2) {
            const now = Date.now();
            const isExpired = v2.status === 'pending' && v2.reservedUntil && v2.reservedUntil <= now;

            if (isExpired) {
                await resolveSelfRoleApplicationV2(v2.applicationId, 'expired', 'expired', now).catch(() => {});
                await deleteSelfRoleApplication(messageId).catch(() => {});
                await markVoteMessageInactive(voteMessage, '⌛ 已过期', '⌛ 该申请已过期，名额已自动释放。');
                scheduleActiveUserSelfRolePanelsRefresh(interaction.client, guildId, 'application_expired');

                await interaction.editReply({ content: '❌ 此申请已过期，无法继续投票。' });
                setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
                return;
            }

            if (v2.status !== 'pending') {
                await deleteSelfRoleApplication(messageId).catch(() => {});
                await markVoteMessageInactive(voteMessage, '已结束', '该申请已结束或已失效，无法继续投票。');

                await interaction.editReply({ content: '❌ 此申请已结束或已失效，无法继续投票。' });
                setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
                return;
            }
        }
    } catch (_) {
        // 忽略 v2 校验失败，回退到 legacy 逻辑
    }

    const settings = await getSelfRoleSettings(guildId);
    const roleConfig = settings?.roles?.find(r => r.roleId === roleId);

    if (action !== 'approve' && action !== 'reject') {
        await interaction.editReply({ content: '❌ 未识别的投票操作。' });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return;
    }

    if (!roleConfig || !roleConfig.conditions?.approval) {
        await interaction.editReply({ content: '❌ 找不到该申请的配置信息。' });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return;
    }

    const { allowedVoterRoles, requiredApprovals, requiredRejections } = roleConfig.conditions.approval;

    // 1. 权限检查
    if (!Array.isArray(allowedVoterRoles) || !member.roles.cache.some(role => allowedVoterRoles.includes(role.id))) {
        await interaction.editReply({ content: '❌ 您没有权限参与此投票。' });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return;
    }

    const application = await getSelfRoleApplication(messageId);
    if (!application) {
        // 如果找不到申请，可能已经被处理，直接禁用按钮并告知用户
        const disabledRows = buildDisabledRows(voteMessage);
        if (disabledRows.length > 0) {
            await voteMessage.edit({ components: disabledRows }).catch(() => {});
        }

        await interaction.editReply({ content: '❌ 此申请已处理完毕或已失效。' });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return;
    }

    // 额外校验：防止自定义ID与数据库记录不一致
    if (application.roleId !== roleId || application.applicantId !== applicantId) {
        await interaction.editReply({ content: '❌ 投票面板数据不一致，此次操作未被记录。' });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return;
    }

    // 竞态条件修复：如果申请状态不是 pending，则说明已经被其他进程处理
    if (application.status !== 'pending') {
        await interaction.editReply({ content: '❌ 投票正在处理中或已结束，您的操作未被记录。' });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return;
    }

    // 2. 更新投票数据
    // 移除用户在另一方的投票（如果存在）
    application.approvers = (application.approvers || []).filter(id => id !== member.id);
    application.rejecters = (application.rejecters || []).filter(id => id !== member.id);

    // 反对理由 map（按投票人 userId 存储）
    if (!application.rejectReasons || typeof application.rejectReasons !== 'object' || Array.isArray(application.rejectReasons)) {
        application.rejectReasons = {};
    }

    // 添加新的投票
    if (action === 'approve') {
        application.approvers.push(member.id);
        // 若改票为支持，则清理其旧反对理由
        delete application.rejectReasons[member.id];
    } else {
        application.rejecters.push(member.id);
        if (rejectReason && rejectReason.length > 0) {
            application.rejectReasons[member.id] = {
                reason: rejectReason,
                updatedAt: new Date().toISOString(),
            };
        } else {
            // 可选理由：未填写则移除旧理由（若存在）
            delete application.rejectReasons[member.id];
        }
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
        await finalizeApplication(interaction, voteMessage, application, finalStatus, roleConfig);
    } else {
        await updateApprovalPanel(voteMessage, application, roleConfig);

        const message = action === 'approve'
            ? '✅ 您的支持票已记录！'
            : (rejectReason && rejectReason.length > 0 ? '✅ 您的反对票与理由已记录！' : '✅ 您的反对票已记录！');

        await interaction.editReply({ content: message });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
    }
}

/**
 * 更新投票面板上的票数显示
 * @param {import('discord.js').Message} voteMessage
 * @param {object} application
 * @param {object} roleConfig
 */
async function updateApprovalPanel(voteMessage, application, roleConfig) {
    const originalEmbed = voteMessage.embeds[0];
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

    await voteMessage.edit({ embeds: [updatedEmbed] });
}

/**
 * 渲染申请结果私信模板
 * @param {string} template
 * @param {Record<string, string|number>} variables
 * @returns {string}
 */
function renderDmTemplate(template, variables = {}) {
    if (!template || typeof template !== 'string') return '';

    let rendered = template;
    for (const [key, value] of Object.entries(variables)) {
        const token = `{${key}}`;
        rendered = rendered.split(token).join(value == null ? '' : String(value));
    }
    return rendered;
}

/**
 * 获取默认审核结果私信模板
 * @param {'approved'|'rejected'} status
 * @returns {string}
 */
function getDefaultDmTemplate(status) {
    if (status === 'approved') {
        return '🎉 恭喜！您申请的身份组 **{roleLabel}** 已通过社区审核。';
    }
    return '很遗憾，您申请的身份组 **{roleLabel}** 未能通过社区审核。';
}

/**
 * 终结一个申请（批准或拒绝）
 * @param {import('discord.js').ButtonInteraction|import('discord.js').ModalSubmitInteraction} interaction
 * @param {import('discord.js').Message} voteMessage
 * @param {object} application
 * @param {string} finalStatus - 'approved' or 'rejected'
 * @param {object} roleConfig
 */
async function finalizeApplication(interaction, voteMessage, application, finalStatus, roleConfig) {
    // 竞态条件修复：立即更新数据库状态为 "processing" 防止重复处理
    application.status = 'processing';
    await saveSelfRoleApplication(voteMessage.id, application);

    const applicant = await interaction.guild.members.fetch(application.applicantId).catch(() => null);
    const role = await interaction.guild.roles.fetch(application.roleId).catch(() => null);

    const approvalConfig = roleConfig?.conditions?.approval || {};
    const dmTemplates = approvalConfig.dmTemplates || {};
    const cooldownDaysValue = typeof approvalConfig.cooldownDays === 'number' && approvalConfig.cooldownDays > 0
        ? approvalConfig.cooldownDays
        : null;
    const cooldownNotice = cooldownDaysValue
        ? `提示：您已进入 **${cooldownDaysValue}** 天冷却期，期间无法再次申请此身份组。`
        : '';
    const dmVariables = {
        roleLabel: roleConfig.label,
        roleName: role?.name || roleConfig.label || '',
        applicantMention: applicant ? `<@${applicant.id}>` : `<@${application.applicantId}>`,
        cooldownDays: cooldownDaysValue ?? '',
        cooldownNotice,
    };

    let finalDescription = `申请 **${roleConfig.label}** 的投票已结束。`;
    let finalColor = 0;
    let finalStatusText = '';
    let dmMessage = '';
    // 发送给申请人的匿名拒绝理由
    let applicantRejectReasonChunks = [];

    if (finalStatus === 'approved') {
        finalColor = 0x57F287; // Green
        finalStatusText = '✅ 已批准';
        dmMessage = renderDmTemplate(
            dmTemplates.approved || getDefaultDmTemplate('approved'),
            dmVariables,
        );
        if (applicant && role) {
            try {
                const bundleRoleIds = Array.isArray(roleConfig.bundleRoleIds) ? roleConfig.bundleRoleIds : [];
                const roleIdsToAdd = [...new Set([role.id, ...bundleRoleIds])];
                await applicant.roles.add(roleIdsToAdd);

                const bundleSuffix = bundleRoleIds.length > 0 ? '（含配套身份组）' : '';
                finalDescription += `\n\n用户 <@${applicant.id}> 已被授予 **${role.name}** 身份组${bundleSuffix}。`;
                if (bundleRoleIds.length > 0) {
                    finalDescription += `\n配套身份组：${bundleRoleIds.map(rid => `<@&${rid}>`).join(' ')}`;
                }

                try {
                    const v2 = await getSelfRoleApplicationV2ByReviewMessageId(voteMessage.id);
                    await createSelfRoleGrant({
                        guildId: interaction.guild.id,
                        userId: applicant.id,
                        primaryRoleId: role.id,
                        applicationId: v2?.applicationId || null,
                        grantedAt: Date.now(),
                        bundleRoleIds,
                    });
                } catch (dbErr) {
                    console.error('[SelfRole] ❌ 写入 grant 记录失败（审核通过）:', dbErr);
                }
            } catch (error) {
                console.error(`[SelfRole] ❌ 授予身份组时出错: ${error}`);
                finalDescription += `\n\n⚠️ 授予身份组时出错，请检查机器人权限。`;
                dmMessage += `\n\n但机器人授予身份组时失败，请联系管理员。`;
            }
        } else {
            finalDescription += `\n\n⚠️ 无法找到申请人或身份组，未能授予身份组。`;
        }
    } else {
        finalColor = 0xED4245; // Red
        finalStatusText = '❌ 已拒绝';
        const rejectedTemplate = dmTemplates.rejected || getDefaultDmTemplate('rejected');
        const usesCooldownPlaceholder = rejectedTemplate.includes('{cooldownDays}') || rejectedTemplate.includes('{cooldownNotice}');
        dmMessage = renderDmTemplate(rejectedTemplate, dmVariables);
        finalDescription += `\n\n用户 <@${applicant?.id || application.applicantId}> 的申请已被拒绝。`;

        // 将“匿名拒绝理由”同步给申请人（不包含投票人身份，不做截断）
        applicantRejectReasonChunks = formatRejectReasonsForApplicantDMChunks(application.rejectReasons);
        if (applicantRejectReasonChunks.length > 0) {
            dmMessage += `\n\n以下是审核时提交的匿名拒绝理由：\n${applicantRejectReasonChunks[0]}`;
        }

        // 被拒绝后冷却期逻辑（仅当配置了 cooldownDays 时生效）
        try {
            if (cooldownDaysValue) {
                // 写入“被拒后冷却期”记录，单位为天（内部转换为过期时间戳）
                await setSelfRoleCooldown(interaction.guild.id, application.roleId, application.applicantId, cooldownDaysValue);
                console.log(`[SelfRole] 🧊 已为用户 ${application.applicantId} 设置身份组 ${application.roleId} 的被拒后冷却期: ${cooldownDaysValue} 天`);
                if (cooldownNotice && !usesCooldownPlaceholder) {
                    dmMessage += `\n\n${cooldownNotice}`;
                }
            }
        } catch (err) {
            console.error('[SelfRole] ❌ 设置被拒后冷却期时出错:', err);
        }
    }

    // 尝试给用户发送私信通知
    if (applicant) {
        let dmOk = true;
        try {
            await applicant.send(dmMessage);
        } catch (err) {
            dmOk = false;
            console.error(`[SelfRole] ❌ 无法向 ${applicant.user.tag} 发送私信: ${err}`);

            const v2 = await getSelfRoleApplicationV2ByReviewMessageId(voteMessage.id).catch(() => null);
            const appIdForAlert = v2?.applicationId || voteMessage.id;

            const reportChannelId = voteMessage.channel?.id;
            if (reportChannelId) {
                await reportSelfRoleAlertOnce({
                    client: interaction.client,
                    guildId: interaction.guild.id,
                    channelId: reportChannelId,
                    roleId: application.roleId,
                    grantId: null,
                    applicationId: appIdForAlert,
                    alertType: 'application_result_dm_failed',
                    severity: 'medium',
                    title: '⚠️ 审核结果通知失败：无法发送私信',
                    message: `无法向申请人 ${application.applicantId} 发送私信通知审核结果（${finalStatus}）。`,
                    actionRequired: `请管理员在服务器内手动告知申请人审核结果，并提醒其开启私信（允许接收来自服务器成员的私信）。\n\n申请人：<@${application.applicantId}>\n身份组：<@&${application.roleId}>`,
                }).catch(() => {});
            }
        }

        // 若拒绝理由较多，继续分条发送剩余内容（匿名）
        if (dmOk && finalStatus === 'rejected' && applicantRejectReasonChunks.length > 1) {
            for (const chunk of applicantRejectReasonChunks.slice(1)) {
                await applicant.send(`匿名拒绝理由（续）：\n${chunk}`).catch(err => {
                    console.error(`[SelfRole] ❌ 向 ${applicant.user.tag} 发送追加匿名拒绝理由失败: ${err}`);
                });
            }
        }
    }

    // 获取投票人列表
    const approversList = await getVoterList(interaction.guild, application.approvers);
    const rejectersList = await getVoterList(interaction.guild, application.rejecters);

    const originalEmbed = voteMessage.embeds[0];
    const applicantField = originalEmbed.fields.find(f => f.name === '申请人') || { name: '申请人', value: `<@${application.applicantId}>`, inline: true };
    const roleField = originalEmbed.fields.find(f => f.name === '申请身份组') || { name: '申请身份组', value: `<@&${application.roleId}>`, inline: true };

    const finalFields = [
        applicantField,
        roleField,
        { name: '状态', value: finalStatusText, inline: true },
        { name: '✅ 支持者', value: approversList || '无', inline: false },
        { name: '❌ 反对者', value: rejectersList || '无', inline: false },
    ];

    // 拒绝时附带“反对理由（可选）”摘要
    if (finalStatus === 'rejected') {
        const rejectReasonsSummary = formatRejectReasonsForEmbed(application.rejectReasons, application.rejecters);
        if (rejectReasonsSummary) {
            finalFields.push({ name: '📝 反对理由（可选）', value: rejectReasonsSummary, inline: false });
        }
    }

    const finalEmbed = new EmbedBuilder(originalEmbed.data)
        .setColor(finalColor)
        .setDescription(finalDescription)
        .setFields(...finalFields);

    const disabledRows = buildDisabledRows(voteMessage);

    await voteMessage.edit({ embeds: [finalEmbed], components: disabledRows });

    await interaction.editReply({ content: '✅ 投票已结束，申请已处理。' });
    setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
    console.log(`[SelfRole] 🗳️ 申请 ${voteMessage.id} 已终结，状态: ${finalStatus}`);

     // v2：终结申请并释放预留名额
    try {
        const v2 = await getSelfRoleApplicationV2ByReviewMessageId(voteMessage.id);
        if (v2 && v2.status === 'pending') {
            await resolveSelfRoleApplicationV2(v2.applicationId, finalStatus, finalStatus, Date.now());
        }
    } catch (err) {
        console.error('[SelfRole] ❌ 终结 v2 申请记录时出错:', err);
    }

    scheduleActiveUserSelfRolePanelsRefresh(interaction.client, interaction.guild.id, 'application_finalized');

    // 在所有交互完成后再删除数据库记录
    await deleteSelfRoleApplication(voteMessage.id);
}

/**
 * 将投票面板标记为不可用（过期/撤回/已结束等）
 * @param {import('discord.js').Message} voteMessage
 * @param {string} statusText
 * @param {string} extraDescription
 */
async function markVoteMessageInactive(voteMessage, statusText, extraDescription) {
    const disabledRows = buildDisabledRows(voteMessage);
    const originalEmbed = voteMessage.embeds?.[0];

    if (!originalEmbed) {
        await voteMessage.edit({ components: disabledRows }).catch(() => {});
        return;
    }

    const updated = new EmbedBuilder(originalEmbed.data)
        .setColor(0x747F8D)
        .setDescription(
            (() => {
                const base = (originalEmbed.description || '').trim();
                const next = base ? `${base}\n\n${extraDescription}` : extraDescription;
                return next.length > 4096 ? next.slice(0, 4093) + '…' : next;
            })(),
        )
        .setFields(
            ...originalEmbed.fields.map(field => {
                if (field.name === '状态') {
                    return { ...field, value: statusText };
                }
                return field;
            }),
        );

    await voteMessage.edit({ embeds: [updated], components: disabledRows }).catch(() => {});
}

/**
 * 构建“全部按钮禁用”的组件行
 * @param {import('discord.js').Message} message
 * @returns {ActionRowBuilder[]}
 */
function buildDisabledRows(message) {
    if (!message?.components || message.components.length === 0) {
        return [];
    }

    return message.components.map(row => {
        const disabledButtons = row.components.map(component => ButtonBuilder.from(component).setDisabled(true));
        return new ActionRowBuilder().addComponents(disabledButtons);
    });
}

/**
 * 清洗反对理由文本
 * @param {string} text
 * @returns {string}
 */
function sanitizeRejectReason(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .trim()
        .replace(/\s{2,}/g, ' ')
        .slice(0, 300);
}

/**
 * 生成“反对理由（可选）”摘要文本
 * @param {Record<string, {reason?: string, updatedAt?: string}>|undefined} rejectReasons
 * @param {string[]|undefined} rejecterIds
 * @returns {string|null}
 */
function formatRejectReasonsForEmbed(rejectReasons, rejecterIds) {
    if (!rejectReasons || typeof rejectReasons !== 'object' || Array.isArray(rejectReasons)) return null;
    if (!rejecterIds || rejecterIds.length === 0) return null;

    const lines = [];

    for (const userId of rejecterIds) {
        const item = rejectReasons[userId];
        if (!item || !item.reason) continue;

        const cleaned = String(item.reason).replace(/\s+/g, ' ').trim();
        if (!cleaned) continue;

        const shortReason = cleaned.length > 120 ? `${cleaned.slice(0, 120)}…` : cleaned;
        lines.push(`• <@${userId}>：${shortReason}`);
    }

    if (lines.length === 0) return null;

    // 控制在 Embed 字段 1024 以内
    let result = '';
    for (const line of lines) {
        if ((result + line + '\n').length > 1000) {
            result += '…';
            break;
        }
        result += `${line}\n`;
    }

    return result.trim();
}

/**
 * 生成发送给申请人的“匿名拒绝理由”分片（不包含任何投票人信息）
 * 说明：
 * - 不做内容截断
 * - 仅按 Discord 消息长度限制进行分片
 * @param {Record<string, {reason?: string, updatedAt?: string}>|undefined} rejectReasons
 * @returns {string[]}
 */
function formatRejectReasonsForApplicantDMChunks(rejectReasons) {
    if (!rejectReasons || typeof rejectReasons !== 'object' || Array.isArray(rejectReasons)) return [];

    const reasons = Object.values(rejectReasons)
        .map(item => (item && typeof item.reason === 'string' ? item.reason : ''))
        .map(text => text.replace(/\s+/g, ' ').trim())
        .filter(Boolean);

    if (reasons.length === 0) return [];

    // 去重后全部保留
    const uniqueReasons = [...new Set(reasons)];
    const lines = uniqueReasons.map(reason => `• ${reason}`);

    // 为避免 DM 超长失败，按长度分片发送
    const MAX_CHUNK_LENGTH = 1700;
    const chunks = [];
    let current = '';

    for (const line of lines) {
        const next = current.length > 0 ? `${current}\n${line}` : line;
        if (next.length > MAX_CHUNK_LENGTH) {
            if (current.length > 0) {
                chunks.push(current);
                current = line;
            } else {
                // 理论上不会发生（前端输入上限 300），保底不截断地直接入块
                chunks.push(line);
                current = '';
            }
        } else {
            current = next;
        }
    }

    if (current.length > 0) {
        chunks.push(current);
    }

    return chunks;
}

/**
 * 获取投票人列表字符串
 * @param {import('discord.js').Guild} guild
 * @param {string[]} userIds
 * @returns {Promise<string>}
 */
async function getVoterList(guild, userIds) {
    if (!userIds || userIds.length === 0) return null;
    const members = await Promise.all(userIds.map(id => guild.members.fetch(id).catch(() => ({ user: { tag: `未知用户 (${id})` }, id }))));
    return members.map(m => `${m.user.tag} (\`${m.id}\`)`).join('\n');
}

module.exports = {
    processApprovalVote,
    showRejectReasonModal,
    processRejectReasonModalSubmit,
};