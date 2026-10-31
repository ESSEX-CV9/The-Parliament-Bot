const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep, setImmediate: yieldTurn } = require('node:timers/promises');
const { GatewayIntentBits, Routes } = require('discord.js');
const { ExportStore, DEFAULT_DIRECTORY } = require('./exportStore');
const { buildFile, verifyFile, splitFile } = require('./exportFiles');

function describeError(error) {
    if (/^(成员列表|任务|文件|附件|导出|Bot|本地存储)/.test(error?.message || '')) return error.message;
    const code = /^[A-Z_0-9]{1,50}$/.test(String(error?.code)) ? error.code : '未知';
    const status = Number(error?.status || error?.httpStatus) || '未知';
    const storageSyscalls = ['open', 'mkdir', 'chmod', 'fsync', 'fdatasync', 'write', 'read', 'rename', 'unlink', 'rmdir', 'scandir', 'stat', 'lstat', 'access', 'close', 'ftruncate'];
    if (status === '未知' && (String(code).startsWith('SQLITE_') || storageSyscalls.includes(error?.syscall))) {
        return `本地存储操作失败（code ${code}${storageSyscalls.includes(error?.syscall) ? `，操作 ${error.syscall}` : ''}）；请检查 data/member-id-export 的目录归属、读写权限及文件系统支持情况`;
    }
    return `Discord REST 请求失败（HTTP ${status}，code ${code}）${status === 401 || status === 403 ? '；请检查 Bot 授权及开发者后台 Server Members Intent 批准状态' : ''}`;
}

class ExportService {
    constructor(client, {
        directory = DEFAULT_DIRECTORY, retentionMs = 24 * 60 * 60 * 1000,
        requestTimeoutMs = 120000, maxRetries = 5, sleep: wait = sleep,
    } = {}) {
        this.client = client;
        this.directory = directory;
        this._store = null;
        this.owner = randomUUID();
        this.retentionMs = retentionMs;
        this.requestTimeoutMs = requestTimeoutMs;
        this.maxRetries = maxRetries;
        this.wait = wait;
        this.stopping = false;
        this.controller = new AbortController();
        this.downloads = new Set();
    }

    get store() {
        if (!this._store) this._store = new ExportStore(this.directory);
        return this._store;
    }

    latest(guildId) { return this.store.latest(guildId); }
    create(guildId) { return this.store.create(guildId); }

    start() {
        if (this.poller) return;
        this.poller = setInterval(() => this.kick(), 30000);
        this.poller.unref();
        this.cleaner = setInterval(() => this.cleanup().catch(error => console.error('[MemberIdExport] 自动清理失败：', describeError(error))), 60 * 60 * 1000);
        this.cleaner.unref();
        this.kick();
        void this.cleanup().catch(error => console.error('[MemberIdExport] 启动清理失败：', describeError(error)));
    }

    kick() {
        if (!this.stopping) void this.drain().catch(error => console.error('[MemberIdExport] 后台任务调度失败，稍后重试：', describeError(error)));
    }

    async request(route, query, signal = this.controller.signal) {
        const controller = new AbortController();
        let rejectAbort;
        const aborted = new Promise((_, reject) => { rejectAbort = reject; });
        const abort = () => {
            controller.abort();
            rejectAbort(Object.assign(new Error('导出请求已中断'), { code: 'ABORT_ERR' }));
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) controller.abort();
        let timer;
        try {
            // REST 本身处理 bucket/global 429；总时限也覆盖排队及内部重试。
            const deadline = new Promise((_, reject) => {
                timer = setTimeout(() => {
                    controller.abort();
                    reject(Object.assign(new Error('导出 API 请求超时'), { code: 'ETIMEDOUT' }));
                }, this.requestTimeoutMs);
            });
            return await Promise.race([this.client.rest.get(route, { query, signal: controller.signal }), deadline, aborted]);
        } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
        }
    }

    async check(guildId) {
        const result = {
            intentConfigured: this.client.options.intents.has(GatewayIntentBits.GuildMembers),
            restAccessible: false, estimate: null, error: null, estimateError: null,
            storageReady: false, storageError: null, directorySyncSupported: process.platform !== 'win32', platform: process.platform,
        };
        try {
            const page = await this.request(Routes.guildMembers(guildId), new URLSearchParams({ limit: '1', after: '0' }));
            if (!Array.isArray(page) || page.length > 1) throw new Error('成员列表 API 返回格式异常');
            result.restAccessible = true;
        } catch (error) { result.error = describeError(error); }
        try {
            const guild = await this.request(Routes.guild(guildId), new URLSearchParams({ with_counts: 'true' }));
            if (Number.isSafeInteger(guild.approximate_member_count)) result.estimate = guild.approximate_member_count;
        } catch (error) { result.estimateError = describeError(error); }
        try {
            this.store;
            result.storageReady = true;
        } catch (error) { result.storageError = describeError(error); }
        return result;
    }

    async page(job) {
        for (let attempt = 0; ; attempt++) {
            try {
                const page = await this.request(Routes.guildMembers(job.guildId), new URLSearchParams({ limit: '1000', after: job.after }));
                if (!Array.isArray(page) || page.length > 1000) throw new Error('成员列表 API 返回格式异常');
                return page.map(member => member?.user?.id);
            } catch (error) {
                if (this.stopping) throw error;
                const status = Number(error.status || error.httpStatus);
                const retryable = status === 429 || status >= 500 || !status && (error.name === 'AbortError' || [
                    'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
                    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'ABORT_ERR',
                ].includes(error.code));
                if (!retryable || attempt >= this.maxRetries) throw error;
                const retryAfter = status === 429
                    ? Number(error.rawError?.retry_after ?? error.retry_after ?? (error.retryAfter / 1000)) * 1000 : 0;
                const delay = Math.max(Number.isFinite(retryAfter) ? retryAfter : 0, Math.min(30000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250));
                const current = this.store.get(job.guildId, job.id);
                this.store.update(job.id, this.owner, {
                    retries: current.retries + 1, lastError: describeError(error), nextRetryAt: Date.now() + delay,
                });
                await this.wait(delay, undefined, { signal: this.controller.signal });
            }
        }
    }

    drain() {
        if (this.running) return this.running;
        this.running = this.runQueue().finally(() => { this.running = null; });
        return this.running;
    }

    async runQueue() {
        while (!this.stopping) {
            let job = this.store.claim(this.owner);
            if (!job) break;
            let artifact;
            const heartbeat = setInterval(() => {
                try { this.store.heartbeat(job.id, this.owner); }
                catch (_) { console.error('[MemberIdExport] 任务租约续期失败'); }
            }, 15000);
            heartbeat.unref();
            try {
                while (job.status === 'running' && !this.stopping) {
                    this.store.owned(job.id, this.owner, Date.now());
                    const ids = await this.page(job);
                    if (this.stopping) break;
                    job = this.store.commitPage(job.id, this.owner, ids);
                    await yieldTurn();
                }
                if (job.status === 'finalizing' && !this.stopping) {
                    this.store.owned(job.id, this.owner, Date.now());
                    artifact = await buildFile(this.store, job);
                    this.store.update(job.id, this.owner, {
                        status: 'completed', artifact, finishedAt: Date.now(), nextRetryAt: null,
                    });
                }
            } catch (error) {
                if (artifact) {
                    try {
                        const published = this.store.get(job.guildId, job.id)?.artifact?.name === artifact.name;
                        if (!published) await fsp.rm(path.join(this.store.directory, job.id, artifact.name), { force: true });
                    } catch (_) { /* 无法清理时由独立的残留文件清理轮次回收。 */ }
                }
                if (!this.stopping) {
                    try {
                        this.store.update(job.id, this.owner, {
                            status: 'failed', lastError: describeError(error), finishedAt: Date.now(), nextRetryAt: null,
                        });
                    } catch (_) { /* 租约过期时由持有者继续，旧 worker 不得覆盖状态。 */ }
                    console.warn(`[MemberIdExport] 任务 ${job.id} 暂停/失败：${describeError(error)}`);
                }
            } finally {
                clearInterval(heartbeat);
                this.store.release(job.id, this.owner);
            }
        }
    }

    async download(guildId, maxBytes) {
        const job = this.store.latestCompleted(guildId);
        if (!job) throw new Error('当前服务器暂无已完成的导出任务');
        if (job.guildId !== guildId || job.status !== 'completed' || !job.artifact) throw new Error('任务尚未完成或未通过校验');
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 21) throw new Error('附件大小限制无效');
        const token = this.store.pin(guildId, job.id);
        let pinValid = true;
        const heartbeat = setInterval(() => {
            try { if (!this.store.renewPin(token)) pinValid = false; }
            catch (_) {
                pinValid = false;
                console.warn('[MemberIdExport] 下载保留锁续期失败，停止后续交付');
            }
        }, 15000);
        heartbeat.unref();
        const scratch = path.join(this.store.directory, job.id, `download-${token}`);
        let released = false;
        const release = async () => {
            if (released) return;
            released = true;
            clearInterval(heartbeat);
            try { await fsp.rm(scratch, { recursive: true, force: true }); }
            finally {
                this.downloads.delete(release);
                this.store.unpin(token);
            }
        };
        this.downloads.add(release);
        try {
            if (!/^[a-f0-9-]+\.txt$/.test(job.artifact.name)) throw new Error('文件校验失败：路径无效');
            const filename = path.join(this.store.directory, job.id, job.artifact.name);
            const actual = await verifyFile(filename);
            if (actual.sha256 !== job.artifact.sha256 || actual.count !== job.count || actual.bytes !== job.artifact.bytes) {
                throw new Error('文件校验失败：摘要、行数或字节数不一致');
            }
            const files = actual.bytes <= maxBytes ? [{ attachment: filename, name: `members-${job.id}.txt` }]
                : await splitFile(filename, scratch, maxBytes);
            const assertValid = () => {
                if (!pinValid || !this.store.hasPin(token)) throw new Error('任务下载保留锁已失效，请重新下载');
            };
            assertValid();
            return { job, files, release, assertValid };
        } catch (error) {
            await release();
            throw new Error(`文件校验/准备失败：${describeError(error)}`);
        }
    }

    async cleanup(now = Date.now()) {
        // 先清文件，后删数据库；失败会保留状态并在下轮重试。
        for (const id of this.store.expired(now, this.retentionMs)) {
            if (!this.store.expire(id, now, this.retentionMs)) continue;
            await fsp.rm(path.join(this.store.directory, id), { recursive: true, force: true });
            this.store.remove(id);
        }
        // 崩溃后续传可能长期处于活动状态；按文件年龄清理未发布残留，
        // 不删除已发布文件、近期文件及仍持有保留锁的下载分片。
        for (const job of this.store.fileJobs()) {
            const directory = path.join(this.store.directory, job.id);
            let entries;
            try { entries = await fsp.readdir(directory, { withFileTypes: true }); }
            catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            for (const entry of entries) {
                if (entry.name === job.artifact?.name) continue;
                const download = entry.isDirectory() && entry.name.startsWith('download-');
                if (!download && !entry.name.endsWith('.txt') && !entry.name.endsWith('.txt.tmp')) continue;
                if (download && this.store.hasPin(entry.name.slice('download-'.length), now)) continue;
                const filename = path.join(directory, entry.name);
                try {
                    const stat = await fsp.lstat(filename);
                    if (stat.mtimeMs < now - this.retentionMs) await fsp.rm(filename, { recursive: download, force: true });
                } catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
        }
        this.store.db.prepare('DELETE FROM downloads WHERE expires_at<?').run(now);
        this.store.db.pragma('wal_checkpoint(PASSIVE)');
    }

    async stop() {
        if (this.stopping) return;
        this.stopping = true;
        clearInterval(this.poller);
        clearInterval(this.cleaner);
        this.controller.abort();
        if (this.running) await this.running;
        await Promise.all([...this.downloads].map(release => release()));
        if (this._store) this._store.close();
    }
}

const services = new WeakMap();
function getExportService(client) {
    if (!services.has(client)) services.set(client, new ExportService(client));
    return services.get(client);
}

module.exports = { ExportService, getExportService, describeError };
