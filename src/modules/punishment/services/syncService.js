const { sendAnnouncement } = require('./punishmentAnnouncement');
const {
    findLatestActivePunishment,
    getSyncTargets,
    getWarnRoleForGuild,
    insertPunishmentRecord,
} = require('./punishmentDatabase');

/**
 * 跨服务器同步封禁
 */
async function syncBan(client, sourceGuildId, userId, reason, announcement = {}) {
    const targets = getSyncTargets(sourceGuildId).filter(t => t.sync_ban);
    const results = [];

    for (const target of targets) {
        try {
            const guild = await client.guilds.fetch(target.target_guild_id).catch(() => null);
            if (!guild) {
                results.push({ guildId: target.target_guild_id, success: false, error: '无法获取服务器' });
                continue;
            }
            await guild.members.ban(userId, { reason: `[跨服同步] ${reason || ''}` });
            const recordResult = insertPunishmentRecord({
                guildId: target.target_guild_id,
                targetUserId: userId,
                executorId: 'SYNC',
                type: 'ban',
                reason: `[跨服同步] ${reason || ''}`,
            });
            await sendAnnouncement(client, guild.id, {
                type: 'ban', targetUserId: userId,
                executorId: announcement.executorId || client.user?.id,
                reason: `[跨服同步] ${reason || ''}`,
                punishmentId: String(recordResult.lastInsertRowid),
                scopeGuildNames: guild.name,
                fromSync: true,
            });
            results.push({ guildId: target.target_guild_id, guildName: guild.name, success: true });
        } catch (err) {
            console.error(`[Punishment] 跨服封禁失败 target=${target.target_guild_id}:`, err.message);
            results.push({ guildId: target.target_guild_id, success: false, error: err.message });
        }
    }

    return results;
}

/**
 * 跨服务器同步解封
 */
async function syncUnban(client, sourceGuildId, userId, reason, announcement = {}) {
    const targets = getSyncTargets(sourceGuildId).filter(t => t.sync_ban);
    const results = [];

    for (const target of targets) {
        try {
            const guild = await client.guilds.fetch(target.target_guild_id).catch(() => null);
            if (!guild) {
                results.push({ guildId: target.target_guild_id, success: false, error: '无法获取服务器' });
                continue;
            }
            await guild.members.unban(userId, `[跨服同步] ${reason || ''}`);
            let originalPunishment = null;
            try { originalPunishment = findLatestActivePunishment(guild.id, userId, 'ban'); }
            catch (err) { console.warn('[Punishment] 查询同步原处罚失败:', err.message); }
            const recordResult = insertPunishmentRecord({
                guildId: target.target_guild_id,
                targetUserId: userId,
                executorId: 'SYNC',
                type: 'unban',
                reason: `[跨服同步] ${reason || ''}`,
            });
            await sendAnnouncement(client, guild.id, {
                type: 'unban', targetUserId: userId,
                executorId: announcement.executorId || client.user?.id,
                reason: `[跨服同步] ${reason || ''}`,
                punishmentId: String(recordResult.lastInsertRowid),
                scopeGuildNames: guild.name,  originalPunishment,
                fromSync: true,
            });
            results.push({ guildId: target.target_guild_id, guildName: guild.name, success: true });
        } catch (err) {
            console.error(`[Punishment] 跨服解封失败 target=${target.target_guild_id}:`, err.message);
            results.push({ guildId: target.target_guild_id, success: false, error: err.message });
        }
    }

    return results;
}

/**
 * 跨服务器同步禁言
 */
async function syncMute(client, sourceGuildId, userId, durationMs, reason, announcement = {}) {
    const targets = getSyncTargets(sourceGuildId).filter(t => t.sync_mute);
    const results = [];
    const MAX_TIMEOUT_MS = 28 * 24 * 3600 * 1000;

    for (const target of targets) {
        try {
            const guild = await client.guilds.fetch(target.target_guild_id).catch(() => null);
            if (!guild) {
                results.push({ guildId: target.target_guild_id, success: false, error: '无法获取服务器' });
                continue;
            }
            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member) {
                results.push({ guildId: target.target_guild_id, success: false, error: '用户不在服务器中' });
                continue;
            }
            const cappedMs = Math.min(durationMs, MAX_TIMEOUT_MS);
            await member.timeout(cappedMs, `[跨服同步] ${reason || ''}`);
            const expiresAt = new Date(Date.now() + cappedMs).toISOString();
            const recordResult = insertPunishmentRecord({
                guildId: target.target_guild_id,
                targetUserId: userId,
                executorId: 'SYNC',
                type: 'mute',
                reason: `[跨服同步] ${reason || ''}`,
                durationMs: cappedMs,
                expiresAt,
            });
            const payload = {
                type: 'mute', targetUserId: userId,
                executorId: announcement.executorId || client.user?.id,
                reason: `[跨服同步] ${reason || ''}`,
                punishmentId: String(recordResult.lastInsertRowid),
                scopeGuildNames: guild.name, durationLabel: announcement.durationLabel || `${cappedMs / 1000}秒`,
                fromSync: true,
            };
            if (announcement.pending) announcement.pending.push({ guildId: guild.id, payload });
            else await sendAnnouncement(client, guild.id, payload);
            results.push({ guildId: target.target_guild_id, guildName: guild.name, success: true });
        } catch (err) {
            console.error(`[Punishment] 跨服禁言失败 target=${target.target_guild_id}:`, err.message);
            results.push({ guildId: target.target_guild_id, success: false, error: err.message });
        }
    }

    return results;
}

/**
 * 跨服务器同步警告身份组
 */
async function syncWarnRole(client, sourceGuildId, userId, durationMs, reason, announcement = {}) {
    const targets = getSyncTargets(sourceGuildId).filter(t => t.sync_warn_role);
    const results = [];

    for (const target of targets) {
        try {
            const guild = await client.guilds.fetch(target.target_guild_id).catch(() => null);
            if (!guild) {
                results.push({ guildId: target.target_guild_id, success: false, error: '无法获取服务器' });
                continue;
            }
            const warnRoleId = getWarnRoleForGuild(target.target_guild_id);
            if (!warnRoleId) {
                results.push({ guildId: target.target_guild_id, success: false, error: '未配置警告身份组' });
                continue;
            }
            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member) {
                results.push({ guildId: target.target_guild_id, success: false, error: '用户不在服务器中' });
                continue;
            }
            await member.roles.add(warnRoleId, `[跨服同步] ${reason || ''}`);
            const expiresAt = new Date(Date.now() + durationMs).toISOString();
            const recordResult = insertPunishmentRecord({
                guildId: target.target_guild_id,
                targetUserId: userId,
                executorId: 'SYNC',
                type: 'warn_role',
                reason: `[跨服同步] ${reason || ''}`,
                durationMs,
                expiresAt,
            });
            if (!announcement.coveredGuildIds?.has(guild.id)) await sendAnnouncement(client, guild.id, {
                type: 'warn_role', targetUserId: userId,
                executorId: announcement.executorId || client.user?.id,
                reason: `[跨服同步] ${reason || ''}`,
                punishmentId: String(recordResult.lastInsertRowid),
                scopeGuildNames: guild.name, durationLabel: announcement.durationLabel || `${durationMs / 1000}秒`,
                fromSync: true,
            });
            results.push({ guildId: target.target_guild_id, guildName: guild.name, success: true });
        } catch (err) {
            console.error(`[Punishment] 跨服警告身份组失败 target=${target.target_guild_id}:`, err.message);
            results.push({ guildId: target.target_guild_id, success: false, error: err.message });
        }
    }

    return results;
}

/**
 * 跨服务器同步解除禁言
 */
async function syncUnmute(client, sourceGuildId, userId, reason, announcement = {}) {
    const targets = getSyncTargets(sourceGuildId).filter(t => t.sync_mute);
    const results = [];

    for (const target of targets) {
        try {
            const guild = await client.guilds.fetch(target.target_guild_id).catch(() => null);
            if (!guild) {
                results.push({ guildId: target.target_guild_id, success: false, error: '无法获取服务器' });
                continue;
            }
            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member) {
                results.push({ guildId: target.target_guild_id, success: false, error: '用户不在服务器中' });
                continue;
            }
            await member.timeout(null, `[跨服同步] ${reason || ''}`);

            const warnRoleId = getWarnRoleForGuild(target.target_guild_id);
            if (warnRoleId && member.roles.cache.has(warnRoleId)) {
                try {
                    await member.roles.remove(warnRoleId, `[跨服同步] 解除禁言时同步移除警告身份组`);
                } catch (err) {
                    console.warn(`[Punishment] 跨服解除禁言后移除警告身份组失败 target=${target.target_guild_id}:`, err.message);
                }
            }

            let originalPunishment = null;
            try { originalPunishment = findLatestActivePunishment(guild.id, userId, 'mute'); }
            catch (err) { console.warn('[Punishment] 查询同步原处罚失败:', err.message); }
            const recordResult = insertPunishmentRecord({
                guildId: target.target_guild_id,
                targetUserId: userId,
                executorId: 'SYNC',
                type: 'unmute',
                reason: `[跨服同步] ${reason || ''}`,
            });
            await sendAnnouncement(client, guild.id, {
                type: 'unmute', targetUserId: userId,
                executorId: announcement.executorId || client.user?.id,
                reason: `[跨服同步] ${reason || ''}`,
                punishmentId: String(recordResult.lastInsertRowid),
                scopeGuildNames: guild.name,  originalPunishment,
                fromSync: true,
            });
            results.push({ guildId: target.target_guild_id, guildName: guild.name, success: true });
        } catch (err) {
            console.error(`[Punishment] 跨服解除禁言失败 target=${target.target_guild_id}:`, err.message);
            results.push({ guildId: target.target_guild_id, success: false, error: err.message });
        }
    }

    return results;
}

module.exports = { syncBan, syncUnban, syncMute, syncWarnRole, syncUnmute };
