const fs = require('node:fs/promises');
const path = require('node:path');

let temporaryFileSequence = 0;
let corruptionBackupSequence = 0;

// 身份/业务契约字段不允许通过 update 修改；只有显式列出的可变字段可被更新。
const IMMUTABLE_LOCK_FIELDS = [
    'guildId',
    'userId',
    'type',
    'originalNickname',
    'enforcedNickname',
    'applyReason',
    'restoreReason',
    'enforceReason',
];
const MUTABLE_LOCK_FIELDS = ['expiresAt', 'settled', 'channelId'];

function buildMysteryNicknameLockKey(guildId, userId) {
    return `${guildId}:${userId}`;
}

function copyRecord(record) {
    return record ? { ...record } : null;
}

function normalizeRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    if (typeof record.guildId !== 'string' || record.guildId.length === 0) return null;
    if (typeof record.userId !== 'string' || record.userId.length === 0) return null;
    if (typeof record.enforcedNickname !== 'string' || record.enforcedNickname.length === 0) return null;
    if (!Number.isFinite(record.expiresAt)) return null;
    if (record.type !== undefined && (typeof record.type !== 'string' || record.type.length === 0)) return null;

    return {
        ...record,
        type: record.type ?? 'coward',
    };
}

function createMysteryNicknameLockStore({ filePath, fsImpl = fs, now = Date.now }) {
    let locks = {};
    let loaded = false;
    let writeQueue = Promise.resolve();
    let mutationQueue = Promise.resolve();

    function logFailure(operation, error) {
        console.error(`[mysteryNicknameLockStore] ${operation} failed:`, error);
    }

    async function ensureDirectory() {
        await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
    }

    async function removeTemporaryFile(temporaryPath) {
        try {
            await fsImpl.unlink(temporaryPath);
        } catch (error) {
            if (error.code !== 'ENOENT') logFailure('cleaning up temporary lock file', error);
        }
    }

    async function writeSnapshot(snapshot) {
        const temporaryPath = `${filePath}.${process.pid}.${now()}.${temporaryFileSequence++}.tmp`;
        try {
            await ensureDirectory();
            await fsImpl.writeFile(temporaryPath, JSON.stringify(snapshot), 'utf8');
            await fsImpl.rename(temporaryPath, filePath);
        } catch (error) {
            await removeTemporaryFile(temporaryPath);
            logFailure('persisting lock snapshot', error);
            throw error;
        }
    }

    function queueWrite() {
        const snapshot = Object.fromEntries(
            Object.entries(locks).map(([key, record]) => [key, copyRecord(record)])
        );
        writeQueue = writeQueue.catch(() => undefined).then(() => writeSnapshot(snapshot));
        return writeQueue;
    }

    function queueMutation(operation) {
        const next = mutationQueue.catch(() => undefined).then(operation);
        mutationQueue = next;
        return next;
    }

    async function backupMalformedFile() {
        const parsedPath = path.parse(filePath);
        const suffix = corruptionBackupSequence++;
        const backupPath = path.join(
            parsedPath.dir,
            `${parsedPath.name}.corrupt-${now()}${suffix ? `-${suffix}` : ''}${parsedPath.ext}`
        );
        try {
            await fsImpl.rename(filePath, backupPath);
            return true;
        } catch (error) {
            logFailure('backing up malformed lock file', error);
            return false;
        }
    }

    function load() {
        return queueMutation(async () => {
            await writeQueue;
            await ensureDirectory();

            let parsed = {};
            let serialized;
            let shouldWrite = false;
            try {
                serialized = await fsImpl.readFile(filePath, 'utf8');
            } catch (error) {
                if (error.code === 'ENOENT') shouldWrite = true;
                else logFailure('reading lock file', error);
            }

            if (serialized !== undefined) {
                try {
                    const value = JSON.parse(serialized);
                    if (!value || Array.isArray(value) || typeof value !== 'object') {
                        throw new Error('Mystery nickname lock data must be a JSON object');
                    }
                    parsed = value;
                } catch (error) {
                    logFailure('parsing lock file', error);
                    shouldWrite = await backupMalformedFile();
                }
            }

            locks = {};
            for (const record of Object.values(parsed)) {
                const normalized = normalizeRecord(record);
                if (!normalized) {
                    shouldWrite = true;
                    continue;
                }
                locks[buildMysteryNicknameLockKey(normalized.guildId, normalized.userId)] = normalized;
                if (normalized.type !== record.type) shouldWrite = true;
            }

            loaded = true;
            if (shouldWrite) await queueWrite();
            return list();
        });
    }

    function isLoaded() {
        return loaded;
    }

    function get(guildId, userId) {
        return copyRecord(locks[buildMysteryNicknameLockKey(guildId, userId)]);
    }

    function list() {
        return Object.values(locks).map(copyRecord);
    }

    function create(record) {
        return queueMutation(async () => {
            const normalized = normalizeRecord(record);
            if (!normalized) return false;
            const key = buildMysteryNicknameLockKey(normalized.guildId, normalized.userId);
            if (Object.hasOwn(locks, key)) return false;
            locks[key] = normalized;
            try {
                await queueWrite();
                return true;
            } catch (error) {
                if (locks[key] === normalized) delete locks[key];
                throw error;
            }
        });
    }

    function save(record) {
        const normalized = normalizeRecord(record);
        if (!normalized) return null;
        locks[buildMysteryNicknameLockKey(normalized.guildId, normalized.userId)] = normalized;
        void queueWrite().catch(error => logFailure('saving legacy lock', error));
        return copyRecord(normalized);
    }

    function remove(guildId, userId) {
        return queueMutation(async () => {
            const key = buildMysteryNicknameLockKey(guildId, userId);
            if (!Object.hasOwn(locks, key)) return false;
            const record = locks[key];
            delete locks[key];
            try {
                await queueWrite();
                return true;
            } catch (error) {
                if (!Object.hasOwn(locks, key)) locks[key] = record;
                throw error;
            }
        });
    }

    function removeLegacy(guildId, userId) {
        const key = buildMysteryNicknameLockKey(guildId, userId);
        if (!Object.hasOwn(locks, key)) return false;
        delete locks[key];
        void queueWrite().catch(error => logFailure('removing legacy lock', error));
        return true;
    }

    // 受限的 replacement：当前记录不存在时直接创建；
    // 存在时仅当当前记录的 type ∈ expectedTypes 才允许原子替换为新记录。
    // 用于普通锁互覆（duel_rename / devil_roulette_rename）与 coward 覆盖普通锁。
    function replaceLock(guildId, userId, record, expectedTypes) {
        return queueMutation(async () => {
            const key = buildMysteryNicknameLockKey(guildId, userId);
            const current = locks[key];
            if (current && !expectedTypes.includes(current.type)) return null;

            const normalized = normalizeRecord(record);
            if (!normalized) return null;

            const previous = current ? copyRecord(current) : null;

            locks[key] = normalized;
            try {
                await queueWrite();
                return copyRecord(normalized);
            } catch (error) {
                if (previous) locks[key] = previous;
                else delete locks[key];
                throw error;
            }
        });
    }

    // 受限的 durable 更新：只在串行 mutation 内读取当前记录、应用 updater、
    // 校验身份字段不可变、durable write 成功后才提交内存；失败回滚并抛错。
    function update(guildId, userId, updater) {
        return queueMutation(async () => {
            const key = buildMysteryNicknameLockKey(guildId, userId);
            const current = locks[key];
            if (!current || typeof updater !== 'function') return null;

            const draft = copyRecord(current);
            const proposed = updater(draft);
            if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) {
                throw new Error('invalid updated lock record');
            }

            for (const field of IMMUTABLE_LOCK_FIELDS) {
                if (proposed[field] !== undefined && proposed[field] !== current[field]) {
                    throw new Error(`immutable lock field changed: ${field}`);
                }
            }

            const next = { ...current };
            for (const field of MUTABLE_LOCK_FIELDS) {
                if (proposed[field] !== undefined) next[field] = proposed[field];
            }
            const normalized = normalizeRecord(next);
            if (!normalized) throw new Error('invalid updated lock record');

            locks[key] = normalized;
            try {
                await queueWrite();
                return copyRecord(normalized);
            } catch (error) {
                if (locks[key] === normalized) locks[key] = current;
                throw error;
            }
        });
    }

    function listExpired(currentTime = now()) {
        return list().filter(record => record.expiresAt <= currentTime);
    }

    async function flush() {
        await mutationQueue;
        await writeQueue;
    }

    function resetForTests() {
        locks = {};
        loaded = false;
        writeQueue = Promise.resolve();
        mutationQueue = Promise.resolve();
    }

    return {
        load,
        isLoaded,
        get,
        list,
        create,
        save,
        remove,
        removeLegacy,
        replaceLock,
        update,
        listExpired,
        flush,
        resetForTests,
    };
}

module.exports = {
    buildMysteryNicknameLockKey,
    createMysteryNicknameLockStore,
};
