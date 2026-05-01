// src/modules/selfRole/services/applicationChecker.js

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder } = require('discord.js');
const { getCheckIntervals } = require('../../../core/config/timeconfig');

const {
    getAllSelfRoleSettings,
    getSelfRoleApplicationV2ByReviewMessageId,
    saveSelfRoleApplicationV2,
    listLegacyPendingSelfRoleApplications,
    expirePendingSelfRoleApplicationsV2,
    deleteSelfRoleApplication,
} = require('../../../core/utils/database');

const { scheduleActiveUserSelfRolePanelsRefresh } = require('./panelService');

const DEFAULT_PENDING_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;

let checkerInterval = null;

function buildDisabledRows(message) {
    if (!message?.components || message.components.length === 0) {
        return [];
    }

    return message.components.map(row => {
        const disabledButtons = row.components.map(component => {
            try {
                return ButtonBuilder.from(component).setDisabled(true);
            } catch (_) {
                return component;
            }
        });
        return new ActionRowBuilder().addComponents(disabledButtons);
    });
}

function safeAppendDescription(original, appendText) {
    const base = (original || '').trim();
    const next = base ? `${base}\n\n${appendText}` : appendText;
    // Embed description 上限 4096
    return next.length > 4096 ? next.slice(0, 4093) + '…' : next;
}

async function migrateLegacyPendingApplicationsToV2() {
    const allSettings = await getAllSelfRoleSettings();
    const roleIdToGuildId = new Map();

    for (const [guildId, s] of Object.entries(allSettings || {})) {
        for (const rc of s?.roles || []) {
            if (rc?.roleId) {
                roleIdToGuildId.set(rc.roleId, guildId);
            }
        }
    }

    const legacyPendings = await listLegacyPendingSelfRoleApplications();

    let migrated = 0;
    const now = Date.now();

    for (const item of legacyPendings) {
        const guildId = roleIdToGuildId.get(item.roleId);
        if (!guildId) {
            // 找不到配置归属 guild（可能该身份组配置已被移除），跳过
            continue;
        }

        const existingV2 = await getSelfRoleApplicationV2ByReviewMessageId(item.messageId);
        if (existingV2) continue;

        const applicationId = item.messageId; // 直接复用 messageId，便于排查

        try {
            await saveSelfRoleApplicationV2(applicationId, {
                guildId,
                applicantId: item.applicantId,
                roleId: item.roleId,
                status: 'pending',
                reason: item.reason || null,
                reviewMessageId: item.messageId,
                reviewChannelId: null,
                slotReserved: true,
                reservedUntil: now + DEFAULT_PENDING_EXPIRE_MS,
                createdAt: now,
                resolvedAt: null,
                resolutionReason: null,
            });
            migrated++;
        } catch (err) {
            console.error(`[SelfRole][AppChecker] ❌ legacy pending 申请迁移到 v2 失败: message=${item.messageId}`, err);
        }
    }

    if (migrated > 0) {
        console.log(`[SelfRole][AppChecker] ✅ 已将 legacy pending 申请迁移到 v2：${migrated} 条`);
    }

    return migrated;
}

async function markReviewMessageAsExpired(client, application) {
    if (!application?.reviewChannelId || !application?.reviewMessageId) return;

    const channel = await client.channels.fetch(application.reviewChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const message = await channel.messages.fetch(application.reviewMessageId).catch(() => null);
    if (!message) return;

    const originalEmbed = message.embeds?.[0];
    if (!originalEmbed) {
        await message.edit({ components: buildDisabledRows(message) }).catch(() => {});
        return;
    }

    const updated = new EmbedBuilder(originalEmbed.data)
        .setColor(0x747F8D)
        .setDescription(
            safeAppendDescription(
                originalEmbed.description,
                '⌛ **该申请已过期**（超过默认期限未完成审核），系统已自动释放预留名额。',
            ),
        )
        .setFields(
            ...originalEmbed.fields.map(field => {
                if (field.name === '状态') {
                    return { ...field, value: '⌛ 已过期' };
                }
                return field;
            }),
        );

    await message.edit({ embeds: [updated], components: buildDisabledRows(message) }).catch(() => {});
}

async function checkExpiredSelfRoleApplications(client) {
    const expired = await expirePendingSelfRoleApplicationsV2(Date.now());
    if (!expired || expired.length === 0) return [];

    for (const app of expired) {
        try {
            if (app.reviewMessageId) {
                // 终止 legacy 投票记录（避免继续投票）
                await deleteSelfRoleApplication(app.reviewMessageId).catch(() => {});
            }

            await markReviewMessageAsExpired(client, app).catch(() => {});

            if (app.guildId) {
                scheduleActiveUserSelfRolePanelsRefresh(client, app.guildId, 'application_expired');
            }
        } catch (err) {
            console.error('[SelfRole][AppChecker] ❌ 处理过期申请时出错:', err);
        }
    }

    console.log(`[SelfRole][AppChecker] ⌛ 已处理过期 selfRole pending 申请：${expired.length} 条`);
    return expired;
}

function startSelfRoleApplicationChecker(client) {
    if (checkerInterval) {
        return;
    }

    console.log('[SelfRole][AppChecker] 启动 selfRole 申请过期检查器...');

    // 启动时对所有服务器做一次面板刷新（尽量保证“待审核/空缺”显示接近实时）
    for (const gid of client.guilds.cache.keys()) {
        scheduleActiveUserSelfRolePanelsRefresh(client, gid, 'startup');
    }

    // 立即做一次迁移与过期检查
    migrateLegacyPendingApplicationsToV2()
        .then(() => checkExpiredSelfRoleApplications(client))
        .catch(err => console.error('[SelfRole][AppChecker] ❌ 初始化检查失败:', err));

    const intervals = getCheckIntervals();
    const intervalMs = intervals.selfRoleApplicationCheck || 30 * 60 * 1000;

    checkerInterval = setInterval(() => {
        migrateLegacyPendingApplicationsToV2()
            .then(() => checkExpiredSelfRoleApplications(client))
            .catch(err => console.error('[SelfRole][AppChecker] ❌ 周期检查失败:', err));
    }, intervalMs);

    console.log(`[SelfRole][AppChecker] ✅ 已启动，间隔=${Math.round(intervalMs / 60000)}分钟`);
}

module.exports = {
    startSelfRoleApplicationChecker,
    migrateLegacyPendingApplicationsToV2,
    checkExpiredSelfRoleApplications,
};
