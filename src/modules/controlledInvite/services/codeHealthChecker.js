const {
    getActiveNotExpiringSoon,
    getSuspectRequests,
    markRequestSuspect,
    markRequestMisused,
    markSuspectConsumed,
    markRequestConsumed,
    getConfig,
    addToBlacklist,
} = require('../utils/controlledInviteDatabase');
const { sendLog } = require('../services/inviteService');

let checkerInterval = null;

const BUFFER_SECONDS = 90; // 安全缓冲区：只检查离过期还有至少 90 秒的码
const CHECKER_INTERVAL_MS = 3 * 60 * 1000; // 每 3 分钟
const GRACE_PERIOD_MS = 5 * 60 * 1000; // 二次确认：expires_at + 5 分钟

/**
 * 码健康巡检 —— 链路 2（异步定时任务）
 * 只关心"码的状态"，用于追责码主。与入服处理完全解耦。
 *
 * 流程：
 * 1. 扫描所有 active 且离过期还有 >=90 秒的码
 * 2. 向 Discord 查询码是否仍存在
 * 3. 码消失 + 码主在分服 → consumed
 * 4. 码消失 + 码主不在分服 → suspect（等待二次确认）
 *
 * 5. 扫描所有 suspect 记录
 * 6. 如果当前时间 > expires_at + 5 分钟：
 *    - 码主在分服 → consumed
 *    - 码主仍不在 → misused，拉黑码主
 */
async function runCodeHealthCheck(client) {
    try {
        // ===== 阶段一：检查 active 码 =====
        const activeRequests = getActiveNotExpiringSoon(BUFFER_SECONDS);

        for (const request of activeRequests) {
            try {
                const config = getConfig(request.main_guild_id, request.sub_guild_id);
                if (!config || !config.enabled) continue;

                // 查询 Discord 该邀请码是否仍存在
                const subGuild = await client.guilds.fetch(request.sub_guild_id).catch(() => null);
                if (!subGuild) continue;

                let inviteExists = false;
                try {
                    const invites = await subGuild.invites.fetch();
                    inviteExists = invites.has(request.invite_code);
                } catch {
                    // 无法获取邀请列表，跳过
                    continue;
                }

                if (inviteExists) continue; // 码还在，正常

                // 码消失了（离过期还有 >=90 秒，一定是被使用了）
                // 检查码主是否在分服中
                const ownerInSubGuild = await checkMemberInGuild(client, request.sub_guild_id, request.owner_user_id);

                if (ownerInSubGuild) {
                    // 码主在分服 → 合法使用
                    markRequestConsumed(request.id);
                    console.log(`[ControlledInvite] 🔍 巡检: 码 ${request.invite_code} 被码主正常使用`);
                } else {
                    // 码主不在分服 → 标记 suspect
                    markRequestSuspect(request.id);
                    console.log(`[ControlledInvite] 🔍 巡检: 码 ${request.invite_code} 疑似泄漏，标记 suspect`);
                    await sendLog(client, config,
                        `🟡 **码疑似泄漏**\n码主: <@${request.owner_user_id}>\n邀请码: \`${request.invite_code}\`\n码已消失但码主未在分服中，等待二次确认...`);
                }
            } catch (err) {
                console.error(`[ControlledInvite] 巡检单码出错 (${request.invite_code}):`, err);
            }
        }

        // ===== 阶段二：处理 suspect 记录 =====
        const suspectRequests = getSuspectRequests();

        for (const request of suspectRequests) {
            try {
                const config = getConfig(request.main_guild_id, request.sub_guild_id);
                if (!config) continue;

                // 检查是否已到二次确认时间 (expires_at + 5 分钟)
                const expiresAtMs = new Date(request.expires_at).getTime();
                const confirmTimeMs = expiresAtMs + GRACE_PERIOD_MS;

                if (Date.now() < confirmTimeMs) continue; // 还没到时间

                // 已到达确认时间，再次检查码主是否在分服
                const ownerInSubGuild = await checkMemberInGuild(client, request.sub_guild_id, request.owner_user_id);

                if (ownerInSubGuild) {
                    // 码主最终加入了 → consumed
                    markSuspectConsumed(request.id);
                    console.log(`[ControlledInvite] 🔍 二次确认: 码主 ${request.owner_user_id} 已加入分服，标记 consumed`);
                    await sendLog(client, config,
                        `✅ **码主已加入（二次确认通过）**\n码主: <@${request.owner_user_id}>\n邀请码: \`${request.invite_code}\``);
                } else {
                    // 码主仍不在 → 确认泄漏
                    const actionJson = JSON.stringify({ action: 'blacklist', reason: '邀请码被他人使用' });
                    markRequestMisused(request.id, actionJson);

                    if (config.blacklist_owner_on_misuse) {
                        addToBlacklist({
                            mainGuildId: request.main_guild_id,
                            userId: request.owner_user_id,
                            subGuildId: request.sub_guild_id,
                            reason: '邀请码被他人使用（系统自动检测）',
                            sourceRequestId: request.id,
                            createdBy: 'system',
                        });
                    }

                    console.log(`[ControlledInvite] 🔴 二次确认: 码 ${request.invite_code} 确认泄漏，码主 ${request.owner_user_id} 已拉黑`);
                    await sendLog(client, config,
                        `🔴 **确认码泄漏 - 码主已拉黑**\n码主: <@${request.owner_user_id}>\n邀请码: \`${request.invite_code}\`\n码被使用但码主始终未出现在分服中`);
                }
            } catch (err) {
                console.error(`[ControlledInvite] 处理 suspect 出错 (${request.invite_code}):`, err);
            }
        }
    } catch (err) {
        console.error('[ControlledInvite] 码健康巡检出错:', err);
    }
}

/**
 * 检查用户是否在指定服务器中
 */
async function checkMemberInGuild(client, guildId, userId) {
    try {
        const guild = await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) return false;
        const member = await guild.members.fetch(userId).catch(() => null);
        return !!member;
    } catch {
        return false;
    }
}

/**
 * 启动码健康巡检定时器
 */
function startCodeHealthChecker(client) {
    if (checkerInterval) {
        clearInterval(checkerInterval);
    }

    // 启动时立即执行一次
    setTimeout(() => runCodeHealthCheck(client), 5000);

    checkerInterval = setInterval(() => runCodeHealthCheck(client), CHECKER_INTERVAL_MS);
    console.log(`[ControlledInvite] ✅ 码健康巡检已启动（间隔 ${CHECKER_INTERVAL_MS / 1000}s，缓冲区 ${BUFFER_SECONDS}s）`);
}

/**
 * 停止码健康巡检定时器
 */
function stopCodeHealthChecker() {
    if (checkerInterval) {
        clearInterval(checkerInterval);
        checkerInterval = null;
    }
}

module.exports = { startCodeHealthChecker, stopCodeHealthChecker, runCodeHealthCheck };
