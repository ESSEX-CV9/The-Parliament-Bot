const { EmbedBuilder } = require('discord.js');
const { getRoleSyncSetting } = require('../utils/roleSyncDatabase');

const ENV_ALERT_CHANNEL_IDS = process.env.ROLE_SYNC_ALERT_CHANNEL_ID || '';
const DASHBOARD_PORT = process.env.ROLE_SYNC_DASHBOARD_PORT || 3847;

function getAlertChannelIds() {
    const dbValue = getRoleSyncSetting('alert_channel_ids', null);
    const raw = dbValue || ENV_ALERT_CHANNEL_IDS;
    if (!raw) return [];
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

async function sendRoleSyncAlert(client, payload) {
    const channelIds = getAlertChannelIds();
    if (channelIds.length === 0) {
        console.warn('[RoleSync] ALERT (未配置告警频道):', JSON.stringify(payload));
        return;
    }

    if (!client) {
        console.warn('[RoleSync] ALERT (client 不可用):', JSON.stringify(payload));
        return;
    }

    const embed = buildAlertEmbed(payload);

    for (const channelId of channelIds) {
        try {
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (!channel || !channel.isTextBased()) {
                console.warn(`[RoleSync] 告警频道 ${channelId} 不存在或非文本频道`);
                continue;
            }
            await channel.send({ embeds: [embed] });
        } catch (err) {
            console.error(`[RoleSync] 发送告警到 ${channelId} 失败:`, err);
        }
    }
}

function buildAlertEmbed(payload) {
    const {
        type,
        guildId,
        guildName,
        roleId,
        roleName,
        mappingsAffected,
        disabledCount,
        cancelledJobCount,
    } = payload;

    let title, description, color;

    if (type === 'source_role_deleted') {
        title = '🚨 源服务器身份组被删除 — 同步保护已触发';
        color = 0xFF0000;
        description =
            `源服务器 **${guildName || guildId}** 中的身份组被删除。\n` +
            `已阻止向目标服务器批量移除对应身份组。\n\n` +
            `**被删身份组：** ${roleName} (\`${roleId}\`)\n` +
            `**已禁用映射：** ${disabledCount}\n` +
            `**已取消待执行任务：** ${cancelledJobCount}`;
    } else if (type === 'target_role_deleted') {
        title = '⚠️ 目标服务器身份组被删除 — 映射已禁用';
        color = 0xFF8C00;
        description =
            `目标服务器 **${guildName || guildId}** 中的身份组被删除。\n\n` +
            `**被删身份组：** ${roleName} (\`${roleId}\`)\n` +
            `**已禁用映射：** ${disabledCount}\n` +
            `**已取消待执行任务：** ${cancelledJobCount}`;
    } else if (type === 'circuit_breaker_tripped') {
        title = '🔴 熔断器触发 — 批量移除已阻断';
        color = 0xFF0000;
        description =
            `检测到短时间内对身份组 \`${roleId}\` 的异常大量 **remove** 操作。\n` +
            `同步操作已暂停。\n\n` +
            `**需要操作：** 检查源服务器是否有身份组被删除，确认后在管理面板中处理。`;
    } else {
        title = '📢 身份组同步告警';
        color = 0x5865F2;
        description = JSON.stringify(payload);
    }

    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setTimestamp();

    if (mappingsAffected && mappingsAffected.length > 0) {
        const summary = mappingsAffected.slice(0, 5).map(m =>
            `• link \`${m.link_id}\`: \`${m.source_role_id}\` → \`${m.target_role_id}\``
        ).join('\n') + (mappingsAffected.length > 5 ? `\n…及另外 ${mappingsAffected.length - 5} 条` : '');
        embed.addFields({ name: '受影响映射', value: summary });
    }

    const dashboardUrl = `http://localhost:${DASHBOARD_PORT}/config`;
    embed.addFields({
        name: '处置建议',
        value:
            `1. 调查身份组删除原因\n` +
            `2. 如需恢复，请访问管理面板：${dashboardUrl}\n` +
            `3. 如确认删除，可在管理面板中清除孤儿映射数据`,
    });

    return embed;
}

module.exports = { sendRoleSyncAlert };
