const { randomUUID } = require('node:crypto');
const { AuditLogEvent, PermissionFlagsBits: P } = require('discord.js');
const { Store } = require('./store');
const { Safety, validateId } = require('./safety');
const { SafetyError, describe, definiteRejection } = require('./errors');
const { Transport } = require('./transport');
const { marker, announcementPayload, findAnnouncement, correctAnnouncement } = require('./announcements');

const snapshot = thread => ({ locked: Boolean(thread.locked), archived: Boolean(thread.archived), archiveTimestamp: thread.archiveTimestamp ?? null, lastMessageId: thread.lastMessageId ?? null });
const sameState = (a, b) => a.locked === b.locked && a.archived === b.archived;
const sameVersion = (a, b) => sameState(a, b) && a.archiveTimestamp === b.archiveTimestamp;
const sameSnapshot = (a, b) => sameVersion(a, b) && a.lastMessageId === b.lastMessageId;
const desiredState = op => ({ locked: op.action === 'lock', archived: op.action === 'lock' });

class Service {
    constructor(client, { store = new Store(), transport, checkPermission, now = Date.now, leaseMs = 120000 } = {}) {
        this.client = client;
        this.store = store;
        this.transport = transport || new Transport(client);
        this.safety = new Safety(client, store, { checkPermission });
        this.now = now;
        this.leaseMs = leaseMs;
        this.owner = randomUUID();
        this.requests = new Map();
        this.threads = new Set();
        this.stopping = false;
        this.ready = null;
    }

    start() {
        if (this.stopping) return Promise.reject(new SafetyError('锁帖模块正在停止。'));
        if (this.ready) return this.ready;
        this.ready = (async () => {
            if (!this.store.lease(this.owner, this.now(), this.leaseMs)) throw new SafetyError('锁帖模块正在由其他进程执行或等待重启租约到期，请稍后重试。');
            this.timer = setInterval(() => {
                try {
                    // An expired lease is never renewed by an old worker.
                    if (!this.store.owns(this.owner, this.now())) return;
                    this.store.lease(this.owner, this.now(), this.leaseMs);
                } catch (error) { console.error('[ThreadModeration] worker lease renewal failed:', describe(error)); }
            }, Math.min(20000, this.leaseMs / 3));
            this.timer.unref?.();
            await this.recover();
        })().catch(error => { clearInterval(this.timer); this.ready = null; throw error; });
        return this.ready;
    }

    fence() {
        if (!this.store.owns(this.owner, this.now())) throw new SafetyError('锁帖进程租约失效，已停止后续操作，需恢复核验。');
    }

    save(op, patch) {
        this.fence();
        // Keep the response/message ID in memory even when the journal write fails.
        Object.assign(op, patch);
        return this.store.update(op.id, patch);
    }

    async rawThread(op) {
        const guild = await this.client.guilds.fetch(op.guildId);
        const thread = await guild.channels.fetch(op.threadId, { force: true });
        if (!thread?.isThread?.() || thread.guildId !== op.guildId || thread.parentId !== op.parentId) throw new SafetyError('原帖子已删除、跨服或父频道不匹配，需人工核验。');
        return thread;
    }

    async checked(op) {
        const context = await this.safety.target(op);
        this.fence();
        if (context.parent.id !== op.parentId) throw new SafetyError('帖子真实父频道发生变化。');
        if (!sameVersion(snapshot(context.thread), op.expected || op.before)) throw new SafetyError('帖子状态已被其他操作修改，已停止本次操作。');
        return context;
    }

    run(spec) {
        if (this.stopping) return Promise.reject(new SafetyError('锁帖模块正在停止。'));
        const existing = this.requests.get(spec.id);
        if (existing) return existing;
        const key = `${spec.guildId}:${spec.threadId}`;
        if (this.threads.has(key)) return Promise.reject(new SafetyError('该帖子正在执行操作，请等待完成。'));
        this.threads.add(key);
        const task = this.execute(spec).finally(() => { this.threads.delete(key); this.requests.delete(spec.id); });
        this.requests.set(spec.id, task);
        return task;
    }

    async execute(spec) {
        validateId(spec.id);
        validateId(spec.threadId);
        if (!['lock', 'unlock'].includes(spec.action)) throw new SafetyError('无效锁帖操作。');
        if (spec.action === 'lock' && (typeof spec.reason !== 'string' || !spec.reason.trim() || [...spec.reason.trim()].length > 300)) throw new SafetyError('锁帖原因必须是 1～300 字。');
        await this.start();
        const context = await this.safety.target(spec);
        this.fence();
        const previous = this.store.get(spec.id);
        if (previous) {
            if (previous.guildId !== spec.guildId || previous.actorId !== spec.actorId || previous.threadId !== spec.threadId || previous.action !== spec.action) throw new SafetyError('请求 ID 与原操作不匹配。');
            return { ...previous, replayed: true, feedback: `该请求之前已处理，不会重复执行。以下为当时结果：\n${previous.feedback || previous.status}` };
        }
        const before = snapshot(context.thread);
        const op = this.store.create({ ...spec, reason: spec.action === 'lock' ? spec.reason.trim() : null, parentId: context.parent.id, before });
        if ((spec.action === 'lock' && before.locked && before.archived) || (spec.action === 'unlock' && !before.locked)) {
            return this.save(op, { status: 'succeeded', outcome: 'noop', feedback: spec.action === 'lock' ? '该帖子已经锁定且归档，无需重复执行。' : '该帖子并未锁定，无需解锁（仅归档不会解除归档）。' });
        }
        try {
            if (spec.action === 'lock') {
                if (before.archived) await this.change(op, { locked: before.locked, archived: false }, 'unarchive');
                await this.announce(op);
                await this.change(op, { locked: true, archived: true }, 'lock');
            } else {
                await this.change(op, { locked: false, archived: false }, 'unlock');
                await this.announce(op);
            }
            const actual = snapshot(await this.rawThread(op));
            if (!sameState(actual, desiredState(op))) throw new SafetyError('最终核验发现帖子状态已变化。');
            return this.save(op, { status: 'succeeded', phase: 'completed', actual, feedback: op.action === 'lock' ? '锁帖公示已发送，帖子已锁定并归档。' : '帖子已解锁并解除归档，解锁公示已发送。' });
        } catch (error) {
            try { return await this.reconcile(op, error, false); }
            catch (recoveryError) {
                console.error(`[ThreadModeration] reconcile failed operation=${op.id}:`, describe(recoveryError));
                try { this.save(op, { status: 'review', error: describe(error), recovery: `核验未完成：${describe(recoveryError)}` }); }
                catch (_) { /* Last durable intent still blocks the thread. */ }
                // The last durable intent remains unfinished and blocks new operations.
                return { ...op, status: 'review', error: describe(error), feedback: '操作结果或数据库写入无法确认，禁止重复操作；请管理员检查持久化记录并在重启后核验。' };
            }
        }
    }

    async change(op, desired, phase) {
        const { thread } = await this.checked(op);
        const intent = { before: snapshot(thread), desired, reason: `${marker(op)}:${phase}` };
        this.save(op, { phase: `${phase}_intent`, intent, stateUncertain: true, finalAttempted: phase === 'lock' || phase === 'unlock' || Boolean(op.finalAttempted) });
        let error;
        try { await this.transport.editThread(thread, { ...desired, reason: intent.reason }); }
        catch (caught) { error = caught; }
        if (error && definiteRejection(error)) this.save(op, { stateUncertain: false, lastWriteReason: null, intent: { ...intent, rejected: true } });
        // A rejected/timeout request may still have been applied. Always read back.
        const actual = snapshot(await this.rawThread(op));
        if (!sameState(actual, desired)) throw error || new SafetyError('Discord 未应用预期的帖子状态。');
        this.save(op, { phase: `${phase}_verified`, expected: actual, intent: null, stateUncertain: false,
            lastWriteReason: error && definiteRejection(error) ? null : intent.reason });
    }

    async announce(op) {
        const { thread } = await this.checked(op);
        this.save(op, { phase: 'announcement_intent', sendAttempted: true });
        let message;
        try {
            message = await this.transport.send(thread, { ...announcementPayload(op), nonce: op.id, enforceNonce: true });
        } catch (error) {
            this.save(op, { sendUncertain: !definiteRejection(error), sendRejected: definiteRejection(error) });
            if (definiteRejection(error)) throw error;
            const located = await findAnnouncement(await this.rawThread(op), op, this.client.user.id);
            message = located.message;
            if (!message) throw error;
        }
        this.save(op, { messageId: message.id, sendUncertain: false, phase: 'announced' });
        const actual = snapshot(await this.rawThread(op));
        // Sending must not silently adopt someone else's thread state changes.
        if (!sameVersion(actual, op.expected || op.before)) throw new SafetyError('发送公示期间帖子状态发生变化。');
        this.save(op, { expected: actual });
    }

    async ownedChange(op, thread) {
        const current = snapshot(thread);
        const expected = op.expected || op.before;
        // An unacknowledged intent has no trustworthy archiveTimestamp. Matching
        // booleans and an eventually-consistent audit entry cannot establish that
        // another administrator has not changed the thread since that request.
        if (!sameSnapshot(current, expected) || !op.lastWriteReason) return false;
        const bot = await thread.guild.members.fetch({ user: this.client.user.id, force: true, cache: false });
        if (!thread.permissionsFor(bot)?.has(P.ViewAuditLog)) return false;
        const logs = await thread.guild.fetchAuditLogs({ type: AuditLogEvent.ThreadUpdate, limit: 50 });
        const latest = logs.entries.find(entry => entry.target?.id === op.threadId);
        if (!latest || latest.executor?.id !== this.client.user.id || latest.reason !== op.lastWriteReason || latest.createdTimestamp < op.createdAt - 1000) return false;
        // Check again after the audit request; Discord has no atomic compare-and-set.
        return sameSnapshot(current, snapshot(await this.rawThread(op)));
    }

    async restore(op, thread) {
        if (sameState(snapshot(thread), op.before)) return '原始锁定/归档状态未改变';
        // Revocation must stop state writes, including compensating writes.
        await this.safety.target(op);
        this.fence();
        if (!await this.ownedChange(op, thread)) return '无法证明状态仍由本操作持有，未覆盖后续操作';
        const expected = snapshot(thread);
        const { thread: fresh } = await this.safety.target(op);
        this.fence();
        if (!sameSnapshot(expected, snapshot(fresh))) return '状态再次变化，未恢复';
        this.save(op, { phase: 'recovery_intent', recoveryExpected: expected });
        let error;
        try { await this.transport.editThread(fresh, { locked: op.before.locked, archived: op.before.archived, reason: `${marker(op)}:restore` }); }
        catch (caught) { error = caught; }
        const actual = snapshot(await this.rawThread(op));
        if (!sameState(actual, op.before)) throw error || new SafetyError('原始状态恢复未生效。');
        return '已安全恢复原始锁定/归档状态';
    }

    async reconcile(op, error, restarting) {
        this.fence();
        const thread = await this.rawThread(op);
        let actual = snapshot(thread);
        const found = await findAnnouncement(thread, op, this.client.user.id);
        if (found.message) op.messageId = found.message.id;
        const successNotice = found.message?.embeds?.some(embed => embed.title === (op.action === 'lock' ? '🔒 子区已锁定' : '🔓 子区已解锁'));
        if (op.finalAttempted && sameState(actual, desiredState(op)) && successNotice) {
            return this.save(op, { status: 'succeeded', phase: 'completed', actual, messageId: found.message.id, recovery: '已核验公示和实际状态', feedback: '已核验公示和帖子实际状态，操作已完成。' });
        }
        const detail = describe(error);
        this.save(op, { status: 'review', error: detail, phase: 'reconciling', actual, messageId: op.messageId });
        let recovery;
        try { recovery = await this.restore(op, thread); }
        catch (caught) { recovery = `未恢复：${describe(caught)}`; }
        actual = snapshot(await this.rawThread(op));
        this.fence();
        const corrected = await correctAnnouncement(found.message, op, actual, this.transport, () => this.fence());
        const uncertain = !found.complete || ((op.stateUncertain || (op.sendAttempted && !op.sendRejected && !found.message))
            && (!restarting || this.now() - op.createdAt < this.leaseMs));
        const restored = sameState(actual, op.before);
        const status = restored && corrected && !uncertain ? 'failed' : 'review';
        const feedback = [
            op.action === 'unlock' && !restored && !found.message ? '状态已变化但公示失败。' : '操作未完成。',
            detail, recovery,
            corrected ? '错误公示已处理或未发现公示。' : '公示修正失败，请人工处理。',
            uncertain ? 'Discord 请求结果仍不确定，已阻止该帖后续操作。' : '',
            `核验时状态：${actual.locked ? '锁定' : '未锁定'}、${actual.archived ? '已归档' : '未归档'}。`,
        ].filter(Boolean).join('\n');
        return this.save(op, { status, actual, recovery, noticeCorrected: corrected, feedback });
    }

    async recover() {
        this.fence();
        for (const op of this.store.unfinished()) {
            try { await this.reconcile(op, new SafetyError('进程重启或上次操作中断，正在核验。'), true); }
            catch (error) {
                console.error(`[ThreadModeration] recovery requires attention operation=${op.id}:`, describe(error));
                this.save(op, { status: 'review', error: describe(error), recovery: '核验未完成，保留互斥记录供下次启动恢复' });
            }
        }
    }

    async stop() {
        this.stopping = true;
        if (this.ready) await Promise.allSettled([this.ready]);
        await Promise.allSettled([...this.requests.values()]);
        clearInterval(this.timer);
        this.store.release(this.owner);
        this.transport.close?.();
    }
}

module.exports = { Service, snapshot };
