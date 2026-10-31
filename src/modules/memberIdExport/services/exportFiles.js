const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { setImmediate: yieldTurn } = require('node:timers/promises');
const { validId } = require('./exportStore');

async function* lines(filename) {
    let pending = '';
    const stream = fs.createReadStream(filename, { encoding: 'utf8' });
    try {
        for await (const chunk of stream) {
            const parts = (pending + chunk).split('\n');
            pending = parts.pop();
            if (pending.length > 20) throw new Error('文件校验失败：ID 行过长');
            for (const line of parts) {
                if (!validId(line)) throw new Error('文件校验失败：无效 ID');
                yield line;
            }
        }
        if (pending) throw new Error('文件校验失败：末行不完整');
    } finally { stream.destroy(); }
}

async function verifyFile(filename) {
    const hash = createHash('sha256');
    let count = 0;
    let bytes = 0;
    for await (const id of lines(filename)) {
        hash.update(`${id}\n`);
        bytes += id.length + 1;
        count++;
    }
    return { sha256: hash.digest('hex'), count, bytes };
}

async function syncDirectory(directory) {
    const handle = await fsp.open(directory, 'r');
    try { await handle.sync(); }
    finally { await handle.close(); }
}

async function buildFile(store, job) {
    const directory = path.join(store.directory, job.id);
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    // 先持久化新任务目录，再允许发布其中的文件。
    await syncDirectory(store.directory);
    const name = `${randomUUID()}.txt`;
    const temporary = path.join(directory, `${name}.tmp`);
    const filename = path.join(directory, name);
    try {
        const handle = await fsp.open(temporary, 'wx', 0o600);
        const hash = createHash('sha256');
        let ordinal = 0;
        let count = 0;
        try {
            for (;;) {
                const rows = store.rows(job.id, ordinal);
                if (!rows.length) break;
                const text = rows.map(row => `${row.id}\n`).join('');
                await handle.writeFile(text);
                hash.update(text);
                count += rows.length;
                ordinal = rows[rows.length - 1].ordinal;
                await yieldTurn();
            }
            await handle.sync();
        } finally { await handle.close(); }
        if (count !== job.count || count !== store.count(job.id)) throw new Error('文件校验失败：数据库计数不一致');
        await fsp.rename(temporary, filename);
        await syncDirectory(directory);
        const actual = await verifyFile(filename);
        if (actual.count !== count || actual.sha256 !== hash.digest('hex')) throw new Error('文件校验失败：摘要或行数不一致');
        return { name, ...actual };
    } catch (error) {
        await Promise.allSettled([fsp.rm(temporary, { force: true }), fsp.rm(filename, { force: true })]);
        throw error;
    }
}

// 每个附件为完整 TXT，按行分片；避免压缩包依赖和单次读入全部 ID。
async function splitFile(filename, directory, maxBytes) {
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    const files = [];
    let handle = null;
    let bytes = 0;
    let buffer = '';
    async function flush() {
        if (handle && buffer) await handle.writeFile(buffer);
        buffer = '';
    }
    async function openPart() {
        await flush();
        if (handle) await handle.close();
        const name = `members-${String(files.length + 1).padStart(3, '0')}.txt`;
        const attachment = path.join(directory, name);
        handle = await fsp.open(attachment, 'wx', 0o600);
        files.push({ attachment, name });
        bytes = 0;
    }
    try {
        for await (const id of lines(filename)) {
            const line = `${id}\n`;
            if (line.length > maxBytes) throw new Error('附件限制不足以容纳一行 ID');
            if (!handle || bytes + line.length > maxBytes) await openPart();
            buffer += line;
            bytes += line.length;
            if (buffer.length >= 65536) await flush();
        }
        await flush();
    } finally { if (handle) await handle.close(); }
    return files;
}

module.exports = { buildFile, verifyFile, splitFile };
