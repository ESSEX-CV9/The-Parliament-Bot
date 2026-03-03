const {
    getSyncTargets,
    getWarnRoleForGuild,
    insertPunishmentRecord,
} = require('./punishmentDatabase');

/**
 * 跨服务器同步封禁
 */
async function syncBan(client, sourceGuildId, userId, reason) {
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
            insertPunishmentRecord({
                guildId: target.target_guild_id,
                targetUserId: userId,
                executorId: 'SYNC',
                type: 'ban',
                reason: `[跨服同步] ${reason || ''}`,
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
async function syncUnban(client, sourceGuildId, userId, reason) {
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
            insertPunishmentRecord({
                guildId: target.target_guild_id,
                targetUserId: userId,
                executorId: 'SYNC',
                type: 'unban',
                reason: `[跨服同步] ${reason || ''}`,
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
async function syncMute(client, sourceGuildId, userId, durationMs, reason) {
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
            insertPunishmentRecord({
                guildId: target.target_guild_id,
                targetUserId: userId,
                executorId: 'SYNC',
                type: 'mute',
                reason: `[跨服同步] ${reason || ''}`,
                durationMs: cappedMs,
                expiresAt,
            });
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
async function syncWarnRole(client, sourceGuildId, userId, durationMs, reason) {
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
            insertPunishmentRecord({
                guildId: target.target_guild_id,
                targetUserId: userId,
                executorId: 'SYNC',
                type: 'warn_role',
                reason: `[跨服同步] ${reason || ''}`,
                durationMs,
                expiresAt,
            });
            results.push({ guildId: target.target_guild_id, guildName: guild.name, success: true });
        } catch (err) {
            console.error(`[Punishment] 跨服警告身份组失败 target=${target.target_guild_id}:`, err.message);
            results.push({ guildId: target.target_guild_id, success: false, error: err.message });
        }
    }

    return results;
}

module.exports = { syncBan, syncUnban, syncMute, syncWarnRole };
