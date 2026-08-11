const fs = require('node:fs/promises');
const path = require('node:path');
const { isMysteryGame } = require('./mysteryGames');

const STORE_VERSION = 2;
const LEGACY_STORE_VERSION = 1;

// 服务器默认层的兜底值：管理员没配过任何东西时就是这个。
// 允许 + 30 分钟，与 main 上线时的行为一致，合并后现有用户零感知。
const BUILTIN_DEFAULT_ALLOWED = true;
const BUILTIN_DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;

let temporaryFileSequence = 0;

function logFailure(operation, error) {
    console.error(`[channelAccessStore] ${operation} failed:`, error);
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSnowflake(value) {
    return typeof value === 'string' && /^[0-9]{5,32}$/.test(value);
}

// 冷却允许为 0（表示无冷却），上限 24 小时。非法值一律当作「未设置」。
function normalizeCooldownMs(value) {
    if (!Number.isFinite(value)) return null;
    const rounded = Math.round(value);
    if (rounded < 0 || rounded > MAX_COOLDOWN_MS) return null;
    return rounded;
}

function normalizeGameCooldownMs(value) {
    if (!isPlainObject(value)) return {};
    const normalized = {};
    for (const [gameName, cooldown] of Object.entries(value)) {
        if (!isMysteryGame(gameName)) continue;
        const cooldownMs = normalizeCooldownMs(cooldown);
        if (cooldownMs === null) continue;
        normalized[gameName] = cooldownMs;
    }
    return normalized;
}

// 服务器默认层：allowed 与 cooldownMs 必须有值，缺失/非法时回落到内建默认。
function normalizeDefaultConfig(value) {
    const source = isPlainObject(value) ? value : {};
    const cooldownMs = normalizeCooldownMs(source.cooldownMs);
    return {
        allowed: typeof source.allowed === 'boolean' ? source.allowed : BUILTIN_DEFAULT_ALLOWED,
        cooldownMs: cooldownMs === null ? BUILTIN_DEFAULT_COOLDOWN_MS : cooldownMs,
        gameCooldownMs: normalizeGameCooldownMs(source.gameCooldownMs),
    };
}

// 覆盖层：每个字段都可以是 null，表示「本层不覆盖，继续往上继承」。
// 三个字段全空的覆盖没有意义，返回 null 让调用方把它删掉。
function normalizeOverrideConfig(value) {
    if (!isPlainObject(value)) return null;
    const allowed = typeof value.allowed === 'boolean' ? value.allowed : null;
    const cooldownMs = normalizeCooldownMs(value.cooldownMs);
    const gameCooldownMs = normalizeGameCooldownMs(value.gameCooldownMs);

    if (allowed === null && cooldownMs === null && Object.keys(gameCooldownMs).length === 0) {
        return null;
    }
    return { allowed, cooldownMs, gameCooldownMs };
}

function cloneDefaultConfig(config) {
    return {
        allowed: config.allowed,
        cooldownMs: config.cooldownMs,
        gameCooldownMs: { ...config.gameCooldownMs },
    };
}

function cloneOverrideConfig(config) {
    return {
        allowed: config.allowed,
        cooldownMs: config.cooldownMs,
        gameCooldownMs: { ...config.gameCooldownMs },
    };
}

function cloneGuildConfig(config) {
    return {
        default: cloneDefaultConfig(config.default),
        overrides: Object.fromEntries(
            Object.entries(config.overrides).map(([channelId, override]) => [
                channelId,
                cloneOverrideConfig(override),
            ])
        ),
    };
}

function emptyGuildConfig() {
    return { default: normalizeDefaultConfig(null), overrides: {} };
}

function normalizeGuildConfig(value) {
    const source = isPlainObject(value) ? value : {};
    const overrides = {};
    if (isPlainObject(source.overrides)) {
        for (const [channelId, override] of Object.entries(source.overrides)) {
            if (!isSnowflake(channelId)) continue;
            const normalized = normalizeOverrideConfig(override);
            if (normalized) overrides[channelId] = normalized;
        }
    }
    return { default: normalizeDefaultConfig(source.default), overrides };
}

// v1 是 { whitelist: [], blacklist: [] } 的白/黑名单，直接翻译成 allowed 覆盖。
// v1 里「默认只允许子区」的隐含规则不再保留 —— 新的服务器默认层已经显式表达了它。
function migrateLegacyGuildConfig(value) {
    const config = emptyGuildConfig();
    if (!isPlainObject(value)) return config;

    const blacklist = Array.isArray(value.blacklist) ? value.blacklist : [];
    const whitelist = Array.isArray(value.whitelist) ? value.whitelist : [];

    for (const channelId of whitelist) {
        if (!isSnowflake(channelId)) continue;
        config.overrides[channelId] = { allowed: true, cooldownMs: null, gameCooldownMs: {} };
    }
    // 黑名单后写，同时出现在两个列表时以拒绝为准。
    for (const channelId of blacklist) {
        if (!isSnowflake(channelId)) continue;
        config.overrides[channelId] = { allowed: false, cooldownMs: null, gameCooldownMs: {} };
    }
    return config;
}

function parseSnapshot(value) {
    if (!isPlainObject(value)) {
        throw new Error('Channel settings data must be an object');
    }
    if (!isPlainObject(value.guilds)) {
        throw new Error('Channel settings data has an unsupported schema');
    }
    if (value.version !== STORE_VERSION && value.version !== LEGACY_STORE_VERSION) {
        throw new Error('Channel settings data has an unsupported schema');
    }

    const isLegacy = value.version === LEGACY_STORE_VERSION;
    const guilds = {};
    for (const [guildId, config] of Object.entries(value.guilds)) {
        if (!isSnowflake(guildId)) continue;
        guilds[guildId] = isLegacy
            ? migrateLegacyGuildConfig(config)
            : normalizeGuildConfig(config);
    }
    return { guilds, migrated: isLegacy };
}

function createChannelAccessStore({ filePath, fsImpl = fs, now = Date.now }) {
    let guilds = {};
    let loaded = false;
    let loadPromise = null;
    let operationQueue = Promise.resolve();

    function enqueue(operation) {
        const result = operationQueue.catch(() => undefined).then(operation);
        operationQueue = result.catch(() => undefined);
        return result;
    }

    async function ensureDirectory() {
        await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
    }

    async function writeSnapshot() {
        await ensureDirectory();
        const temporaryPath = `${filePath}.${process.pid}.${now()}.${temporaryFileSequence++}.tmp`;
        const snapshot = JSON.stringify({
            version: STORE_VERSION,
            guilds: Object.fromEntries(
                Object.entries(guilds).map(([guildId, config]) => [guildId, cloneGuildConfig(config)])
            ),
        });

        try {
            await fsImpl.writeFile(temporaryPath, snapshot, 'utf8');
            await fsImpl.rename(temporaryPath, filePath);
        } catch (error) {
            try {
                await fsImpl.unlink(temporaryPath);
            } catch (cleanupError) {
                if (cleanupError.code !== 'ENOENT') logFailure('cleaning up temporary file', cleanupError);
            }
            throw error;
        }
    }

    async function backupMalformedFile() {
        const parsedPath = path.parse(filePath);
        const backupPath = path.join(
            parsedPath.dir,
            `${parsedPath.name}.corrupt-${now()}${parsedPath.ext}`
        );
        try {
            await fsImpl.rename(filePath, backupPath);
        } catch (error) {
            logFailure('backing up malformed file', error);
        }
    }

    function guildConfigFor(guildId) {
        let config = guilds[guildId];
        if (!config) {
            config = emptyGuildConfig();
            guilds[guildId] = config;
        }
        return config;
    }

    async function load() {
        return enqueue(async () => {
            await ensureDirectory();
            let serialized;

            try {
                serialized = await fsImpl.readFile(filePath, 'utf8');
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
                guilds = {};
                loaded = true;
                await writeSnapshot();
                return;
            }

            try {
                const parsed = parseSnapshot(JSON.parse(serialized));
                guilds = parsed.guilds;
                loaded = true;
                // v1 数据迁移后立刻落盘成 v2，避免每次启动都重新迁移。
                if (parsed.migrated) await writeSnapshot();
            } catch (error) {
                logFailure('parsing channel settings file', error);
                await backupMalformedFile();
                guilds = {};
                loaded = true;
                await writeSnapshot();
            }
        });
    }

    function isLoaded() {
        return loaded;
    }

    // 指令热路径上用这个：只有第一次真正读盘，之后直接命中内存。
    // 失败时清掉 promise，让下一次调用重试，而不是永久缓存一个 rejected promise。
    function ensureLoaded() {
        if (!loadPromise) {
            loadPromise = load().catch(error => {
                loadPromise = null;
                throw error;
            });
        }
        return loadPromise;
    }

    function getGuildConfig(guildId) {
        const config = guilds[guildId];
        return config ? cloneGuildConfig(config) : emptyGuildConfig();
    }

    function getDefault(guildId) {
        const config = guilds[guildId];
        return config ? cloneDefaultConfig(config.default) : normalizeDefaultConfig(null);
    }

    function getOverride(guildId, channelId) {
        const override = guilds[guildId]?.overrides?.[channelId];
        return override ? cloneOverrideConfig(override) : null;
    }

    // patch 语义：字段缺席 = 不动；null = 清除（默认层回落到内建值，覆盖层变成继承）。
    // gameCooldownMs 是逐个游戏合并的，传 { 传炸弹: null } 只清掉传炸弹那一条。
    function applyPatch(target, patch, { isDefaultLevel }) {
        const next = {
            allowed: target.allowed,
            cooldownMs: target.cooldownMs,
            gameCooldownMs: { ...target.gameCooldownMs },
        };

        if (Object.hasOwn(patch, 'allowed')) {
            if (patch.allowed === null) {
                next.allowed = isDefaultLevel ? BUILTIN_DEFAULT_ALLOWED : null;
            } else if (typeof patch.allowed === 'boolean') {
                next.allowed = patch.allowed;
            }
        }

        if (Object.hasOwn(patch, 'cooldownMs')) {
            if (patch.cooldownMs === null) {
                next.cooldownMs = isDefaultLevel ? BUILTIN_DEFAULT_COOLDOWN_MS : null;
            } else {
                const cooldownMs = normalizeCooldownMs(patch.cooldownMs);
                if (cooldownMs !== null) next.cooldownMs = cooldownMs;
            }
        }

        if (isPlainObject(patch.gameCooldownMs)) {
            for (const [gameName, cooldown] of Object.entries(patch.gameCooldownMs)) {
                if (!isMysteryGame(gameName)) continue;
                if (cooldown === null) {
                    delete next.gameCooldownMs[gameName];
                    continue;
                }
                const cooldownMs = normalizeCooldownMs(cooldown);
                if (cooldownMs !== null) next.gameCooldownMs[gameName] = cooldownMs;
            }
        }

        return next;
    }

    async function setDefault(guildId, patch) {
        return enqueue(async () => {
            if (!isSnowflake(guildId) || !isPlainObject(patch)) return null;

            const config = guildConfigFor(guildId);
            const previous = config.default;
            config.default = normalizeDefaultConfig(
                applyPatch(previous, patch, { isDefaultLevel: true })
            );

            try {
                await writeSnapshot();
                return cloneDefaultConfig(config.default);
            } catch (error) {
                config.default = previous;
                throw error;
            }
        });
    }

    async function setOverride(guildId, channelId, patch) {
        return enqueue(async () => {
            if (!isSnowflake(guildId) || !isSnowflake(channelId) || !isPlainObject(patch)) return null;

            const config = guildConfigFor(guildId);
            const previous = config.overrides[channelId] ?? null;
            const base = previous ?? { allowed: null, cooldownMs: null, gameCooldownMs: {} };
            const normalized = normalizeOverrideConfig(
                applyPatch(base, patch, { isDefaultLevel: false })
            );

            if (normalized) config.overrides[channelId] = normalized;
            else delete config.overrides[channelId];

            try {
                await writeSnapshot();
                return normalized ? cloneOverrideConfig(normalized) : null;
            } catch (error) {
                if (previous) config.overrides[channelId] = previous;
                else delete config.overrides[channelId];
                throw error;
            }
        });
    }

    async function clearOverride(guildId, channelId) {
        return enqueue(async () => {
            const config = guilds[guildId];
            const previous = config?.overrides?.[channelId];
            if (!previous) return false;

            delete config.overrides[channelId];
            try {
                await writeSnapshot();
                return true;
            } catch (error) {
                config.overrides[channelId] = previous;
                throw error;
            }
        });
    }

    async function flush() {
        await operationQueue;
    }

    function resetForTests() {
        guilds = {};
        loaded = false;
        loadPromise = null;
        operationQueue = Promise.resolve();
    }

    return {
        load,
        ensureLoaded,
        isLoaded,
        getGuildConfig,
        getDefault,
        getOverride,
        setDefault,
        setOverride,
        clearOverride,
        flush,
        resetForTests,
    };
}

// 全模块共用一个实例：指令、管理面板、子区设置命令都读写同一份内存状态，
// 避免出现「管理员刚改完，另一个实例还拿着旧缓存」的情况。
const defaultChannelAccessStore = createChannelAccessStore({
    filePath: path.join('data', 'mystery', 'channel-access.json'),
});

module.exports = {
    STORE_VERSION,
    LEGACY_STORE_VERSION,
    BUILTIN_DEFAULT_ALLOWED,
    BUILTIN_DEFAULT_COOLDOWN_MS,
    MAX_COOLDOWN_MS,
    normalizeCooldownMs,
    createChannelAccessStore,
    defaultChannelAccessStore,
};
