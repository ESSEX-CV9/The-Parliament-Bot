const { EmbedBuilder } = require('discord.js');
const { getAnnouncementChannels, getArchiveChannels } = require('./punishmentDatabase');

const COLORS = {
    ban: 0xED4245,        // 红色
    mute: 0xF39C12,       // 橙色
    warn_role: 0xF39C12,  // 橙色
    unban: 0xD56CFF,      // 粉紫色（撤销）
    unmute: 0xD56CFF,     // 粉紫色（撤销）
};

const TITLES = {
    ban: '⛔ 永久封禁',
    mute: '🔇禁言处罚',
    warn_role: '⚠️警告处罚',
    unban: '🔓撤销处罚',
    unmute: '🔓撤销处罚',
};

function clampText(text, maxLen = 1024) {
    const normalized = (text || '').trim() || '未说明';
    if (normalized.length <= maxLen) return normalized;
    return normalized.slice(0, Math.max(1, maxLen - 1)) + '…';
}

function getOriginalPunishmentTypeLabel(type) {
    switch (type) {
        case 'mute': return '禁言';
        case 'ban': return '永久封禁';
        case 'warn_role': return '警告处罚';
        default: return type || '未知';
    }
}

function buildAnnouncementEmbed({
    type,
    targetUserId,
    executorId,
    reason,
    durationLabel,
    warnDurationLabel,
    scopeGuildNames,
    punishmentId,
    originalPunishment,
    targetAvatarUrl,
}) {
    const embed = new EmbedBuilder()
        .setTitle(TITLES[type] || '处罚公告')
        .setColor(COLORS[type] || 0x5865F2)
        .setTimestamp();

    if (targetAvatarUrl) {
        embed.setThumbnail(targetAvatarUrl);
    }

    const safeReason = clampText(reason, 1024);
    const safeScope = clampText(scopeGuildNames || '当前服务器', 1024);

    if (type === 'mute') {
        embed.addFields(
            { name: '时长', value: durationLabel || '未提供', inline: true },
            { name: '成员', value: `<@${targetUserId}>`, inline: true },
            { name: '管理员', value: `<@${executorId}>`, inline: true },
            { name: '原因', value: safeReason, inline: false },
            { name: '警告时长', value: warnDurationLabel || '无', inline: true },
            { name: '处罚范围', value: safeScope, inline: true },
        );
    } else if (type === 'ban') {
        embed.addFields(
            { name: '成员', value: `<@${targetUserId}>`, inline: true },
            { name: '管理员', value: `<@${executorId}>`, inline: true },
            { name: '\u200b', value: '\u200b', inline: true },
            { name: '原因', value: safeReason, inline: false },
            { name: '处罚范围', value: safeScope, inline: false },
        );
    } else if (type === 'warn_role') {
        embed.addFields(
            { name: '时长', value: durationLabel || '未提供', inline: true },
            { name: '成员', value: `<@${targetUserId}>`, inline: true },
            { name: '管理员', value: `<@${executorId}>`, inline: true },
            { name: '原因', value: safeReason, inline: false },
            { name: '处罚范围', value: safeScope, inline: false },
        );
    } else if (type === 'unban' || type === 'unmute') {
        const originalType = originalPunishment?.type
            ? getOriginalPunishmentTypeLabel(originalPunishment.type)
            : '未知';
        const originalId = originalPunishment?.id
            ? `\`${String(originalPunishment.id)}\``
            : '未知（未找到原处罚记录）';

        embed.addFields(
            { name: '成员', value: `<@${targetUserId}>`, inline: true },
            { name: '管理员', value: `<@${executorId}>`, inline: true },
            { name: '\u200b', value: '\u200b', inline: true },
            { name: '原因', value: safeReason, inline: false },
            { name: '处罚类型', value: originalType, inline: true },
            { name: '原处罚ID', value: originalId, inline: true },
            { name: '撤销范围', value: safeScope, inline: true },
        );
    } else {
        embed.addFields(
            { name: '成员', value: `<@${targetUserId}>`, inline: true },
            { name: '管理员', value: `<@${executorId}>`, inline: true },
            { name: '原因', value: safeReason, inline: false },
        );
    }

    embed.setFooter({ text: `处罚ID: ${punishmentId || '未知'}` });
    return embed;
}

// Only explicit original operations may consult archive configuration.
async function sendAnnouncement(client, guildId, payload) {
    let publicIds = [];
    let archiveIds = [];
    try { publicIds = getAnnouncementChannels(guildId) || []; }
    catch (err) { console.error(`[Punishment] 查询公告频道失败 guild=${guildId}:`, err); }
    if (payload.fromSync === false) {
        try { archiveIds = getArchiveChannels(guildId) || []; }
        catch (err) { console.error(`[Punishment] 查询留痕频道失败 guild=${guildId}:`, err); }
    }
    const channelIds = new Set([...publicIds, ...archiveIds]);
    if (channelIds.size === 0) return;
    try {
        const targetUser = await client.users.fetch(payload.targetUserId).catch(() => null);
        const embed = buildAnnouncementEmbed({ ...payload, targetAvatarUrl: targetUser?.displayAvatarURL({ size: 256 }) });
        for (const channelId of channelIds) {
            try {
                const channel = await client.channels.fetch(channelId);
                if (!channel || !channel.isTextBased()) {
                    console.warn(`[Punishment] 公告/留痕频道不可用 guild=${guildId} channel=${channelId}`);
                    continue;
                }
                await channel.send({ embeds: [embed] });
            } catch (err) {
                console.error(`[Punishment] 发送公告/留痕失败 guild=${guildId} channel=${channelId}:`, err.message);
            }
        }
    } catch (err) {
        console.error(`[Punishment] 构建处罚公告失败 guild=${guildId}:`, err);
    }
}

module.exports = { sendAnnouncement };
