const fs = require('node:fs/promises');
const path = require('node:path');

const STORE_VERSION = 1;
let temporaryFileSequence = 0;

function isStringIdArray(value) {
    return Array.isArray(value) && value.every(id => typeof id === 'string');
}

function normalizeGuildConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (!isStringIdArray(value.whitelist) || !isStringIdArray(value.blacklist)) return null;

    const whitelist = [...new Set(value.whitelist)];
    const blacklist = [...new Set(value.blacklist)];
    if (whitelist.some(id => blacklist.includes(id))) return null;

    return { whitelist, blacklist };
}

function parseSnapshot(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Channel access data must be an object');
    }
    if (value.version !== STORE_VERSION || !value.guilds || typeof value.guilds !== 'object' || Array.isArray(value.guilds)) {
        throw new Error('Channel access data has an unsupported schema');
    }

    const guilds = {};
    for (const [guildId, config] of Object.entries(value.guilds)) {
        if (typeof guildId !== 'string') {
            throw new Error('Guild IDs must be strings');
        }

        const normalized = normalizeGuildConfig(config);
        if (!normalized) {
            throw new Error('Guild configuration contains invalid channel IDs');
        }
        guilds[guildId] = normalized;
    }

    return guilds;
}

function cloneGuilds(guilds) {
    return Object.fromEntries(Object.entries(guilds).map(([guildId, config]) => [
        guildId,
        {
            whitelist: [...config.whitelist],
            blacklist: [...config.blacklist],
        },
    ]));
}

function createChannelAccessStore({ filePath, fsImpl = fs, now = Date.now }) {
    let guilds = {};
    let operationQueue = Promise.resolve();

    function enqueue(operation) {
        const result = operationQueue.then(operation);
        operationQueue = result.catch(() => undefined);
        return result;
    }

    async function ensureDirectory() {
        await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
    }

    async function writeSnapshot() {
        await ensureDirectory();
        const temporaryPath = `${filePath}.${process.pid}.${now()}.${temporaryFileSequence++}.tmp`;
        const snapshot = JSON.stringify({ version: STORE_VERSION, guilds: cloneGuilds(guilds) });

        try {
            await fsImpl.writeFile(temporaryPath, snapshot, 'utf8');
            await fsImpl.rename(temporaryPath, filePath);
        } catch (error) {
            try {
                await fsImpl.unlink(temporaryPath);
            } catch (cleanupError) {
                if (cleanupError.code !== 'ENOENT') throw cleanupError;
            }
            throw error;
        }
    }

    async function backupMalformedFile() {
        const parsedPath = path.parse(filePath);
        const backupPath = path.join(
            parsedPath.dir,
            `${parsedPath.name}.corrupt-${now()}${parsedPath.ext}`,
        );
        await fsImpl.rename(filePath, backupPath);
    }

    function getGuildConfig(guildId) {
        const config = guilds[guildId];
        if (!config) return { whitelist: [], blacklist: [] };
        return {
            whitelist: [...config.whitelist],
            blacklist: [...config.blacklist],
        };
    }

    async function load() {
        return enqueue(async () => {
            await ensureDirectory();
            let serialized;

            try {
                serialized = await fsImpl.readFile(filePath, 'utf8');
            } catch (error) {
                if (error.code === 'ENOENT') {
                    guilds = {};
                    await writeSnapshot();
                    return;
                }
                throw error;
            }

            try {
                guilds = parseSnapshot(JSON.parse(serialized));
            } catch (error) {
                await backupMalformedFile();
                guilds = {};
                await writeSnapshot();
            }
        });
    }

    async function add(guildId, listName, channelId) {
        return enqueue(async () => {
            if (typeof guildId !== 'string' || typeof channelId !== 'string') return false;
            if (listName !== 'whitelist' && listName !== 'blacklist') return false;

            const config = guilds[guildId] || { whitelist: [], blacklist: [] };
            const oppositeListName = listName === 'whitelist' ? 'blacklist' : 'whitelist';
            if (config[oppositeListName].includes(channelId) || config[listName].includes(channelId)) return false;

            config[listName].push(channelId);
            guilds[guildId] = config;
            await writeSnapshot();
            return true;
        });
    }

    async function remove(guildId, listName, channelId) {
        return enqueue(async () => {
            if (typeof guildId !== 'string' || typeof channelId !== 'string') return false;
            if (listName !== 'whitelist' && listName !== 'blacklist') return false;

            const config = guilds[guildId];
            if (!config) return false;

            const index = config[listName].indexOf(channelId);
            if (index === -1) return false;

            config[listName].splice(index, 1);
            await writeSnapshot();
            return true;
        });
    }

    async function flush() {
        await operationQueue;
    }

    return {
        load,
        getGuildConfig,
        add,
        remove,
        flush,
    };
}

module.exports = {
    STORE_VERSION,
    createChannelAccessStore,
};
