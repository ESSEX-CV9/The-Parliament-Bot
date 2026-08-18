// 恶魔轮盘对局快照存储（独立断连接续用，不依赖共享游戏框架）。
// 把进行中的对局序列化为 JSON 存在 data/mystery/devilRouletteActiveGames.json：
//   - 每次渲染/状态变更后 save(gameId, snapshot)；
//   - 对局真正收尾后 remove(gameId)；
//   - 启动时 list() 读回全部未完成对局，恢复面板继续打。
// 写入走「临时文件 + rename」原子替换 + 串行队列，避免进程崩溃留下半截文件（同 bombCooldownStore 模式）。

const fs = require('node:fs/promises');
const path = require('node:path');

let temporaryFileSequence = 0;

function logFailure(operation, error) {
    console.error(`[DevilRouletteResume] ${operation} failed:`, error);
}

function createDevilRouletteResumeStore({ filePath, now = Date.now } = {}) {
    let snapshots = {}; // gameId -> snapshot object
    let writeQueue = Promise.resolve();

    async function ensureDirectory() {
        try {
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            return true;
        } catch (error) {
            logFailure('creating resume directory', error);
            return false;
        }
    }

    async function writeSnapshot() {
        if (!await ensureDirectory()) return;
        const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${temporaryFileSequence++}.tmp`;
        const payload = JSON.stringify(snapshots);
        try {
            await fs.writeFile(temporaryPath, payload, 'utf8');
        } catch (error) {
            logFailure('writing temporary resume file', error);
            try {
                await fs.unlink(temporaryPath);
            } catch (cleanupError) {
                if (cleanupError.code !== 'ENOENT') logFailure('cleaning up temporary resume file', cleanupError);
            }
            return;
        }
        try {
            await fs.rename(temporaryPath, filePath);
        } catch (error) {
            logFailure('renaming temporary resume file', error);
            try {
                await fs.unlink(temporaryPath);
            } catch (cleanupError) {
                if (cleanupError.code !== 'ENOENT') logFailure('cleaning up temporary resume file', cleanupError);
            }
        }
    }

    function queueWrite() {
        writeQueue = writeQueue.then(
            () => writeSnapshot(),
            () => writeSnapshot(),
        );
        return writeQueue;
    }

    async function backupMalformedFile() {
        const parsed = path.parse(filePath);
        const backupPath = path.join(parsed.dir, `${parsed.name}.corrupt-${now()}${parsed.ext}`);
        try {
            await fs.rename(filePath, backupPath);
            return true;
        } catch (error) {
            logFailure('backing up malformed resume file', error);
            return false;
        }
    }

    async function load() {
        try {
            await writeQueue;
        } catch (error) {
            logFailure('waiting before resume load', error);
        }
        if (!await ensureDirectory()) {
            snapshots = {};
            return;
        }
        let serialized;
        try {
            serialized = await fs.readFile(filePath, 'utf8');
        } catch (error) {
            if (error.code !== 'ENOENT') logFailure('reading resume file', error);
        }
        if (serialized !== undefined) {
            try {
                const value = JSON.parse(serialized);
                if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Resume data must be a JSON object');
                snapshots = value;
            } catch (error) {
                logFailure('parsing resume file', error);
                await backupMalformedFile();
                snapshots = {};
            }
        }
    }

    function save(gameId, snapshot) {
        if (!gameId || !snapshot || typeof snapshot !== 'object') return;
        snapshots[gameId] = { ...snapshot, savedAt: now() };
        void queueWrite();
    }

    function remove(gameId) {
        if (gameId && Object.hasOwn(snapshots, gameId)) {
            delete snapshots[gameId];
            void queueWrite();
        }
    }

    async function list() {
        await load();
        return Object.values(snapshots).filter(snapshot => snapshot && typeof snapshot === 'object');
    }

    async function flush() {
        try {
            await writeQueue;
        } catch (error) {
            logFailure('flushing resume writes', error);
        }
    }

    return { save, remove, list, load, flush };
}

const defaultStore = createDevilRouletteResumeStore({
    filePath: path.join('data', 'mystery', 'devilRouletteActiveGames.json'),
});

module.exports = {
    createDevilRouletteResumeStore,
    save: defaultStore.save,
    remove: defaultStore.remove,
    list: defaultStore.list,
    load: defaultStore.load,
    flush: defaultStore.flush,
};
