const fs = require('node:fs/promises');
const path = require('node:path');

const VERSION = 1;
const MAX_NICKNAME_LENGTH = 32;
let corruptSequence = 0;

const DEFAULT_NAME_POOL = Object.freeze([
    '我是奶人', '奶奶的龙', '铁血旅程派', '铁血类脑派', '权蛆', 'D喵梦男', 'D喵梦女',
    '大狗叫！', '猪猪之王', '类脑自研文爱AI', '赛博街溜子', '名字被狗吃了',
    '管理组重点观察对象', '用户名涉嫌违规', '类脑最纯洁之人', '类脑最淫乱之人', '基米',
    '我不是gay', '我是好女孩吗', '类脑第一深情', '名字已被夺舍', '疑似真人',
    '别问我为什么叫这个', '嘉豪本豪', '我现在后悔还来得及吗', '嘉豪',
]);

function isValidName(name) {
    return typeof name === 'string'
        && name.length > 0
        && name === name.trim()
        && Array.from(name).length <= MAX_NICKNAME_LENGTH;
}

function parseSnapshot(serialized) {
    const value = JSON.parse(serialized);
    if (!value || Array.isArray(value) || value.version !== VERSION || !Array.isArray(value.names)) {
        throw new Error('Name pool must contain version 1 and a names array');
    }
    if (value.names.length === 0 || value.names.some(name => !isValidName(name))) {
        throw new Error('Name pool must contain at least one valid Discord nickname');
    }
    if (new Set(value.names).size !== value.names.length) {
        throw new Error('Name pool names must be unique');
    }
    return [...value.names];
}

function createNamePoolStore({
    filePath,
    fsImpl = fs,
    now = Date.now,
}) {
    let names = [...DEFAULT_NAME_POOL];
    let initialized = false;
    let initializationPromise = null;
    let mutationTail = Promise.resolve();

    async function ensureDirectory() {
        await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
    }

    async function writeNames(nextNames) {
        await ensureDirectory();
        const temporaryPath = `${filePath}.tmp`;
        const serialized = `${JSON.stringify({ version: VERSION, names: nextNames }, null, 2)}\n`;
        try {
            await fsImpl.writeFile(temporaryPath, serialized, 'utf8');
            await fsImpl.rename(temporaryPath, filePath);
        } catch (error) {
            try {
                await fsImpl.unlink(temporaryPath);
            } catch (cleanupError) {
                if (cleanupError.code !== 'ENOENT') {
                    console.error('[namePoolStore] 清理临时文件失败:', cleanupError);
                }
            }
            throw error;
        }
    }

    async function backupCorruptFile() {
        const parsed = path.parse(filePath);
        const timestamp = (now() * 1000) + (corruptSequence++ % 1000);
        const backupPath = path.join(parsed.dir, `${parsed.name}.corrupt-${timestamp}${parsed.ext}`);
        await fsImpl.rename(filePath, backupPath);
        return backupPath;
    }

    async function performInitialization() {
        await ensureDirectory();
        let serialized;
        try {
            serialized = await fsImpl.readFile(filePath, 'utf8');
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            const defaults = [...DEFAULT_NAME_POOL];
            await writeNames(defaults);
            names = defaults;
            initialized = true;
            return;
        }

        try {
            names = parseSnapshot(serialized);
        } catch (error) {
            console.error('[namePoolStore] 名字库 JSON 损坏，正在恢复默认名字库:', error);
            await backupCorruptFile();
            const defaults = [...DEFAULT_NAME_POOL];
            await writeNames(defaults);
            names = defaults;
        }
        initialized = true;
    }

    async function initialize() {
        if (initialized) return;
        if (!initializationPromise) {
            initializationPromise = performInitialization().catch(error => {
                initializationPromise = null;
                throw error;
            });
        }
        await initializationPromise;
    }

    async function getNames() {
        await initialize();
        return [...names];
    }

    function serializeMutation(operation) {
        const result = mutationTail.then(operation, operation);
        mutationTail = result.catch(() => {});
        return result;
    }

    async function addNames(inputNames) {
        return serializeMutation(async () => {
            await initialize();
            const existing = new Set(names);
            const seenInput = new Set();
            const additions = [];
            let duplicates = 0;
            let invalid = 0;

            for (const rawName of Array.isArray(inputNames) ? inputNames : []) {
                const name = typeof rawName === 'string' ? rawName.trim() : '';
                if (!name || Array.from(name).length > MAX_NICKNAME_LENGTH) {
                    invalid += 1;
                    continue;
                }
                if (seenInput.has(name) || existing.has(name)) {
                    duplicates += 1;
                    continue;
                }
                seenInput.add(name);
                existing.add(name);
                additions.push(name);
            }

            if (additions.length > 0) {
                const nextNames = [...names, ...additions];
                await writeNames(nextNames);
                names = nextNames;
            }
            return {
                added: additions.length,
                duplicates,
                invalid,
                total: names.length,
            };
        });
    }

    async function removeNames(inputNames) {
        return serializeMutation(async () => {
            await initialize();
            const requested = [];
            const seen = new Set();
            for (const rawName of Array.isArray(inputNames) ? inputNames : []) {
                const name = typeof rawName === 'string' ? rawName.trim() : '';
                if (!name || seen.has(name)) continue;
                seen.add(name);
                requested.push(name);
            }

            const current = new Set(names);
            const found = requested.filter(name => current.has(name));
            const notFound = requested.length - found.length;
            if (found.length === names.length) {
                return {
                    removed: 0,
                    notFound,
                    total: names.length,
                    rejectedEmpty: true,
                };
            }

            if (found.length > 0) {
                const removing = new Set(found);
                const nextNames = names.filter(name => !removing.has(name));
                await writeNames(nextNames);
                names = nextNames;
            }
            return {
                removed: found.length,
                notFound,
                total: names.length,
                rejectedEmpty: false,
            };
        });
    }

    return {
        initialize,
        getNames,
        addNames,
        removeNames,
    };
}

const defaultStore = createNamePoolStore({
    filePath: path.join('data', 'mystery', 'namePool.json'),
});

module.exports = {
    DEFAULT_NAME_POOL,
    MAX_NICKNAME_LENGTH,
    createNamePoolStore,
    initialize: defaultStore.initialize,
    getNames: defaultStore.getNames,
    addNames: defaultStore.addNames,
    removeNames: defaultStore.removeNames,
};
