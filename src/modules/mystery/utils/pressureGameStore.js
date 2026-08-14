// 加压轮盘的「进行中对局」快照存储。
//
// 为什么要有它：整个神秘游戏系统的对局状态都只活在内存里，推送更新重启一次
// 就全没了 —— 玩家盯着一堆点了就回「已失效」的按钮，一局白打。
// 这里把对局状态落到磁盘，重启后由 restorePressureGames 捞回来接着打。
//
// 设计取舍：
// - **只在稳定检查点写**（轮到某人开枪 / 进入选择 / 进入和局投票 / 招募中）。
//   崩在两个检查点之间最多回退一个动作，不会写出「淘汰到一半」的状态。
// - **整份重写 + 原子改名**。一场对局的快照撑死几 KB，同时进行的对局也就几场，
//   没必要上数据库；rename 保证读到的要么是旧的完整文件，要么是新的完整文件。
// - **同步写**。调用点全在 runExclusive 的临界区外围，写几 KB JSON 是微秒级，
//   换来的是「函数返回时数据一定已经落盘」，不用操心异步写和进程退出赛跑。

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '../../../../data', 'mystery');
const STORE_FILE = path.join(DATA_DIR, 'pressureActiveGames.json');
const TEMP_FILE = `${STORE_FILE}.tmp`;

// 快照格式版本。以后改了对局状态的形状就 +1，旧快照会被整份丢弃
// （宁可让那一局失效，也不能拿对不上的数据去恢复）。
const SNAPSHOT_VERSION = 3;

// 超过这个时间的快照不再恢复：多半是机器人停机很久，玩家早就散了，
// 硬把一局几小时前的游戏拉起来只会莫名其妙。
const MAX_SNAPSHOT_AGE_MS = 6 * 60 * 60 * 1000;

function ensureDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function logFailure(action, error) {
    console.error(`[PressureGameStore] ${action} 失败:`, error);
}

function readStore() {
    try {
        if (!fs.existsSync(STORE_FILE)) return { version: SNAPSHOT_VERSION, games: {} };
        const raw = fs.readFileSync(STORE_FILE, 'utf8');
        if (!raw.trim()) return { version: SNAPSHOT_VERSION, games: {} };
        const parsed = JSON.parse(raw);
        if (parsed?.version !== SNAPSHOT_VERSION || !parsed.games) {
            // 版本对不上就整份作废，别拿旧形状的数据去拼新逻辑。
            return { version: SNAPSHOT_VERSION, games: {} };
        }
        return parsed;
    } catch (error) {
        // 文件损坏（比如上次写到一半断电）时不能让整个机器人起不来。
        logFailure('读取快照', error);
        return { version: SNAPSHOT_VERSION, games: {} };
    }
}

function writeStore(store) {
    try {
        ensureDir();
        fs.writeFileSync(TEMP_FILE, JSON.stringify(store), 'utf8');
        fs.renameSync(TEMP_FILE, STORE_FILE);
        return true;
    } catch (error) {
        logFailure('写入快照', error);
        return false;
    }
}

/** 存 / 更新一局的快照。 */
function saveSnapshot(gameId, snapshot) {
    if (!gameId || !snapshot) return false;
    const store = readStore();
    store.games[gameId] = snapshot;
    store.savedAt = Date.now();
    return writeStore(store);
}

/** 一局结束（或判定为不可恢复）时把它的快照抹掉。 */
function deleteSnapshot(gameId) {
    if (!gameId) return false;
    const store = readStore();
    if (!store.games[gameId]) return false;
    delete store.games[gameId];
    store.savedAt = Date.now();
    return writeStore(store);
}

/**
 * 取出所有还值得恢复的快照，同时把过期的清理掉。
 * @returns {Array<object>} 快照数组，调用方自己判断能不能恢复
 */
function loadSnapshots() {
    const store = readStore();
    const now = Date.now();
    const fresh = [];
    let dropped = 0;

    for (const [gameId, snapshot] of Object.entries(store.games)) {
        const savedAt = Number(snapshot?.savedAt) || 0;
        if (!savedAt || now - savedAt > MAX_SNAPSHOT_AGE_MS) {
            delete store.games[gameId];
            dropped += 1;
            continue;
        }
        fresh.push(snapshot);
    }

    if (dropped > 0) writeStore(store);
    return fresh;
}

/** 恢复流程跑完后整份清空：能捞的已经捞起来了，捞不动的也不该留着下次再试。 */
function clearAll() {
    return writeStore({ version: SNAPSHOT_VERSION, games: {}, savedAt: Date.now() });
}

module.exports = {
    STORE_FILE,
    SNAPSHOT_VERSION,
    MAX_SNAPSHOT_AGE_MS,
    saveSnapshot,
    deleteSnapshot,
    loadSnapshots,
    clearAll,
};
