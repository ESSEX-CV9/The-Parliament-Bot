// src/modules/selfRole/services/consistencyChecker.js

const { getCheckIntervals } = require('../../../core/config/timeconfig');

const {
    getAllSelfRoleSettings,
    getActiveSelfRolePanels,
    deactivateSelfRolePanel,
    createSelfRoleSystemAlert,
    getActiveSelfRoleSystemAlertByGrantType,
    listEndedSelfRoleGrantsSince,
    listSelfRoleGrantRoles,
    setSelfRoleGrantManualAttentionRequired,
} = require('../../../core/utils/database');

const { reportSelfRoleAlertOnce } = require('./alertReporter');

const DAY_MS = 24 * 60 * 60 * 1000;
const ENDED_GRANT_LOOKBACK_DAYS = 30;

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
    };

    try {
        const allSettings = await getAllSelfRoleSettings();

        summary.panels = await checkPanels(client, allSettings);
        summary.endedGrants = await checkEndedGrants(client, allSettings);

        summary.finishedAt = Date.now();
        summary.durationMs = summary.finishedAt - summary.startedAt;

        console.log('[SelfRole][Consistency] ✅ 一致性巡检完成:', {
            durationMs: summary.durationMs,
            panels: summary.panels,
            endedGrants: summary.endedGrants,
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
