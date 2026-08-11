const fs = require('node:fs/promises');
const path = require('node:path');

// 只有在频道设置没给出冷却时长时才会用到；正常路径由 mysteryCommand 传入解析结果。
const DEFAULT_COOLDOWN_DURATION_MS = 30 * 60 * 1000;
let temporaryFileSequence = 0;
let corruptionBackupSequence = 0;

function logFailure(operation, error) {
    console.error(`[bombCooldownStore] ${operation} failed:`, error);
}

// 与内存冷却保持一致：按「服务器 + 用户 + 频道」计数，每个子区/帖子各算各的。
function buildCooldownKey(guildId, userId, channelId) {
    return `${guildId}:${userId}:${channelId}`;
}

// 旧数据是 `guildId:userId` 两段式，没有频道信息、无法安全归属到任何频道，
// 加载时直接丢弃（最坏情况是少数人的传炸弹冷却提前解除一次）。
function isCurrentSchemaKey(key) {
    return typeof key === 'string' && key.split(':').length === 3;
}

function createBombCooldownStore({ filePath, now = Date.now }) {
    let cooldowns = {};
    let writeQueue = Promise.resolve();

    async function ensureDirectory() {
        try {
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            return true;
        } catch (error) {
            logFailure('creating cooldown directory', error);
            return false;
        }
    }

    async function writeSnapshot(snapshot) {
        if (!await ensureDirectory()) {
            return;
        }

        const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${temporaryFileSequence++}.tmp`;
        try {
            await fs.writeFile(temporaryPath, JSON.stringify(snapshot), 'utf8');
        } catch (error) {
            logFailure('writing temporary cooldown file', error);
            try {
                await fs.unlink(temporaryPath);
            } catch (cleanupError) {
                if (cleanupError.code !== 'ENOENT') {
                    logFailure('cleaning up temporary cooldown file', cleanupError);
                }
            }
            return;
        }

        try {
            await fs.rename(temporaryPath, filePath);
        } catch (error) {
            logFailure('renaming temporary cooldown file', error);
            try {
                await fs.unlink(temporaryPath);
            } catch (cleanupError) {
                if (cleanupError.code !== 'ENOENT') {
                    logFailure('cleaning up temporary cooldown file', cleanupError);
                }
            }
        }
    }

    function queueWrite() {
        const snapshot = { ...cooldowns };
        writeQueue = writeQueue.then(
            () => writeSnapshot(snapshot),
            (error) => {
                logFailure('waiting for queued cooldown write', error);
                return writeSnapshot(snapshot);
            },
        );
        return writeQueue;
    }

    function removeExpiredCooldowns() {
        const currentTime = now();
        let removed = false;

        for (const [key, expiresAt] of Object.entries(cooldowns)) {
            if (!isCurrentSchemaKey(key) || !Number.isFinite(expiresAt) || expiresAt <= currentTime) {
                delete cooldowns[key];
                removed = true;
            }
        }

        return removed;
    }

    async function backupMalformedFile() {
        const parsedPath = path.parse(filePath);
        const backupId = (Date.now() * 1000) + (corruptionBackupSequence++ % 1000);
        const backupPath = path.join(parsedPath.dir, `${parsedPath.name}.corrupt-${backupId}${parsedPath.ext}`);

        try {
            await fs.rename(filePath, backupPath);
            return true;
        } catch (error) {
            logFailure('backing up malformed cooldown file', error);
            return false;
        }
    }

    async function load() {
        try {
            await writeQueue;
        } catch (error) {
            logFailure('waiting before cooldown load', error);
        }

        if (!await ensureDirectory()) {
            cooldowns = {};
            return;
        }

        let parsedCooldowns = {};
        let shouldWrite = false;

        let serializedCooldowns;
        try {
            serializedCooldowns = await fs.readFile(filePath, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') {
                shouldWrite = true;
            } else {
                logFailure('reading cooldown file', error);
            }
        }

        if (serializedCooldowns !== undefined) {
            try {
                const value = JSON.parse(serializedCooldowns);
                if (!value || Array.isArray(value) || typeof value !== 'object') {
                    throw new Error('Cooldown data must be a JSON object');
                }
                parsedCooldowns = value;
            } catch (error) {
                logFailure('reading cooldown file', error);
                shouldWrite = await backupMalformedFile();
            }
        }

        cooldowns = parsedCooldowns;
        if (removeExpiredCooldowns()) {
            shouldWrite = true;
        }

        if (shouldWrite) {
            await queueWrite();
        }
    }

    function getExpiresAt(guildId, userId, channelId) {
        const key = buildCooldownKey(guildId, userId, channelId);
        const expiresAt = cooldowns[key];

        if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
            if (Object.hasOwn(cooldowns, key)) {
                delete cooldowns[key];
                void queueWrite();
            }
            return null;
        }

        return expiresAt;
    }

    function isOnCooldown(guildId, userId, channelId) {
        return getExpiresAt(guildId, userId, channelId) !== null;
    }

    /**
     * @param {number} durationMs 该频道解析出来的冷却时长；0 表示不进冷却。
     * @returns {number|null} 冷却到期时间戳；durationMs 为 0 时返回 null。
     */
    function startCooldown(guildId, userId, channelId, durationMs = DEFAULT_COOLDOWN_DURATION_MS) {
        const duration = Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0;
        if (duration === 0) return null;

        const expiresAt = now() + duration;
        cooldowns[buildCooldownKey(guildId, userId, channelId)] = expiresAt;
        void queueWrite();
        return expiresAt;
    }

    async function flush() {
        try {
            await writeQueue;
        } catch (error) {
            logFailure('flushing cooldown writes', error);
        }
    }

    return {
        getExpiresAt,
        isOnCooldown,
        startCooldown,
        load,
        flush,
    };
}

const defaultStore = createBombCooldownStore({
    filePath: path.join('data', 'mystery', 'bombCooldowns.json'),
});

module.exports = {
    DEFAULT_COOLDOWN_DURATION_MS,
    buildCooldownKey,
    createBombCooldownStore,
    getExpiresAt: defaultStore.getExpiresAt,
    isOnCooldown: defaultStore.isOnCooldown,
    startCooldown: defaultStore.startCooldown,
    load: defaultStore.load,
    flush: defaultStore.flush,
};
