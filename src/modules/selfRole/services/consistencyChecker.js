// src/modules/selfRole/services/consistencyChecker.js

const { getCheckIntervals } = require('../../../core/config/timeconfig');

const {
    getAllSelfRoleSettings,
    getActiveSelfRolePanels,
    deactivateSelfRolePanel,
    createSelfRoleSystemAlert,
    getActiveSelfRoleSystemAlertByGrantType,
    listEndedSelfRoleGrantsSince,
    listAllActiveSelfRoleGrants,
    listSelfRoleGrantRoles,
    setSelfRoleGrantManualAttentionRequired,
} = require('../../../core/utils/database');

const { reportSelfRoleAlertOnce } = require('./alertReporter');
const { withRetry } = require('../../roleSync/utils/networkRetry');

const DAY_MS = 24 * 60 * 60 * 1000;
const ENDED_GRANT_LOOKBACK_DAYS = 30;
const ACTIVE_GRANT_CHECK_LIMIT = 800;

let checkerInterval = null;
let checkerRunning = false;

function formatDateTime(ts) {
    try {
        return new Date(ts).toLocaleString('zh-CN', { hour12: false });
    } catch (_) {
        return String(ts);
    }
}

async function sendReportMessage(client, reportChannelId, content) {
    if (!reportChannelId) return null;
    const ch = await client.channels.fetch(reportChannelId).catch(() => null);
    if (!ch || !ch.isTextBased()) return null;
    return ch.send({ content, allowedMentions: { parse: [] } }).catch(() => null);
}

async function checkPanels(client, allSettings) {
    const guildIds = Object.keys(allSettings || {});

    const summary = {
        guilds: guildIds.length,
        panels: 0,
        checked: 0,
        deactivated: 0,
        channelMissing: 0,
        messageMissing: 0,
        errors: 0,
    };

    for (const guildId of guildIds) {
        const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
        if (!guild) continue;

        for (const panelType of ['user', 'admin']) {
            const panels = await getActiveSelfRolePanels(guildId, panelType);
            if (!panels || panels.length === 0) continue;

            summary.panels += panels.length;

            for (const panel of panels) {
                try {
                    summary.checked += 1;

                    const channel = await guild.channels.fetch(panel.channelId).catch(() => null);
                    if (!channel || !channel.isTextBased()) {
                        await deactivateSelfRolePanel(panel.panelId).catch(() => {});

                        summary.channelMissing += 1;
                        summary.deactivated += 1;

                        await createSelfRoleSystemAlert({
                            guildId,
                            alertType: 'panel_channel_missing',
                            severity: 'low',
                            message: `面板频道不可访问或不存在：panelType=${panelType} channelId=${panel.channelId} messageId=${panel.messageId}`,
                            actionRequired: '请重新创建面板：用户面板用 /自助身份组申请-创建自助身份组面板；管理面板用 /自助身份组申请-创建管理面板。',
                        }).catch(() => null);
                        continue;
                    }

                    const msg = await channel.messages.fetch(panel.messageId).catch(() => null);
                    if (!msg) {
                        await deactivateSelfRolePanel(panel.panelId).catch(() => {});

                        summary.messageMissing += 1;
                        summary.deactivated += 1;

                        await createSelfRoleSystemAlert({
                            guildId,
                            alertType: 'panel_message_missing',
                            severity: 'low',
                            message: `面板消息已丢失：panelType=${panelType} channelId=${panel.channelId} messageId=${panel.messageId}`,
                            actionRequired: '请重新创建面板：用户面板用 /自助身份组申请-创建自助身份组面板；管理面板用 /自助身份组申请-创建管理面板。',
                        }).catch(() => null);
                    }
                } catch (err) {
                    summary.errors += 1;
                    console.error('[SelfRole][Consistency] ❌ 检查面板失败:', err);
                }
            }
        }
    }

    return summary;
}

async function checkEndedGrants(client, allSettings) {
    const now = Date.now();
    const since = now - ENDED_GRANT_LOOKBACK_DAYS * DAY_MS;

    const ended = await listEndedSelfRoleGrantsSince(since, 500);

    const summary = {
        scanned: Array.isArray(ended) ? ended.length : 0,
        checked: 0,
        skippedExistingAlert: 0,
        guildMissing: 0,
        memberMissing: 0,
        noGrantRoles: 0,
        residualFound: 0,
        errors: 0,
    };

    if (!ended || ended.length === 0) return summary;

    for (const grant of ended) {
        try {
            summary.checked += 1;
            const existing = await getActiveSelfRoleSystemAlertByGrantType(grant.grantId, 'ended_grant_roles_still_present');
            if (existing) {
                summary.skippedExistingAlert += 1;
                continue;
            }

            const guild = client.guilds.cache.get(grant.guildId) || (await client.guilds.fetch(grant.guildId).catch(() => null));
            if (!guild) {
                summary.guildMissing += 1;
                continue;
            }

            const member = await guild.members.fetch(grant.userId).catch(() => null);
            if (!member) {
                summary.memberMissing += 1;
                continue;
            }

            const grantRoles = await listSelfRoleGrantRoles(grant.grantId);
            if (!grantRoles || grantRoles.length === 0) {
                summary.noGrantRoles += 1;
                continue;
            }

            const stillHas = grantRoles.filter(r => member.roles.cache.has(r.roleId));
            if (stillHas.length === 0) continue;

            summary.residualFound += 1;

            const stillText = stillHas.map(r => `<@&${r.roleId}>`).join(' ');

            // 写入告警 + 标记需要管理员介入
            await setSelfRoleGrantManualAttentionRequired(grant.grantId, true).catch(() => {});

            // 若该身份组配置了报告频道，则在报告频道发“显眼一次性报告 + 一键处理按钮”；否则仅落库用于去重/追踪。
            const roleConfig = allSettings?.[grant.guildId]?.roles?.find(r => r.roleId === grant.primaryRoleId);
            const reportChannelId = roleConfig?.lifecycle?.reportChannelId || null;

            await reportSelfRoleAlertOnce({
                client,
                guildId: grant.guildId,
                channelId: reportChannelId,
                roleId: grant.primaryRoleId,
                grantId: grant.grantId,
                applicationId: grant.applicationId,
                alertType: 'ended_grant_roles_still_present',
                severity: 'high',
                title: '⚠️ 一致性巡检：grant 已结束但角色仍残留',
                message:
                    `一致性巡检发现：grant 已结束但成员仍持有角色。\n` +
                    `成员：<@${grant.userId}>\n` +
                    `身份组残留：${stillText}\n` +
                    `结束时间：${grant.endedAt ? formatDateTime(grant.endedAt) : '未知'}；原因：${grant.endedReason || '未知'}`,
                actionRequired: `请管理员手动移除上述残留身份组：${stillText}。移除完成后点击本消息下方“✅ 标记为已处理”。`,
            }).catch(() => null);
        } catch (err) {
            summary.errors += 1;
            console.error('[SelfRole][Consistency] ❌ 检查 ended grant 失败:', err);
        }
    }

    return summary;
}


async function checkActiveGrantsMissingRoles(client, allSettings) {
    const all = await listAllActiveSelfRoleGrants().catch(() => []);
    const allGrants = Array.isArray(all) ? all : [];

    const summary = {
        scanned: allGrants.length,
        checked: 0,
        truncated: false,
        skippedExistingAlert: 0,
        skippedNoRoleConfig: 0,
        guildMissing: 0,
        memberMissing: 0,
        noGrantRoles: 0,
        missingFound: 0,
        missingPrimaryFound: 0,
        missingBundleFound: 0,
        errors: 0,
    };

    if (allGrants.length === 0) return summary;

    let grants = allGrants;
    if (allGrants.length > ACTIVE_GRANT_CHECK_LIMIT) {
        summary.truncated = true;
        grants = allGrants.slice(0, ACTIVE_GRANT_CHECK_LIMIT);
    }

    const guildCache = new Map();
    async function getGuild(guildId) {
        if (guildCache.has(guildId)) return guildCache.get(guildId);
        const g = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
        guildCache.set(guildId, g);
        return g;
    }

    for (const grant of grants) {
        try {
            summary.checked += 1;

            // 去重：同一 grant 的同类异常只上报一次，避免刷屏。
            const existing = await getActiveSelfRoleSystemAlertByGrantType(grant.grantId, 'active_grant_roles_missing');
            if (existing) {
                summary.skippedExistingAlert += 1;
                continue;
            }

            const guildSettings = allSettings?.[grant.guildId];
            const roleConfig = guildSettings?.roles?.find(r => r.roleId === grant.primaryRoleId) || null;
            if (!roleConfig) {
                summary.skippedNoRoleConfig += 1;
                continue;
            }

            const reportChannelId = roleConfig?.lifecycle?.reportChannelId || null;

            const guild = await getGuild(grant.guildId);
            if (!guild) {
                summary.guildMissing += 1;
                continue;
            }

            // 获取成员
            let member;
            try {
                member = await withRetry(
                    () => guild.members.fetch(grant.userId),
                    { retries: 2, baseDelayMs: 300, label: `consistency_fetch_member_${grant.guildId}_${grant.userId}` },
                );
            } catch (err) {
                const code = err?.code;
                if (code === 10007 || code === '10007') {
                    member = null;
                } else {
                    throw err;
                }
            }

            if (!member) {
                summary.memberMissing += 1;

                await setSelfRoleGrantManualAttentionRequired(grant.grantId, true).catch(() => {});

                await reportSelfRoleAlertOnce({
                    client,
                    guildId: grant.guildId,
                    channelId: reportChannelId,
                    roleId: grant.primaryRoleId,
                    grantId: grant.grantId,
                    applicationId: grant.applicationId,
                    alertType: 'active_grant_roles_missing',
                    severity: 'medium',
                    title: '⚠️ 一致性巡检：active grant 但成员不在服务器',
                    message:
                        `一致性巡检发现：grant 仍为 active，但成员已不在服务器（或无法获取成员对象）。\n` +
                        `成员：<@${grant.userId}>\n` +
                        `岗位：<@&${grant.primaryRoleId}>\n` +
                        `授予时间：${grant.grantedAt ? formatDateTime(grant.grantedAt) : '未知'}`,
                    actionRequired:
                        `建议核实该成员是否已退群。若确认不在服务器，可使用运维命令结束该 grant（例如：/自助身份组申请-运维 开除岗位成员），以校准名额统计。\n` +
                        `处理完成后点击本消息下方“✅ 标记为已处理”。`,
                }).catch(() => null);

                continue;
            }

            const grantRoles = await listSelfRoleGrantRoles(grant.grantId).catch(() => []);
            if (!grantRoles || grantRoles.length === 0) {
                summary.noGrantRoles += 1;
                continue;
            }

            const missing = grantRoles.filter(r => !member.roles.cache.has(r.roleId));
            if (missing.length === 0) continue;

            summary.missingFound += 1;

            const missingPrimary = missing.some(r => r.roleKind === 'primary' || r.roleId === grant.primaryRoleId);
            const missingBundle = missing.some(r => r.roleKind === 'bundle' && r.roleId !== grant.primaryRoleId);
            if (missingPrimary) summary.missingPrimaryFound += 1;
            if (missingBundle) summary.missingBundleFound += 1;

            const missingText = missing.map(r => `<@&${r.roleId}>(${r.roleKind})`).join(' ');

            await setSelfRoleGrantManualAttentionRequired(grant.grantId, true).catch(() => {});

            await reportSelfRoleAlertOnce({
                client,
                guildId: grant.guildId,
                channelId: reportChannelId,
                roleId: grant.primaryRoleId,
                grantId: grant.grantId,
                applicationId: grant.applicationId,
                alertType: 'active_grant_roles_missing',
                severity: 'high',
                title: '⚠️ 一致性巡检：active grant 但角色缺失',
                message:
                    `一致性巡检发现：grant 仍为 active，但成员缺失应有的身份组（可能被手动移除）。\n` +
                    `成员：<@${grant.userId}>\n` +
                    `岗位：<@&${grant.primaryRoleId}>\n` +
                    `缺失身份组：${missingText}\n` +
                    `授予时间：${grant.grantedAt ? formatDateTime(grant.grantedAt) : '未知'}`,
                actionRequired:
                    `请管理员核实该成员是否仍应担任该岗位：\n` +
                    `- 若应继续担任：请手动补回缺失的身份组（含配套身份组），并点击本消息“✅ 标记为已处理”。\n` +
                    `- 若不应继续担任：建议使用 /自助身份组申请-运维 开除岗位成员 结束 grant（用于校准名额统计/生命周期口径），并点击“✅ 标记为已处理”。`,
            }).catch(() => null);

        } catch (err) {
            summary.errors += 1;
            console.error('[SelfRole][Consistency] ❌ 检查 active grant 角色缺失失败:', err);
        }
    }

    return summary;
}


async function runSelfRoleConsistencyCheck(client) {
    if (checkerRunning) return { skipped: true, reason: 'already_running' };
    checkerRunning = true;

    const startedAt = Date.now();
    const summary = {
        skipped: false,
        reason: 'ok',
        error: null,
        startedAt,
        finishedAt: null,
        durationMs: null,
        panels: null,
        endedGrants: null,
        activeGrantsMissingRoles: null,
    };

    try {
        const allSettings = await getAllSelfRoleSettings();

        summary.panels = await checkPanels(client, allSettings);
        summary.endedGrants = await checkEndedGrants(client, allSettings);
        summary.activeGrantsMissingRoles = await checkActiveGrantsMissingRoles(client, allSettings);

        summary.finishedAt = Date.now();
        summary.durationMs = summary.finishedAt - summary.startedAt;

        console.log('[SelfRole][Consistency] ✅ 一致性巡检完成:', {
            durationMs: summary.durationMs,
            panels: summary.panels,
            endedGrants: summary.endedGrants,
            activeGrantsMissingRoles: summary.activeGrantsMissingRoles,
        });
    } catch (err) {
        summary.reason = 'error';
        summary.error = err?.message ? String(err.message) : String(err);
        summary.finishedAt = Date.now();
        summary.durationMs = summary.finishedAt - summary.startedAt;
        console.error('[SelfRole][Consistency] ❌ 一致性巡检执行失败:', err);
    } finally {
        checkerRunning = false;
    }

    return summary;
}

function startSelfRoleConsistencyChecker(client) {
    if (checkerInterval) return;

    console.log('[SelfRole][Consistency] 启动一致性巡检...');

    runSelfRoleConsistencyCheck(client).catch(err => console.error('[SelfRole][Consistency] ❌ 初次巡检失败:', err));

    const intervals = getCheckIntervals();
    const intervalMs = intervals.selfRoleConsistencyCheck || 60 * 60 * 1000;

    checkerInterval = setInterval(() => {
        runSelfRoleConsistencyCheck(client).catch(err => console.error('[SelfRole][Consistency] ❌ 周期巡检失败:', err));
    }, intervalMs);

    console.log(`[SelfRole][Consistency] ✅ 已启动，间隔=${Math.round(intervalMs / 60000)}分钟`);
}

module.exports = {
    startSelfRoleConsistencyChecker,
    runSelfRoleConsistencyCheck,
};
