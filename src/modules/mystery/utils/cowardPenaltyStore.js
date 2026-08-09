const fs = require('node:fs/promises');
const path = require('node:path');

let temporaryFileSequence = 0;
let corruptionBackupSequence = 0;

function logFailure(operation, error) {
    console.error(`[cowardPenaltyStore] ${operation} failed:`, error);
}

function buildPenaltyKey(guildId, userId) {
    return `${guildId}:${userId}`;
}

function isValidRecord(value) {
    return Boolean(
        value
        && typeof value === 'object'
        && !Array.isArray(value)
        && typeof value.guildId === 'string'
        && value.guildId.length > 0
        && typeof value.userId === 'string'
        && value.userId.length > 0
        && typeof value.enforcedNickname === 'string'
        && value.enforcedNickname.length > 0
        && Number.isFinite(value.expiresAt)
    );
}

function createCowardPenaltyStore({ filePath, now = Date.now }) {
    let penalties = {};
    let writeQueue = Promise.resolve();
    let loaded = false;

    async function ensureDirectory() {
        try {
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            return true;
        } catch (error) {
            logFailure('creating penalty directory', error);
            return false;
        }
    }

    async function writeSnapshot(snapshot) {
        if (!await ensureDirectory()) return;

        const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${temporaryFileSequence++}.tmp`;
        try {
            await fs.writeFile(temporaryPath, JSON.stringify(snapshot), 'utf8');
        } catch (error) {
            logFailure('writing temporary penalty file', error);
            try {
                await fs.unlink(temporaryPath);
            } catch (cleanupError) {
                if (cleanupError.code !== 'ENOENT') {
                    logFailure('cleaning up temporary penalty file', cleanupError);
                }
            }
            return;
        }

        try {
            await fs.rename(temporaryPath, filePath);
        } catch (error) {
            logFailure('renaming temporary penalty file', error);
            try {
                await fs.unlink(temporaryPath);
            } catch (cleanupError) {
                if (cleanupError.code !== 'ENOENT') {
                    logFailure('cleaning up temporary penalty file', cleanupError);
                }
            }
        }
    }

    function queueWrite() {
        const snapshot = { ...penalties };
        writeQueue = writeQueue.then(
            () => writeSnapshot(snapshot),
            error => {
                logFailure('waiting for queued penalty write', error);
                return writeSnapshot(snapshot);
            }
        );
        return writeQueue;
    }

    async function backupMalformedFile() {
        const parsedPath = path.parse(filePath);
        const backupId = (Date.now() * 1000) + (corruptionBackupSequence++ % 1000);
        const backupPath = path.join(
            parsedPath.dir,
            `${parsedPath.name}.corrupt-${backupId}${parsedPath.ext}`
        );

        try {
            await fs.rename(filePath, backupPath);
            return true;
        } catch (error) {
            logFailure('backing up malformed penalty file', error);
            return false;
        }
    }

    async function load() {
        try {
            await writeQueue;
        } catch (error) {
            logFailure('waiting before penalty load', error);
        }

        if (!await ensureDirectory()) {
            penalties = {};
            loaded = true;
            return [];
        }

        let parsed = {};
        let shouldWrite = false;
        let serialized;

        try {
            serialized = await fs.readFile(filePath, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') {
                shouldWrite = true;
            } else {
                logFailure('reading penalty file', error);
            }
        }

        if (serialized !== undefined) {
            try {
                const value = JSON.parse(serialized);
                if (!value || Array.isArray(value) || typeof value !== 'object') {
                    throw new Error('Penalty data must be a JSON object');
                }
                parsed = value;
            } catch (error) {
                logFailure('reading penalty file', error);
                shouldWrite = await backupMalformedFile();
            }
        }

        penalties = {};
        for (const [key, record] of Object.entries(parsed)) {
            if (isValidRecord(record)) {
                penalties[key] = record;
            } else {
                shouldWrite = true;
            }
        }

        loaded = true;
        if (shouldWrite) await queueWrite();
        return Object.values(penalties);
    }

    function isLoaded() {
        return loaded;
    }

    function get(guildId, userId) {
        return penalties[buildPenaltyKey(guildId, userId)] || null;
    }

    function list() {
        return Object.values(penalties);
    }

    function save(record) {
        if (!isValidRecord(record)) return null;
        penalties[buildPenaltyKey(record.guildId, record.userId)] = record;
        void queueWrite();
        return record;
    }

    function remove(guildId, userId) {
        const key = buildPenaltyKey(guildId, userId);
        if (!Object.hasOwn(penalties, key)) return false;
        delete penalties[key];
        void queueWrite();
        return true;
    }

    function listExpired(currentTime = now()) {
        return Object.values(penalties).filter(record => record.expiresAt <= currentTime);
    }

    async function flush() {
        try {
            await writeQueue;
        } catch (error) {
            logFailure('flushing penalty writes', error);
        }
    }

    function resetForTests() {
        penalties = {};
        loaded = false;
        writeQueue = Promise.resolve();
    }

    return {
        load,
        isLoaded,
        get,
        list,
        save,
        remove,
        listExpired,
        flush,
        resetForTests,
    };
}

const defaultStore = createCowardPenaltyStore({
    filePath: path.join('data', 'mystery', 'cowardPenalties.json'),
});

module.exports = {
    buildPenaltyKey,
    createCowardPenaltyStore,
    load: defaultStore.load,
    isLoaded: defaultStore.isLoaded,
    get: defaultStore.get,
    list: defaultStore.list,
    save: defaultStore.save,
    remove: defaultStore.remove,
    listExpired: defaultStore.listExpired,
    flush: defaultStore.flush,
    resetForTests: defaultStore.resetForTests,
};
