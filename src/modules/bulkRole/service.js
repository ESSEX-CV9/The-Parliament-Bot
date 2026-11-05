const { randomUUID } = require('node:crypto');
const { RateLimitError } = require('discord.js');
const { setTimeout: sleep } = require('node:timers/promises');
const { Store } = require('./store');
const { Safety } = require('./safety');
const { parseIds } = require('./input');
const { Transport } = require('./transport');

function classify(error) {
    const status = Number(error?.status || error?.httpStatus);
    if (error?.code === 10007) return 'absent';
    if (status === 403 || [50013, 50001].includes(error?.code)) return 'forbidden';
    if (error?.code === 10011) return 'role_deleted';
    if (status === 429 || error instanceof RateLimitError) return 'rate_limit';
    if (status >= 500 && status < 600) return 'server';
    if (error?.name === 'AbortError' || ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'ABORT_ERR'].includes(error?.code)) return 'network';
    return 'api_error';
}

function retryDelay(error, failures) {
    const raw = Number(error?.rawError?.retry_after ?? error?.retry_after ?? (Math.max(error?.retryAfter || 0, error?.timeToReset || 0, error?.sublimitTimeout || 0) / 1000));
    const retryAfter = classify(error) === 'rate_limit' && Number.isFinite(raw) && raw >= 0 ? raw * 1000 : 0;
    return Math.max(retryAfter, Math.min(30000, 1000 * 2 ** failures));
}

class Service {
    constructor(client, { store, safety = new Safety(client), transport = new Transport(client), now = Date.now, wait = sleep, logger = console } = {}) {
        this.client = client;
        this._store = store;
        this.safety = safety;
        this.transport = transport;
        this.now = now;
        this.wait = wait;
        this.logger = logger;
        this.owner = randomUUID();
        this.stopping = false;
        this.watchers = new Map();
    }
    get store() { if (!this._store) this._store = new Store(); return this._store; }

    async preview(spec, input) {
        const parsed = parseIds(input);
        if (!['add', 'remove'].includes(spec.action)) throw new Error('操作必须为添加或移除。');
        const { guild } = await this.safety.check(spec);
        const counts = { change: 0, already: 0, absent: 0, other: 0 };
        for (const id of parsed.ids) {
            try {
                const member = await guild.members.fetch({ user: id, force: true, cache: false });
                const desired = member.roles.cache.has(spec.roleId) === (spec.action === 'add');
                counts[desired ? 'already' : 'change']++;
            } catch (error) { counts[classify(error) === 'absent' ? 'absent' : 'other']++; }
            await this.wait(50);
        }
        // Scanning may take time; validate again before issuing a live confirmation.
        await this.safety.check(spec);
        return this.store.createPreview(spec, parsed, counts, this.now());
    }

    async confirm(id, guildId, actorId) {
        const preview = this.store.requirePreview(id, guildId, actorId, this.now());
        await this.safety.check(preview);
        // Transaction checks expiry, replay and conflicts again after asynchronous auth.
        return this.store.confirm(id, guildId, actorId, this.now());
    }

    async result(id, guildId, actorId) {
        const job = id ? this.store.ownedJob(id, guildId, actorId) : this.store.latest(guildId, actorId);
        if (!job) throw new Error('任务不存在，您在此服务器还没有批量身份组任务。');
        await this.safety.authorize(job);
        return { job: this.store.get(job.id), rows: this.store.rows(job.id) };
    }

    async cancel(id, guildId, actorId) {
        const { job } = await this.result(id, guildId, actorId);
        return this.store.cancel(job.id, guildId, actorId, this.now());
    }

    async retryPreview(id, guildId, actorId) {
        const { job, rows } = await this.result(id, guildId, actorId);
        if (['queued', 'running'].includes(job.status)) throw new Error('请等待原任务结束后重试失败项。');
        const failed = rows.filter(row => row.status === 'failed');
        if (!failed.length) throw new Error('此任务没有最终失败成员。未执行成员可从结果附件重新提交。');
        return this.preview({ guildId, actorId, roleId: job.roleId, action: job.action, parentId: job.id }, failed.map(row => row.userId).join(','));
    }

    start() {
        if (this.poller || this.stopping) return;
        // Install polling before opening storage: kick() reports transient DB
        // failures, and the next tick retries initialization and deferred jobs.
        this.poller = setInterval(() => this.kick(), 5000);
        this.poller.unref();
        this.kick();
    }

    kick() {
        if (!this.stopping) void this.drain().catch(error => {
            this.logger.error('[BulkRole] 后台队列暂停，保留断点，下轮重新读取 Discord 状态：', error.code || error.name);
        });
    }

    drain() {
        if (this.running) return this.running;
        this.running = this.runQueue().finally(() => { this.running = null; });
        return this.running;
    }

    watch(id, callback) { this.watchers.set(id, { callback, expiresAt: this.now() + 14 * 60000, updatedAt: 0 }); }

    async notify(job) {
        const watcher = this.watchers.get(job.id);
        if (!watcher) return;
        const final = !['queued', 'running'].includes(job.status);
        if (watcher.expiresAt <= this.now()) { this.watchers.delete(job.id); return; }
        if (!final && this.now() - watcher.updatedAt < 5000) return;
        watcher.updatedAt = this.now();
        try {
            // Never disclose member result lists after the actor's permission is revoked.
            await this.safety.authorize(job);
            await watcher.callback({ job, rows: this.store.rows(job.id) });
        } catch (_) { this.watchers.delete(job.id); }
        if (final) this.watchers.delete(job.id);
    }

    async runQueue() {
        this.store.expirePreviews(this.now());
        for (const [id, watcher] of this.watchers) if (watcher.expiresAt <= this.now()) this.watchers.delete(id);
        while (!this.stopping) {
            const job = this.store.claim(this.owner, this.now());
            if (!job) break;
            let leaseLost = false;
            const heartbeat = setInterval(() => {
                try { this.store.heartbeat(this.owner, this.now()); }
                catch (_) { leaseLost = true; }
            }, 10000);
            heartbeat.unref();
            const assertActive = () => {
                if (leaseLost) throw new Error('任务租约已失效。');
                this.store.assertLease(this.owner, this.now());
            };
            try { await this.runJob(job, assertActive); }
            finally {
                clearInterval(heartbeat);
                this.store.release(this.owner);
            }
            await this.notify(this.store.get(job.id));
        }
    }

    async stopForSafety(job, error) {
        const reason = error?.code === 'SAFETY' ? error.message : `无法刷新关键权限或安全配置（${classify(error)}），停止剩余操作。`;
        this.store.finish(job.id, this.owner, 'stopped', reason, this.now());
    }

    async runJob(job, assertActive) {
        let context;
        try { context = await this.safety.check(job); }
        catch (error) { await this.stopForSafety(job, error); return; }
        const finishCancelled = () => this.reconcileCancellation(job, context, assertActive);
        for (const row of this.store.rows(job.id)) {
            if (!['pending', 'inflight'].includes(row.status)) continue;
            if (this.stopping) return;
            assertActive();
            if (this.store.get(job.id).cancelRequested) { await finishCancelled(); return; }
            await this.wait(250);
            if (this.stopping) return;
            let member, readError;
            try { member = await context.guild.members.fetch({ user: row.userId, force: true, cache: false }); }
            catch (error) { readError = error; }
            // Last asynchronous check before any mutation; includes live automation config.
            try { context = await this.safety.check(job); }
            catch (error) { await this.stopForSafety(job, error); return; }
            assertActive();
            if (this.stopping) return;
            if (this.store.get(job.id).cancelRequested) { await finishCancelled(); return; }
            if (readError) {
                if (classify(readError) === 'absent') this.store.settle(job.id, row.userId, this.owner, 'absent', 'absent', this.now());
                else if (this.handleError(job, row, readError, 'read')) return;
                await this.notify(this.store.get(job.id));
                continue;
            }
            const desired = member.roles.cache.has(job.roleId) === (job.action === 'add');
            if (desired) {
                this.store.settle(job.id, row.userId, this.owner, row.uncertain ? 'reconciled' : 'already', null, this.now());
                await this.notify(this.store.get(job.id));
                continue;
            }
            if (row.attempts >= 4) {
                this.store.settle(job.id, row.userId, this.owner, 'failed', 'retry_exhausted', this.now());
                continue;
            }
            // This transaction MUST succeed before calling Discord. DB exceptions propagate,
            // leaving inflight evidence intact instead of being classified as API failures.
            this.store.begin(job.id, row.userId, this.owner, this.now());
            assertActive();
            let operationError;
            try {
                await this.transport.change(job, row.userId);
            } catch (error) { operationError = error; }
            if (operationError) {
                if (classify(operationError) === 'absent') this.store.settle(job.id, row.userId, this.owner, 'absent', 'absent', this.now());
                else if (this.handleError(job, row, operationError, 'write')) return;
            } else {
                this.store.settle(job.id, row.userId, this.owner, 'success', null, this.now());
            }
            await this.notify(this.store.get(job.id));
        }
        if (!this.stopping) {
            if (this.store.get(job.id).cancelRequested) await finishCancelled();
            else this.store.finish(job.id, this.owner, 'completed', null, this.now());
        }
    }

    async reconcileCancellation(job, context, assertActive) {
        // A recovered inflight request may already have applied. Cancellation must
        // reconcile its outcome, while never starting another mutation.
        for (const row of this.store.rows(job.id).filter(r => r.status === 'inflight')) {
            if (this.stopping) return;
            assertActive();
            let member, readError;
            try { member = await context.guild.members.fetch({ user: row.userId, force: true, cache: false }); }
            catch (error) { readError = error; }
            try { await this.safety.check(job); }
            catch (error) { await this.stopForSafety(job, error); return; }
            assertActive();
            if (readError) {
                if (classify(readError) === 'absent') this.store.settle(job.id, row.userId, this.owner, 'absent', 'absent', this.now());
                else if (this.handleError(job, row, readError, 'read')) return;
            } else {
                const desired = member.roles.cache.has(job.roleId) === (job.action === 'add');
                this.store.settle(job.id, row.userId, this.owner, desired ? 'reconciled' : 'unexecuted', desired ? null : 'cancelled_before_state_reached', this.now());
            }
        }
        this.store.finish(job.id, this.owner, 'cancelled', '操作者取消；已完成的修改不撤销。', this.now());
    }

    handleError(job, row, error, phase) {
        const kind = classify(error);
        const reason = `${phase}_${kind}`;
        if (['rate_limit', 'server', 'network'].includes(kind) && row.failures < 3) {
            // Persist the wait instead of sleeping with a long-lived interaction or lease.
            this.store.postpone(job.id, row.userId, this.owner, this.now() + retryDelay(error, row.failures), reason, this.now());
            return true;
        }
        this.store.settle(job.id, row.userId, this.owner, 'failed', reason, this.now());
        if (['forbidden', 'role_deleted'].includes(kind)) {
            this.store.finish(job.id, this.owner, 'stopped', reason, this.now());
            return true;
        }
        return false;
    }

    async stop() {
        this.stopping = true;
        clearInterval(this.poller);
        if (this.running) await this.running.catch(() => {});
        this.watchers.clear();
        this.transport.close();
        if (this._store) this._store.close();
    }
}

const services = new WeakMap();
function getService(client) {
    if (!services.has(client)) services.set(client, new Service(client));
    return services.get(client);
}
module.exports = { Service, getService, classify };
