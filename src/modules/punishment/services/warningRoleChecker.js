const {
    getActiveExpirablePunishments,
    markPunishmentExpired,
    getWarnRoleForGuild,
} = require('./punishmentDatabase');

const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 分钟

/**
 * 检查并移除所有过期的警告身份组
 */
async function checkExpiredWarningRoles(client) {
    try {
        const now = new Date().toISOString();
        const records = getActiveExpirablePunishments('warn_role');
        const expired = records.filter(r => r.expires_at <= now);

        if (expired.length === 0) return;

        console.log(`[Punishment] 发现 ${expired.length} 个到期的警告身份组记录`);

        for (const record of expired) {
            try {
                const guild = await client.guilds.fetch(record.guild_id).catch(() => null);
                if (!guild) {
                    markPunishmentExpired(record.id);
                    continue;
                }

                const member = await guild.members.fetch(record.target_user_id).catch(() => null);
                if (!member) {
                    // 用户已离开服务器，直接标记过期
                    markPunishmentExpired(record.id);
                    continue;
                }

                const warnRoleId = getWarnRoleForGuild(record.guild_id);
                if (warnRoleId && member.roles.cache.has(warnRoleId)) {
                    await member.roles.remove(warnRoleId, '警告身份组已到期自动移除');
                    console.log(`[Punishment] ✅ 已移除用户 ${record.target_user_id} 在服务器 ${record.guild_id} 的警告身份组`);
                }

                markPunishmentExpired(record.id);
            } catch (err) {
                console.error(`[Punishment] 移除警告身份组出错 id=${record.id}:`, err.message);
            }
        }
    } catch (err) {
        console.error('[Punishment] 检查过期警告身份组出错:', err);
    }
}

/**
 * 启动警告身份组过期检查器
 */
function startWarningRoleChecker(client) {
    console.log(`[Punishment] 启动警告身份组检查器，间隔: ${CHECK_INTERVAL_MS / 1000 / 60} 分钟`);

    // 立即检查一次
    checkExpiredWarningRoles(client);

    // 定时检查
    setInterval(() => {
        checkExpiredWarningRoles(client);
    }, CHECK_INTERVAL_MS);
}

module.exports = { startWarningRoleChecker };
