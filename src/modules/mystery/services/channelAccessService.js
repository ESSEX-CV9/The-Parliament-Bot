// 神秘指令的三层设置解析。
//
//   L1 服务器默认      —— allowed / cooldownMs 一定有值，兜底整条链
//   L2 文字频道 / 论坛 —— 每个字段可空，空则继承 L1
//   L3 子区 / 论坛帖子 —— 每个字段可空，空则继承 L2、再继承 L1
//
// 分类（Category）不参与继承：文字频道的 parentId 是分类，只有子区/帖子的
// parentId 才是上一层，所以链条只在 isThread() 时才往上多走一级。
const SETTING_LEVELS = Object.freeze({
    THREAD: 'thread',
    CHANNEL: 'channel',
    GUILD: 'guild',
});

const SETTING_LEVEL_LABELS = Object.freeze({
    [SETTING_LEVELS.THREAD]: '子区/帖子',
    [SETTING_LEVELS.CHANNEL]: '频道',
    [SETTING_LEVELS.GUILD]: '服务器默认',
});

function isThreadChannel(channel) {
    if (!channel) return false;
    if (typeof channel.isThread === 'function') return channel.isThread() === true;
    return false;
}

function emptyOverride() {
    return { allowed: null, cooldownMs: null, gameCooldownMs: {} };
}

/**
 * 构造从当前频道到服务器默认的继承链，最具体的排在最前面。
 * @returns {Array<{level: string, channelId: string|null, config: object, configured: boolean}>}
 */
function buildSettingLevels(channel, guildConfig = {}) {
    const overrides = guildConfig.overrides || {};
    const levels = [];

    function pushOverride(level, channelId) {
        if (typeof channelId !== 'string' || channelId.length === 0) return;
        const config = overrides[channelId] || null;
        levels.push({
            level,
            channelId,
            config: config || emptyOverride(),
            configured: Boolean(config),
        });
    }

    if (isThreadChannel(channel)) {
        pushOverride(SETTING_LEVELS.THREAD, channel.id);
        pushOverride(SETTING_LEVELS.CHANNEL, channel.parentId);
    } else if (channel) {
        pushOverride(SETTING_LEVELS.CHANNEL, channel.id);
    }

    levels.push({
        level: SETTING_LEVELS.GUILD,
        channelId: null,
        config: guildConfig.default || { allowed: true, cooldownMs: 0, gameCooldownMs: {} },
        configured: true,
    });

    return levels;
}

function resolveAllowed(levels) {
    for (const entry of levels) {
        if (typeof entry.config.allowed === 'boolean') {
            return { allowed: entry.config.allowed, source: entry };
        }
    }
    return { allowed: true, source: levels[levels.length - 1] };
}

/**
 * 逐级向上，每一级先看该游戏的专属 CD，再看该级的统一 CD，第一个命中的生效。
 *
 * 这样「帖主把本帖统一设成 60 分钟」不会被服务器层某个游戏的专属值穿透，
 * 而「频道只单独调了传炸弹」也不会影响其他游戏继续继承服务器的统一值。
 */
function resolveCooldownMs(levels, gameName) {
    for (const entry of levels) {
        const perGame = entry.config.gameCooldownMs?.[gameName];
        if (Number.isFinite(perGame)) {
            return { cooldownMs: perGame, source: entry, perGame: true };
        }
        if (Number.isFinite(entry.config.cooldownMs)) {
            return { cooldownMs: entry.config.cooldownMs, source: entry, perGame: false };
        }
    }
    const fallback = levels[levels.length - 1];
    return { cooldownMs: 0, source: fallback, perGame: false };
}

/**
 * 解析当前频道生效的神秘指令设置。
 * @returns {{
 *   allowed: boolean,
 *   allowedSource: object,
 *   levels: Array<object>,
 *   cooldownFor: (gameName: string) => {cooldownMs: number, source: object, perGame: boolean},
 * }}
 */
function resolveMysterySettings(channel, guildConfig = {}) {
    const levels = buildSettingLevels(channel, guildConfig);
    const { allowed, source } = resolveAllowed(levels);

    return {
        allowed,
        allowedSource: source,
        levels,
        cooldownFor: gameName => resolveCooldownMs(levels, gameName),
    };
}

/**
 * 当前频道属于继承链上的哪一层 —— 决定谁有权改它。
 * 子区/帖子这一层允许子区主、帖主自己改；频道层只有管理员能改。
 */
function levelOfChannel(channel) {
    if (isThreadChannel(channel)) return SETTING_LEVELS.THREAD;
    if (channel) return SETTING_LEVELS.CHANNEL;
    return null;
}

function formatCooldown(cooldownMs) {
    if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) return '无冷却';
    const totalSeconds = Math.round(cooldownMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) return `${seconds} 秒`;
    if (seconds === 0) return `${minutes} 分钟`;
    return `${minutes} 分 ${seconds} 秒`;
}

function describeSource(entry) {
    if (!entry) return '未知';
    if (entry.level === SETTING_LEVELS.GUILD) return SETTING_LEVEL_LABELS[SETTING_LEVELS.GUILD];
    return `${SETTING_LEVEL_LABELS[entry.level]} <#${entry.channelId}>`;
}

module.exports = {
    SETTING_LEVELS,
    SETTING_LEVEL_LABELS,
    buildSettingLevels,
    resolveAllowed,
    resolveCooldownMs,
    resolveMysterySettings,
    levelOfChannel,
    formatCooldown,
    describeSource,
};
