// 冷却按「服务器 + 用户 + 游戏」计数：个人游戏冷却全服生效，换频道不能绕过；
// 时长仍由本局实际所在频道解析出来的设置决定（见 services/channelAccessService.js）。
const DEFAULT_COOLDOWN_DURATION_MS = 30 * 60 * 1000;

// 靠读取时的惰性删除清不干净，所以每写入 SWEEP_INTERVAL_WRITES 次就整体扫一遍过期项。
const SWEEP_INTERVAL_WRITES = 200;

const cooldowns = new Map();
const inFlight = new Set();
let writesSinceSweep = 0;

function buildCooldownKey(guildId, userId, subcommand) {
    return `${guildId}:${userId}:${subcommand}`;
}

// 并发锁与冷却同范围：同一个人同一个游戏，任何频道都只允许有一次正在处理中的调用。
function buildInFlightKey(guildId, userId, subcommand) {
    return `${guildId}:${userId}:${subcommand}`;
}

function sweepExpired(now) {
    for (const [key, expiresAt] of cooldowns) {
        if (expiresAt <= now) cooldowns.delete(key);
    }
}

function getCooldownExpiresAt(guildId, userId, subcommand, now = Date.now()) {
    const key = buildCooldownKey(guildId, userId, subcommand);
    const expiresAt = cooldowns.get(key);

    if (expiresAt === undefined) {
        return null;
    }

    if (expiresAt <= now) {
        cooldowns.delete(key);
        return null;
    }

    return expiresAt;
}

function isOnCooldown(guildId, userId, subcommand, now = Date.now()) {
    return getCooldownExpiresAt(guildId, userId, subcommand, now) !== null;
}

/**
 * @param {number} durationMs 该频道解析出来的冷却时长；0 表示不进冷却。
 * @returns {number|null} 冷却到期时间戳；durationMs 为 0 时返回 null。
 */
function startCooldown(
    guildId,
    userId,
    subcommand,
    durationMs = DEFAULT_COOLDOWN_DURATION_MS,
    now = Date.now()
) {
    const duration = Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0;
    if (duration === 0) return null;

    const key = buildCooldownKey(guildId, userId, subcommand);
    const expiresAt = now + duration;
    cooldowns.set(key, expiresAt);

    if (++writesSinceSweep >= SWEEP_INTERVAL_WRITES) {
        writesSinceSweep = 0;
        sweepExpired(now);
    }

    return expiresAt;
}

function acquireInFlight(guildId, userId, subcommand) {
    const key = buildInFlightKey(guildId, userId, subcommand);

    if (inFlight.has(key)) {
        return false;
    }

    inFlight.add(key);
    return true;
}

function releaseInFlight(guildId, userId, subcommand) {
    const key = buildInFlightKey(guildId, userId, subcommand);
    inFlight.delete(key);
}

function resetStateForTests() {
    cooldowns.clear();
    inFlight.clear();
    writesSinceSweep = 0;
}

module.exports = {
    DEFAULT_COOLDOWN_DURATION_MS,
    SWEEP_INTERVAL_WRITES,
    buildCooldownKey,
    buildInFlightKey,
    getCooldownExpiresAt,
    isOnCooldown,
    startCooldown,
    acquireInFlight,
    releaseInFlight,
    resetStateForTests,
};
