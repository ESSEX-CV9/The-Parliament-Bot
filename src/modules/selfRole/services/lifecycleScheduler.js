// src/modules/selfRole/services/lifecycleScheduler.js

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
} = require('discord.js');

const { getCheckIntervals } = require('../../../core/config/timeconfig');

const {
    getAllSelfRoleSettings,
    listAllActiveSelfRoleGrants,
    listSelfRoleGrantRoles,
    updateSelfRoleGrantSchedule,
    updateSelfRoleGrantInquiry,
    updateSelfRoleGrantLastDecision,
    endSelfRoleGrant,
    createSelfRoleRenewalSession,
    getSelfRoleRenewalSession,
    getPendingSelfRoleRenewalSessionByGrant,
    updateSelfRoleRenewalSession,
    getSelfRoleGrant,
    countActiveSelfRoleGrantHoldersByRole,
    countReservedPendingSelfRoleApplicationsV2,
    setSelfRoleGrantManualAttentionRequired,
} = require('../../../core/utils/database');

const { scheduleActiveUserSelfRolePanelsRefresh } = require('./panelService');
const { reportSelfRoleAlertOnce } = require('./alertReporter');

const DAY_MS = 24 * 60 * 60 * 1000;

let lifecycleInterval = null;
let lifecycleRunning = false;

function formatDateTime(ts) {
    try {
        return new Date(ts).toLocaleString('zh-CN', { hour12: false });
    } catch (_) {
        return String(ts);
    }
}

function buildDisabledRows(message) {
    if (!message?.components || message.components.length === 0) return [];

    return message.components.map(row => {
        const disabled = row.components.map(component => {
            try {
                return ButtonBuilder.from(component).setDisabled(true);
            } catch (_) {
                return component;
            }
        });
        return new ActionRowBuilder().addComponents(disabled);
    });
}

async function sendReportMessage(client, reportChannelId, content) {
    if (!reportChannelId) return null;
    const ch = await client.channels.fetch(reportChannelId).catch(err => {
        console.warn(`[SelfRole][Lifecycle] ⚠️ 获取报告频道失败: channel=${reportChannelId}`, err);
        return null;
    });
    if (!ch || !ch.isTextBased()) {
        console.warn(`[SelfRole][Lifecycle] ⚠️ 报告频道不可用或非文本频道: channel=${reportChannelId}`);
        return null;
    }
    return ch
        .send({ content, allowedMentions: { parse: [] } })
        .catch(err => {
            console.warn(`[SelfRole][Lifecycle] ⚠️ 发送报告消息失败: channel=${reportChannelId}`, err);
            return null;
        });
}

async function isRoleFull(client, guildId, roleConfig) {
    const maxMembers = roleConfig?.conditions?.capacity?.maxMembers;
    const hasLimit = typeof maxMembers === 'number' && maxMembers > 0;

    if (!hasLimit) {
        // 未配置人数上限时，onlyWhenFull 无法可靠判断，这里直接视为“可执行”。
        return true;
    }

    const holders = await countActiveSelfRoleGrantHoldersByRole(guildId, roleConfig.roleId);
    const pendingReserved = await countReservedPendingSelfRoleApplicationsV2(guildId, roleConfig.roleId, Date.now());

    return holders + pendingReserved >= maxMembers;
}

function computeNextInquiryAt(now, inquiryDays, forceRemoveAt) {
    if (!inquiryDays || inquiryDays <= 0) return null;
    const next = now + inquiryDays * DAY_MS;
    if (forceRemoveAt != null && next > forceRemoveAt) return null;
    return next;
}

async function ensureGrantSchedule(grant, roleConfig) {
    const lc = roleConfig?.lifecycle || {};
    const inquiryDays = Number(lc.inquiryDays || 0);
    const forceRemoveDays = Number(lc.forceRemoveDays || 0);

    let nextInquiryAt = grant.nextInquiryAt;
    let forceRemoveAt = grant.forceRemoveAt;
    let changed = false;

    // nextInquiryAt === null has two meanings in persisted rows:
    // 1) first-cycle grants created before schedule initialization;
    // 2) intentionally no further inquiry before forceRemoveAt.
    // Only initialize the first cycle when no inquiry has ever been sent.
    if (nextInquiryAt == null && inquiryDays > 0 && grant.lastInquiryAt == null) {
        nextInquiryAt = grant.grantedAt + inquiryDays * DAY_MS;
        changed = true;
    }

    if (forceRemoveAt == null && forceRemoveDays > 0) {
        forceRemoveAt = grant.grantedAt + forceRemoveDays * DAY_MS;
        changed = true;
    }

    if (forceRemoveAt != null && nextInquiryAt != null && nextInquiryAt > forceRemoveAt) {
        nextInquiryAt = null;
        changed = true;
    }

    if (changed) {
        await updateSelfRoleGrantSchedule(grant.grantId, { nextInquiryAt, forceRemoveAt }).catch(() => {});
    }

    return { nextInquiryAt, forceRemoveAt, inquiryDays, forceRemoveDays };
}

async function processInquiry(client, grant, roleConfig, scheduleInfo) {
    const lc = roleConfig.lifecycle || {};
    const reportChannelId = lc.reportChannelId || null;

    const existingSession = await getPendingSelfRoleRenewalSessionByGrant(grant.grantId);
    if (existingSession) {
        return;
    }

    const now = Date.now();
    const delayedNotice = lc.onlyWhenFull ? '（仅在满员时执行：如曾长期未满员，本次可能为延后触发）' : '';

    const reportMsg = await sendReportMessage(
        client,
        reportChannelId,
        `📩 准备向 <@${grant.userId}> 发送留任/退出询问：<@&${grant.primaryRoleId}> ${delayedNotice}`,
    );

    const session = await createSelfRoleRenewalSession({
        grantId: grant.grantId,
        status: 'pending',
        dmMessageId: null,
        askedAt: now,
        reportMessageId: reportMsg?.id || null,
        requiresAdminFollowup: false,
    });

    const embed = new EmbedBuilder()
        .setTitle(`⏳ 留任确认：${roleConfig.label}`)
        .setColor(0x5865F2)
        .setDescription(
            `你当前拥有身份组 <@&${grant.primaryRoleId}>。\n\n` +
            `请选择：\n` +
            `- **留任**：继续保留该身份组\n` +
            `- **退出**：主动退出该身份组\n\n` +
            `授予时间：${formatDateTime(grant.grantedAt)}${delayedNotice ? `\n${delayedNotice}` : ''}`,
        )
        .setTimestamp();

    if (scheduleInfo.forceRemoveAt) {
        embed.addFields({
            name: '强制清退时间',
            value: formatDateTime(scheduleInfo.forceRemoveAt),
            inline: false,
        });
    }

    const keepBtn = new ButtonBuilder()
        .setCustomId(`sr5_renew_keep_${session.sessionId}`)
        .setLabel('✅ 留任')
        .setStyle(ButtonStyle.Success);

    const leaveBtn = new ButtonBuilder()
        .setCustomId(`sr5_renew_leave_${session.sessionId}`)
        .setLabel('🚪 退出')
        .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(keepBtn, leaveBtn);

    const user = await client.users.fetch(grant.userId).catch(() => null);
    if (!user) {
        await updateSelfRoleRenewalSession(session.sessionId, {
            status: 'dm_failed',
            requiresAdminFollowup: true,
        }).catch(() => {});
        // 防止下个 tick 立即重复尝试（简单退避：1天）
        await updateSelfRoleGrantInquiry(grant.grantId, {
            lastInquiryAt: now,
            nextInquiryAt: now + DAY_MS,
        }).catch(() => {});

        await setSelfRoleGrantManualAttentionRequired(grant.grantId, true).catch(() => {});
        const reportResult = await reportSelfRoleAlertOnce({
            client,
            guildId: grant.guildId,
            channelId: reportChannelId,
            roleId: grant.primaryRoleId,
            grantId: grant.grantId,
            applicationId: grant.applicationId,
            alertType: 'lifecycle_dm_inquiry_failed',
            severity: 'high',
            title: '⚠️ 生命周期询问失败：无法获取或无法私信用户',
            message: `无法获取用户 ${grant.userId}，留任询问未发送（将于 ${formatDateTime(now + DAY_MS)} 重试）。`,
            actionRequired:
                `请管理员核实该成员是否仍在服务器内、是否可被访问，并在服务器内手动联系该成员确认“留任/退出”。\n` +
                `如需退出，可手动移除身份组 <@&${grant.primaryRoleId}>（及其配套身份组）。`,
        }).catch(err => {
            console.error('[SelfRole][Lifecycle] ❌ 上报 DM 询问失败告警时出错:', err);
            return null;
        });
        if (reportResult && reportResult.reason && reportResult.reason !== 'ok') {
            console.warn(`[SelfRole][Lifecycle] ⚠️ DM 询问失败告警未发送到频道: reason=${reportResult.reason} channel=${reportChannelId || 'null'}`);
        }
        return;
    }

    let dmMessage = null;
    try {
        dmMessage = await user.send({ embeds: [embed], components: [row] });
    } catch (err) {
        console.error(
            `[SelfRole][Lifecycle] ❌ 无法向用户发送留任询问私信: user=${grant.userId} grant=${grant.grantId}`,
            err,
        );
        dmMessage = null;
    }

    if (!dmMessage) {
        await updateSelfRoleRenewalSession(session.sessionId, {
            status: 'dm_failed',
            requiresAdminFollowup: true,
        }).catch(() => {});
        // 防止下个 tick 立即重复尝试（简单退避：1天）
        await updateSelfRoleGrantInquiry(grant.grantId, {
            lastInquiryAt: now,
            nextInquiryAt: now + DAY_MS,
        }).catch(() => {});

        await setSelfRoleGrantManualAttentionRequired(grant.grantId, true).catch(() => {});
        const reportResult = await reportSelfRoleAlertOnce({
            client,
            guildId: grant.guildId,
            channelId: reportChannelId,
            roleId: grant.primaryRoleId,
            grantId: grant.grantId,
            applicationId: grant.applicationId,
            alertType: 'lifecycle_dm_inquiry_failed',
            severity: 'high',
            title: '⚠️ 生命周期询问失败：无法发送私信',
            message: `无法向用户 ${grant.userId} 发送私信，留任询问未送达（将于 ${formatDateTime(now + DAY_MS)} 重试）。`,
            actionRequired:
                `请管理员在服务器内联系该成员确认“留任/退出”，并提醒其开启私信（允许接收来自服务器成员的私信）。\n` +
                `如需退出，可手动移除身份组 <@&${grant.primaryRoleId}>（及其配套身份组）。`,
        }).catch(err => {
            console.error('[SelfRole][Lifecycle] ❌ 上报 DM 询问失败告警时出错:', err);
            return null;
        });
        if (reportResult && reportResult.reason && reportResult.reason !== 'ok') {
            console.warn(`[SelfRole][Lifecycle] ⚠️ DM 询问失败告警未发送到频道: reason=${reportResult.reason} channel=${reportChannelId || 'null'}`);
        }
        return;
    }

    await updateSelfRoleRenewalSession(session.sessionId, {
        dmMessageId: dmMessage.id,
    }).catch(() => {});

    // 更新 grant：记录询问时间并推进下一次询问时间
    const nextInquiryAt = computeNextInquiryAt(now, scheduleInfo.inquiryDays, scheduleInfo.forceRemoveAt);
    await updateSelfRoleGrantInquiry(grant.grantId, { lastInquiryAt: now, nextInquiryAt }).catch(() => {});

    scheduleActiveUserSelfRolePanelsRefresh(client, grant.guildId, 'lifecycle_inquiry_sent');
}

async function processForceRemove(client, grant, roleConfig, scheduleInfo) {
    const lc = roleConfig.lifecycle || {};
    const reportChannelId = lc.reportChannelId || null;

    const now = Date.now();

    await sendReportMessage(
        client,
        reportChannelId,
        `⏰ 准备强制清退 <@${grant.userId}>：<@&${grant.primaryRoleId}>（到期：${formatDateTime(scheduleInfo.forceRemoveAt)}）`,
    );

    const guild = client.guilds.cache.get(grant.guildId) || (await client.guilds.fetch(grant.guildId).catch(() => null));
    if (!guild) {
        await endSelfRoleGrant(grant.grantId, 'guild_missing', now).catch(() => {});
        return;
    }

    const member = await guild.members.fetch(grant.userId).catch(() => null);
    if (!member) {
        await endSelfRoleGrant(grant.grantId, 'member_missing', now).catch(() => {});
        return;
    }

    const roles = await listSelfRoleGrantRoles(grant.grantId);
    const roleIdsToRemove = roles.map(r => r.roleId);

    let removeOk = false;
    let removeErrText = '';
    try {
        if (roleIdsToRemove.length > 0) {
            await member.roles.remove(roleIdsToRemove);
        }
        removeOk = true;
    } catch (err) {
        removeErrText = err?.message ? String(err.message) : String(err);
        console.error('[SelfRole][Lifecycle] ❌ 强制清退移除身份组失败:', err);
    }

    if (!removeOk) {
        await setSelfRoleGrantManualAttentionRequired(grant.grantId, true).catch(() => {});
        await reportSelfRoleAlertOnce({
            client,
            guildId: grant.guildId,
            channelId: reportChannelId,
            roleId: grant.primaryRoleId,
            grantId: grant.grantId,
            applicationId: grant.applicationId,
            alertType: 'lifecycle_force_remove_role_remove_failed',
            severity: 'high',
            title: '⚠️ 强制清退失败：无法移除身份组',
            message: `强制清退到期，但无法从用户 ${grant.userId} 移除身份组：${removeErrText || 'unknown_error'}`,
            actionRequired:
                `grant 已保持 active，避免名额统计与服务器真实角色不一致。\n` +
                `请管理员检查机器人角色层级/权限，并手动移除：${roleIdsToRemove.map(rid => `<@&${rid}>`).join(' ') || `<@&${grant.primaryRoleId}>`}。\n` +
                `处理完成后可使用 /自助身份组申请-运维 开除岗位成员 结束 grant。`,
        }).catch(() => {});
        return;
    }

    await endSelfRoleGrant(grant.grantId, 'force_remove', now).catch(() => {});
    scheduleActiveUserSelfRolePanelsRefresh(client, grant.guildId, 'lifecycle_force_removed');

    const user = await client.users.fetch(grant.userId).catch(() => null);
    if (user) {
        const delayedNotice = lc.onlyWhenFull ? '（该身份组启用了“满员才执行”，若此前未满员则本次为延后执行）' : '';
        let dmOk = true;
        try {
            await user.send(
                `你拥有的身份组 <@&${grant.primaryRoleId}> 已到期，系统已执行强制清退。${delayedNotice}\n\n如需重新加入，请再次通过自助申请流程报名。`,
            );
        } catch (err) {
            dmOk = false;
            console.error(
                `[SelfRole][Lifecycle] ❌ 强制清退后私信通知失败: user=${grant.userId} grant=${grant.grantId}`,
                err,
            );
        }

        if (!dmOk) {
            await setSelfRoleGrantManualAttentionRequired(grant.grantId, true).catch(() => {});
            const reportResult = await reportSelfRoleAlertOnce({
                client,
                guildId: grant.guildId,
                channelId: reportChannelId,
                roleId: grant.primaryRoleId,
                grantId: grant.grantId,
                applicationId: grant.applicationId,
                alertType: 'lifecycle_dm_force_remove_failed',
                severity: 'medium',
                title: '⚠️ 强制清退通知失败：无法发送私信',
                message: `强制清退后无法向用户 ${grant.userId} 发送私信通知。`,
                actionRequired: `请管理员在服务器内通知该成员其身份组已被移除（<@&${grant.primaryRoleId}>）。如对处理有异议，请管理员核实 grant=${grant.grantId}。`,
            }).catch(err => {
                console.error('[SelfRole][Lifecycle] ❌ 上报强制清退私信失败告警时出错:', err);
                return null;
            });
            if (reportResult && reportResult.reason && reportResult.reason !== 'ok') {
                console.warn(`[SelfRole][Lifecycle] ⚠️ 强制清退私信失败告警未发送到频道: reason=${reportResult.reason} channel=${reportChannelId || 'null'}`);
            }
        }
    }

    await sendReportMessage(
        client,
        reportChannelId,
        `✅ 已强制清退 <@${grant.userId}>：<@&${grant.primaryRoleId}>（grant=${grant.grantId}）`,
    );
}

async function runLifecycleTick(client, opts = {}) {
    const onlyGuildId = opts?.guildId || null;
    const onlyGrantId = opts?.grantId || null;

    if (lifecycleRunning) {
        return { skipped: true, reason: 'already_running' };
    }

    lifecycleRunning = true;

    const startedAt = Date.now();
    const summary = {
        skipped: false,
        reason: 'ok',
        startedAt,
        finishedAt: null,
        durationMs: null,
        totalGrants: 0,
        consideredGrants: 0,
        dueGrants: 0,
        processedInquiries: 0,
        processedForceRemoves: 0,
        skippedNoRoleConfig: 0,
        skippedLifecycleDisabled: 0,
        skippedNotDue: 0,
        skippedOnlyWhenFull: 0,
        errors: 0,
    };

    try {
        const allSettings = await getAllSelfRoleSettings();
        const grants = await listAllActiveSelfRoleGrants();
        const now = Date.now();

        summary.totalGrants = Array.isArray(grants) ? grants.length : 0;

        for (const grant of grants) {
            if (onlyGuildId && grant.guildId !== onlyGuildId) continue;
            if (onlyGrantId && grant.grantId !== onlyGrantId) continue;

            summary.consideredGrants++;

            try {
                const guildSettings = allSettings?.[grant.guildId];
                const roleConfig = guildSettings?.roles?.find(r => r.roleId === grant.primaryRoleId);
                if (!roleConfig) {
                    summary.skippedNoRoleConfig++;
                    continue;
                }

                const lc = roleConfig.lifecycle || {};
                if (!lc.enabled) {
                    summary.skippedLifecycleDisabled++;
                    continue;
                }

                const scheduleInfo = await ensureGrantSchedule(grant, roleConfig);

                const dueForce = scheduleInfo.forceRemoveAt != null && now >= scheduleInfo.forceRemoveAt;
                const dueInquiry = !dueForce && scheduleInfo.nextInquiryAt != null && now >= scheduleInfo.nextInquiryAt;

                if (!dueForce && !dueInquiry) {
                    summary.skippedNotDue++;
                    continue;
                }

                summary.dueGrants++;

                if (lc.onlyWhenFull) {
                    const full = await isRoleFull(client, grant.guildId, roleConfig);
                    if (!full) {
                        // onlyWhenFull：计时照常，但不执行询问/清退
                        summary.skippedOnlyWhenFull++;
                        continue;
                    }
                }

                if (dueForce) {
                    await processForceRemove(client, grant, roleConfig, scheduleInfo);
                    summary.processedForceRemoves++;
                } else if (dueInquiry) {
                    await processInquiry(client, grant, roleConfig, scheduleInfo);
                    summary.processedInquiries++;
                }
            } catch (err) {
                summary.errors++;
                console.error('[SelfRole][Lifecycle] ❌ 处理 grant 生命周期时出错:', err);
            }
        }
    } catch (err) {
        summary.errors++;
        console.error('[SelfRole][Lifecycle] ❌ 生命周期 tick 异常:', err);
    } finally {
        lifecycleRunning = false;
        summary.finishedAt = Date.now();
        summary.durationMs = summary.finishedAt - startedAt;
    }

    return summary;
}

function startSelfRoleLifecycleScheduler(client) {
    if (lifecycleInterval) return;

    console.log('[SelfRole][Lifecycle] 启动 grant 生命周期调度器...');

    runLifecycleTick(client).catch(err => console.error('[SelfRole][Lifecycle] ❌ 初次执行失败:', err));

    const intervals = getCheckIntervals();
    const intervalMs = intervals.selfRoleLifecycleCheck || 5 * 60 * 1000;

    lifecycleInterval = setInterval(() => {
        runLifecycleTick(client).catch(err => console.error('[SelfRole][Lifecycle] ❌ 周期执行失败:', err));
    }, intervalMs);

    console.log(`[SelfRole][Lifecycle] ✅ 已启动，间隔=${Math.round(intervalMs / 60000)}分钟`);
}

async function handleSelfRoleRenewalDecision(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const isKeep = interaction.customId.startsWith('sr5_renew_keep_');
    const sessionId = interaction.customId.replace(isKeep ? 'sr5_renew_keep_' : 'sr5_renew_leave_', '');

    const session = await getSelfRoleRenewalSession(sessionId);
    if (!session || session.status !== 'pending') {
        await interaction.editReply({ content: '❌ 该询问已失效或已处理完毕。' });
        return;
    }

    const grant = await getSelfRoleGrant(session.grantId);
    if (!grant || grant.status !== 'active') {
        await interaction.editReply({ content: '❌ grant 已结束或不存在。' });
        return;
    }

    if (interaction.user.id !== grant.userId) {
        await interaction.editReply({ content: '❌ 你不是该询问的目标用户，无法操作。' });
        return;
    }

    const allSettings = await getAllSelfRoleSettings();
    const roleConfig = allSettings?.[grant.guildId]?.roles?.find(r => r.roleId === grant.primaryRoleId);
    const lc = roleConfig?.lifecycle || {};
    const reportChannelId = lc.reportChannelId || null;

    const now = Date.now();

    // 禁用按钮（尽量）
    if (interaction.message) {
        await interaction.message.edit({ components: buildDisabledRows(interaction.message) }).catch(() => {});
    }

    if (isKeep) {
        await updateSelfRoleRenewalSession(sessionId, {
            status: 'responded',
            respondedAt: now,
            decision: 'stay',
        }).catch(() => {});

        await updateSelfRoleGrantLastDecision(grant.grantId, 'stay').catch(() => {});

        const inquiryDays = Number(lc.inquiryDays || 0);
        const nextInquiryAt = computeNextInquiryAt(now, inquiryDays, grant.forceRemoveAt);
        await updateSelfRoleGrantInquiry(grant.grantId, { lastInquiryAt: now, nextInquiryAt }).catch(() => {});

        await sendReportMessage(
            interaction.client,
            reportChannelId,
            `✅ <@${grant.userId}> 选择留任：<@&${grant.primaryRoleId}>（grant=${grant.grantId}）`,
        );

        scheduleActiveUserSelfRolePanelsRefresh(interaction.client, grant.guildId, 'lifecycle_keep');

        await interaction.editReply({ content: '✅ 已记录你的留任选择。' });
        return;
    }

    // leave
    const guild = interaction.client.guilds.cache.get(grant.guildId) || (await interaction.client.guilds.fetch(grant.guildId).catch(() => null));
    if (!guild) {
        await interaction.editReply({ content: '❌ 无法获取服务器信息，操作失败。' });
        return;
    }

    const member = await guild.members.fetch(grant.userId).catch(() => null);
    if (!member) {
        await interaction.editReply({ content: '❌ 无法获取你的成员信息，操作失败。' });
        return;
    }

    const roles = await listSelfRoleGrantRoles(grant.grantId);
    const roleIdsToRemove = roles.map(r => r.roleId);

    let removeOk = false;
    let removeErrText = '';
    try {
        if (roleIdsToRemove.length > 0) {
            await member.roles.remove(roleIdsToRemove);
        }
        removeOk = true;
    } catch (err) {
        removeErrText = err?.message ? String(err.message) : String(err);
        console.error('[SelfRole][Lifecycle] ❌ 用户选择退出时移除身份组失败:', err);
    }

    if (!removeOk) {
        await setSelfRoleGrantManualAttentionRequired(grant.grantId, true).catch(() => {});
        await reportSelfRoleAlertOnce({
            client: interaction.client,
            guildId: grant.guildId,
            channelId: reportChannelId,
            roleId: grant.primaryRoleId,
            grantId: grant.grantId,
            applicationId: grant.applicationId,
            alertType: 'lifecycle_user_exit_role_remove_failed',
            severity: 'high',
            title: '⚠️ 用户退出失败：无法移除身份组',
            message: `用户 ${grant.userId} 已选择退出，但机器人无法移除身份组：${removeErrText || 'unknown_error'}`,
            actionRequired:
                `grant 已保持 active，避免数据库显示已结束但服务器角色仍存在。\n` +
                `请管理员检查机器人角色层级/权限，并手动移除：${roleIdsToRemove.map(rid => `<@&${rid}>`).join(' ') || `<@&${grant.primaryRoleId}>`}。\n` +
                `处理完成后可使用 /自助身份组申请-运维 开除岗位成员 结束 grant。`,
        }).catch(() => {});
        await interaction.editReply({ content: '⚠️ 已收到你的退出选择，但机器人移除身份组失败；已通知管理员处理，grant 暂未结束。' });
        return;
    }

    await endSelfRoleGrant(grant.grantId, 'user_exit', now).catch(() => {});

    await updateSelfRoleRenewalSession(sessionId, {
        status: 'responded',
        respondedAt: now,
        decision: 'leave',
    }).catch(() => {});

    await updateSelfRoleGrantLastDecision(grant.grantId, 'leave').catch(() => {});

    await sendReportMessage(
        interaction.client,
        reportChannelId,
        `🚪 <@${grant.userId}> 已选择退出：<@&${grant.primaryRoleId}>（grant=${grant.grantId}）`,
    );

    scheduleActiveUserSelfRolePanelsRefresh(interaction.client, grant.guildId, 'lifecycle_leave');

    await interaction.editReply({ content: '✅ 已为你执行退出操作，身份组已移除。' });
}

module.exports = {
    startSelfRoleLifecycleScheduler,
    runSelfRoleLifecycleTick: runLifecycleTick,
    handleSelfRoleRenewalDecision,
};
