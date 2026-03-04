const {
    getExpiredActiveRequests,
    markRequestExpired,
    getAllConfigs,
} = require('../utils/controlledInviteDatabase');

let cleanupInterval = null;

const CLEANUP_INTERVAL_MS = 45 * 1000; // 每 45 秒

/**
 * 过期清理流程
 * 扫描 status='active' AND expires_at <= now 的记录
 * 尝试删除 Discord 邀请码，然后标记为 expired
 */
async function runCleanup(client) {
    try {
        const expiredRequests = getExpiredActiveRequests();
        if (expiredRequests.length === 0) return;

        for (const request of expiredRequests) {
            try {
                // 尝试删除 Discord 邀请码（可能已被使用或过期自动删除）
                try {
                    const subGuild = await client.guilds.fetch(request.sub_guild_id).catch(() => null);
                    if (subGuild) {
                        const invites = await subGuild.invites.fetch().catch(() => null);
                        if (invites) {
                            const invite = invites.get(request.invite_code);
                            if (invite) {
                                await invite.delete('受控邀请: 邀请码已过期').catch(() => {});
                            }
                        }
                    }
                } catch {
                    // 删除失败不影响流程
                }

                // 标记为 expired
                markRequestExpired(request.id);
            } catch (err) {
                console.error(`[ControlledInvite] 清理单码出错 (${request.invite_code}):`, err);
            }
        }

        if (expiredRequests.length > 0) {
            console.log(`[ControlledInvite] 🧹 已清理 ${expiredRequests.length} 个过期邀请码`);
        }
    } catch (err) {
        console.error('[ControlledInvite] 过期清理出错:', err);
    }
}

/**
 * 启动过期清理定时器
 */
function startCleanupScheduler(client) {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
    }

    // 启动时立即执行一次（清理 Bot 离线期间过期的码）
    setTimeout(() => runCleanup(client), 3000);

    cleanupInterval = setInterval(() => runCleanup(client), CLEANUP_INTERVAL_MS);
    console.log(`[ControlledInvite] ✅ 过期清理定时器已启动（间隔 ${CLEANUP_INTERVAL_MS / 1000}s）`);
}

/**
 * 停止过期清理定时器
 */
function stopCleanupScheduler() {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
    }
}

module.exports = { startCleanupScheduler, stopCleanupScheduler };
