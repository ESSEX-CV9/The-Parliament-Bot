const fs = require('node:fs/promises');
const path = require('node:path');

const COOLDOWN_DURATION_MS = 15 * 60 * 1000;
let temporaryFileSequence = 0;
let corruptionBackupSequence = 0;

function logFailure(operation, error) {
    console.error(`[bombCooldownStore] ${operation} failed:`, error);
}

function buildCooldownKey(guildId, userId) {
    return `${guildId}:${userId}`;
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
            if (!Number.isFinite(expiresAt) || expiresAt <= currentTime) {
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

    function getExpiresAt(guildId, userId) {
        const key = buildCooldownKey(guildId, userId);
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

    function isOnCooldown(guildId, userId) {
        return getExpiresAt(guildId, userId) !== null;
    }

    function startCooldown(guildId, userId) {
        const expiresAt = now() + COOLDOWN_DURATION_MS;
        cooldowns[buildCooldownKey(guildId, userId)] = expiresAt;
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
    COOLDOWN_DURATION_MS,
    createBombCooldownStore,
    getExpiresAt: defaultStore.getExpiresAt,
    isOnCooldown: defaultStore.isOnCooldown,
    startCooldown: defaultStore.startCooldown,
    load: defaultStore.load,
    flush: defaultStore.flush,
};
