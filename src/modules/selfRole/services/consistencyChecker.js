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

    for (const guildId of guildIds) {
        const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
        if (!guild) continue;

        for (const panelType of ['user', 'admin']) {
            const panels = await getActiveSelfRolePanels(guildId, panelType);
            if (!panels || panels.length === 0) continue;

            for (const panel of panels) {
                try {
                    const channel = await guild.channels.fetch(panel.channelId).catch(() => null);
                    if (!channel || !channel.isTextBased()) {
                        await deactivateSelfRolePanel(panel.panelId).catch(() => {});

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

                        await createSelfRoleSystemAlert({
                            guildId,
                            alertType: 'panel_message_missing',
                            severity: 'low',
                            message: `面板消息已丢失：panelType=${panelType} channelId=${panel.channelId} messageId=${panel.messageId}`,
                            actionRequired: '请重新创建面板：用户面板用 /自助身份组申请-创建自助身份组面板；管理面板用 /自助身份组申请-创建管理面板。',
                        }).catch(() => null);
                    }
                } catch (err) {
                    console.error('[SelfRole][Consistency] ❌ 检查面板失败:', err);
                }
            }
        }
    }
}

async function checkEndedGrants(client, allSettings) {
    const now = Date.now();
    const since = now - ENDED_GRANT_LOOKBACK_DAYS * DAY_MS;

    const ended = await listEndedSelfRoleGrantsSince(since, 500);
    if (!ended || ended.length === 0) return;

    for (const grant of ended) {
        try {
            const existing = await getActiveSelfRoleSystemAlertByGrantType(grant.grantId, 'ended_grant_roles_still_present');
            if (existing) continue;

            const guild = client.guilds.cache.get(grant.guildId) || (await client.guilds.fetch(grant.guildId).catch(() => null));
            if (!guild) continue;

            const member = await guild.members.fetch(grant.userId).catch(() => null);
            if (!member) continue;

            const grantRoles = await listSelfRoleGrantRoles(grant.grantId);
            if (!grantRoles || grantRoles.length === 0) continue;

            const stillHas = grantRoles.filter(r => member.roles.cache.has(r.roleId));
            if (stillHas.length === 0) continue;

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
            console.error('[SelfRole][Consistency] ❌ 检查 ended grant 失败:', err);
        }
    }
}

async function runSelfRoleConsistencyCheck(client) {
    if (checkerRunning) return;
    checkerRunning = true;

    try {
        const allSettings = await getAllSelfRoleSettings();

        await checkPanels(client, allSettings);
        await checkEndedGrants(client, allSettings);

        console.log('[SelfRole][Consistency] ✅ 一致性巡检完成');
    } finally {
        checkerRunning = false;
    }
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
