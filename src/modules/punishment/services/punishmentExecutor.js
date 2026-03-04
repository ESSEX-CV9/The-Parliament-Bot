const { EmbedBuilder } = require('discord.js');
const {
    insertPunishmentRecord,
    getWarnRoleForGuild,
    getAnnouncementChannels,
    findLatestActivePunishment,
} = require('./punishmentDatabase');
const { syncBan, syncUnban, syncMute, syncWarnRole, syncUnmute } = require('./syncService');

const MAX_TIMEOUT_MS = 28 * 24 * 3600 * 1000; // Discord timeout 上限 28 天

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

const TYPE_LABELS = {
    ban: '永久封禁',
    unban: '解除封禁',
    mute: '禁言',
    warn_role: '警告处罚',
    unmute: '解除禁言',
};

// ========== 公告辅助 ==========

function clampText(text, maxLen = 1024) {
    const normalized = (text || '').trim() || '未说明';
    if (normalized.length <= maxLen) return normalized;
    return normalized.slice(0, Math.max(1, maxLen - 1)) + '…';
}

function toPunishmentId(insertResult) {
    if (!insertResult || insertResult.lastInsertRowid == null) return '未知';
    return String(insertResult.lastInsertRowid);
}

function buildScopeGuildNames(guild, syncResults) {
    const nameSet = new Set();
    if (guild?.name) nameSet.add(guild.name);

    if (Array.isArray(syncResults)) {
        for (const item of syncResults) {
            if (item?.success && item.guildName) {
                nameSet.add(item.guildName);
            }
        }
    }

    if (nameSet.size === 0) return '当前服务器';
    return Array.from(nameSet).join('、');
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

// ========== 公告 ==========

async function sendAnnouncement(client, guildId, payload) {
    const channelIds = getAnnouncementChannels(guildId);
    if (!channelIds || channelIds.length === 0) return;

    try {
        const targetUser = await client.users.fetch(payload.targetUserId).catch(() => null);
        const targetAvatarUrl = targetUser?.displayAvatarURL({ size: 256 });

        const embed = buildAnnouncementEmbed({
            ...payload,
            targetAvatarUrl,
        });

        for (const channelId of channelIds) {
            try {
                const channel = await client.channels.fetch(channelId).catch(() => null);
                if (!channel || !channel.isTextBased()) {
                    console.warn(`[Punishment] 公告频道不可用 guild=${guildId} channel=${channelId}`);
                    continue;
                }

                await channel.send({ embeds: [embed] });
            } catch (err) {
                console.error(`[Punishment] 发送公告失败 guild=${guildId} channel=${channelId}:`, err.message);
            }
        }
    } catch (err) {
        console.error(`[Punishment] 构建处罚公告失败 guild=${guildId}:`, err);
    }
}

function formatSyncResults(results) {
    if (!results || results.length === 0) return '';
    const lines = results.map(r => {
        if (r.success) return `✅ ${r.guildName || r.guildId}`;
        return `❌ ${r.guildId}: ${r.error}`;
    });
    return '\n**跨服同步结果：**\n' + lines.join('\n');
}

// ========== 封禁 ==========

async function executeBan(client, interaction, { targetUser, reason, sync }) {
    const guild = interaction.guild;

    try {
        await guild.members.ban(targetUser.id, { reason: reason || undefined });
    } catch (err) {
        await interaction.editReply(`❌ 封禁失败: ${err.message}`);
        return;
    }

    const recordResult = insertPunishmentRecord({
        guildId: guild.id,
        targetUserId: targetUser.id,
        executorId: interaction.user.id,
        type: 'ban',
        reason,
    });
    const punishmentId = toPunishmentId(recordResult);

    let syncResults = [];
    if (sync) {
        syncResults = await syncBan(client, guild.id, targetUser.id, reason);
    }

    await sendAnnouncement(client, guild.id, {
        type: 'ban',
        targetUserId: targetUser.id,
        executorId: interaction.user.id,
        reason,
        punishmentId,
        scopeGuildNames: buildScopeGuildNames(guild, syncResults),
    });

    await interaction.editReply(
        `✅ 已封禁用户 <@${targetUser.id}> (\`${targetUser.id}\`)` +
        (reason ? `\n原因: ${reason}` : '') +
        formatSyncResults(syncResults)
    );
}

// ========== 解封 ==========

async function executeUnban(client, interaction, { userId, reason, sync }) {
    const guild = interaction.guild;

    try {
        await guild.members.unban(userId, reason || undefined);
    } catch (err) {
        await interaction.editReply(`❌ 解封失败: ${err.message}`);
        return;
    }

    let originalPunishment = null;
    try {
        originalPunishment = findLatestActivePunishment(guild.id, userId, 'ban');
    } catch (err) {
        console.warn(`[Punishment] 查找原封禁记录失败 guild=${guild.id} user=${userId}: ${err.message}`);
    }

    const recordResult = insertPunishmentRecord({
        guildId: guild.id,
        targetUserId: userId,
        executorId: interaction.user.id,
        type: 'unban',
        reason,
    });
    const punishmentId = toPunishmentId(recordResult);

    let syncResults = [];
    if (sync) {
        syncResults = await syncUnban(client, guild.id, userId, reason);
    }

    await sendAnnouncement(client, guild.id, {
        type: 'unban',
        targetUserId: userId,
        executorId: interaction.user.id,
        reason,
        punishmentId,
        originalPunishment,
        scopeGuildNames: buildScopeGuildNames(guild, syncResults),
    });

    await interaction.editReply(
        `✅ 已解封用户 \`${userId}\`` +
        (reason ? `\n原因: ${reason}` : '') +
        formatSyncResults(syncResults)
    );
}

// ========== 禁言 ==========

async function executeMute(client, interaction, { targetMember, durationMs, durationLabel, reason, warnDuration, sync }) {
    const guild = interaction.guild;

    if (durationMs > MAX_TIMEOUT_MS) {
        await interaction.editReply('❌ 禁言时长不能超过 28 天');
        return;
    }

    try {
        await targetMember.timeout(durationMs, reason || undefined);
    } catch (err) {
        await interaction.editReply(`❌ 禁言失败: ${err.message}`);
        return;
    }

    const expiresAt = new Date(Date.now() + durationMs).toISOString();
    const recordResult = insertPunishmentRecord({
        guildId: guild.id,
        targetUserId: targetMember.id,
        executorId: interaction.user.id,
        type: 'mute',
        reason,
        durationMs,
        expiresAt,
    });
    const punishmentId = toPunishmentId(recordResult);

    let warnRoleAdded = false;
    if (warnDuration) {
        const warnResult = await addWarnRoleToMember(client, guild, targetMember, warnDuration.ms, warnDuration.label, reason, interaction.user.id);
        warnRoleAdded = warnResult.success;
    }

    let syncResults = [];
    if (sync) {
        syncResults = await syncMute(client, guild.id, targetMember.id, durationMs, reason);
        if (warnDuration) {
            const warnSyncResults = await syncWarnRole(client, guild.id, targetMember.id, warnDuration.ms, reason);
            syncResults = syncResults.concat(warnSyncResults.map(r => ({ ...r, note: '警告身份组' })));
        }
    }

    await sendAnnouncement(client, guild.id, {
        type: 'mute',
        targetUserId: targetMember.id,
        executorId: interaction.user.id,
        reason,
        punishmentId,
        durationLabel,
        warnDurationLabel: warnDuration?.label || null,
        scopeGuildNames: buildScopeGuildNames(guild, syncResults),
    });

    await interaction.editReply(
        `✅ 已禁言用户 <@${targetMember.id}> (\`${targetMember.id}\`)\n` +
        `时长: ${durationLabel}` +
        (warnRoleAdded ? `\n已同时添加警告身份组 (${warnDuration.label})` : '') +
        (reason ? `\n原因: ${reason}` : '') +
        formatSyncResults(syncResults)
    );
}

// ========== 警告身份组 ==========

async function executeWarnRole(client, interaction, { targetMember, durationMs, durationLabel, reason, sync }) {
    const guild = interaction.guild;

    const warnResult = await addWarnRoleToMember(client, guild, targetMember, durationMs, durationLabel, reason, interaction.user.id);
    if (!warnResult.success) {
        await interaction.editReply('❌ 本服务器未配置警告身份组，请先使用 `/处罚 配置警告身份组` 进行设置');
        return;
    }

    let syncResults = [];
    if (sync) {
        syncResults = await syncWarnRole(client, guild.id, targetMember.id, durationMs, reason);
    }

    await sendAnnouncement(client, guild.id, {
        type: 'warn_role',
        targetUserId: targetMember.id,
        executorId: interaction.user.id,
        reason,
        punishmentId: warnResult.punishmentId,
        durationLabel,
        scopeGuildNames: buildScopeGuildNames(guild, syncResults),
    });

    await interaction.editReply(
        `✅ 已为用户 <@${targetMember.id}> 添加警告身份组\n` +
        `时长: ${durationLabel}` +
        (reason ? `\n原因: ${reason}` : '') +
        formatSyncResults(syncResults)
    );
}

/**
 * 内部辅助：为成员添加警告身份组并写入 DB
 * @returns {{ success: boolean, punishmentId: string | null }}
 */
async function addWarnRoleToMember(client, guild, targetMember, durationMs, durationLabel, reason, executorId) {
    const warnRoleId = getWarnRoleForGuild(guild.id);
    if (!warnRoleId) return { success: false, punishmentId: null };

    try {
        await targetMember.roles.add(warnRoleId, reason || undefined);
    } catch (err) {
        console.error('[Punishment] 添加警告身份组失败:', err);
        return { success: false, punishmentId: null };
    }

    const expiresAt = new Date(Date.now() + durationMs).toISOString();
    const recordResult = insertPunishmentRecord({
        guildId: guild.id,
        targetUserId: targetMember.id,
        executorId,
        type: 'warn_role',
        reason,
        durationMs,
        expiresAt,
    });

    return {
        success: true,
        punishmentId: toPunishmentId(recordResult),
    };
}

// ========== 解除禁言 ==========

async function executeUnmute(client, interaction, { targetMember, reason, sync }) {
    const guild = interaction.guild;

    try {
        await targetMember.timeout(null, reason || undefined);
    } catch (err) {
        await interaction.editReply(`❌ 解除禁言失败: ${err.message}`);
        return;
    }

    let warnRoleRemoved = false;
    const warnRoleId = getWarnRoleForGuild(guild.id);
    if (warnRoleId && targetMember.roles.cache.has(warnRoleId)) {
        try {
            await targetMember.roles.remove(warnRoleId, reason || '解除禁言时同步移除警告身份组');
            warnRoleRemoved = true;
        } catch (err) {
            console.warn(
                `[Punishment] 解除禁言后移除警告身份组失败 guild=${guild.id} user=${targetMember.id}: ${err.message}`
            );
        }
    }

    let originalPunishment = null;
    try {
        originalPunishment = findLatestActivePunishment(guild.id, targetMember.id, 'mute');
    } catch (err) {
        console.warn(`[Punishment] 查找原禁言记录失败 guild=${guild.id} user=${targetMember.id}: ${err.message}`);
    }

    const recordResult = insertPunishmentRecord({
        guildId: guild.id,
        targetUserId: targetMember.id,
        executorId: interaction.user.id,
        type: 'unmute',
        reason,
    });
    const punishmentId = toPunishmentId(recordResult);

    let syncResults = [];
    if (sync) {
        syncResults = await syncUnmute(client, guild.id, targetMember.id, reason);
    }

    await sendAnnouncement(client, guild.id, {
        type: 'unmute',
        targetUserId: targetMember.id,
        executorId: interaction.user.id,
        reason,
        punishmentId,
        originalPunishment,
        scopeGuildNames: buildScopeGuildNames(guild, syncResults),
    });

    await interaction.editReply(
        `✅ 已解除用户 <@${targetMember.id}> 的禁言` +
        (warnRoleRemoved ? '\n已同时移除警告身份组' : '') +
        (reason ? `\n原因: ${reason}` : '') +
        formatSyncResults(syncResults)
    );
}

module.exports = {
    executeBan,
    executeUnban,
    executeMute,
    executeWarnRole,
    executeUnmute,
};
