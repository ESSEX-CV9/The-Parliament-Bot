const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { parseIds } = require('./input');

const DEFAULT_FILE = path.join(__dirname, '../../../data/bulk-role/jobs.sqlite');
const LEASE_MS = 120000;
const ACTIVE = ['queued', 'running'];

class Store {
    constructor(filename = DEFAULT_FILE) {
        fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
        this.db = new Database(filename);
        try {
            fs.chmodSync(filename, 0o600);
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('synchronous = FULL');
            this.db.pragma('foreign_keys = ON');
            this.db.pragma('busy_timeout = 5000');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS previews (
                    id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, actor_id TEXT NOT NULL,
                    status TEXT NOT NULL, expires_at INTEGER NOT NULL, payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, actor_id TEXT NOT NULL,
                    role_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('add','remove')),
                    status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                    finished_at INTEGER, cancel_requested INTEGER NOT NULL DEFAULT 0,
                    reason TEXT, next_at INTEGER NOT NULL DEFAULT 0, parent_id TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS one_active_guild ON jobs(guild_id) WHERE status IN ('queued','running');
                CREATE TABLE IF NOT EXISTS members (
                    job_id TEXT NOT NULL REFERENCES jobs(id), user_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
                    reason TEXT, uncertain INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(job_id,user_id)
                );
                CREATE TABLE IF NOT EXISTS worker_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, until_ms INTEGER NOT NULL);
                INSERT OR IGNORE INTO worker_lock VALUES(1,NULL,0);
                -- Audit deliberately has no cascading foreign key and no automatic retention cleanup.
                CREATE TABLE IF NOT EXISTS audit (
                    id INTEGER PRIMARY KEY, job_id TEXT, at INTEGER NOT NULL, event TEXT NOT NULL, detail TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS audit_job ON audit(job_id,id);
            `);
        } catch (error) { this.db.close(); throw error; }
    }

    log(id, event, detail, now) {
        this.db.prepare('INSERT INTO audit(job_id,at,event,detail) VALUES(?,?,?,?)').run(id, now, event, JSON.stringify(detail));
    }

    preview(id) {
        const row = this.db.prepare('SELECT * FROM previews WHERE id=?').get(id);
        return row ? { ...JSON.parse(row.payload), id: row.id, status: row.status, expiresAt: row.expires_at } : null;
    }

    createPreview(spec, parsed, counts, now = Date.now()) {
        if (!['add', 'remove'].includes(spec.action)) throw new Error('无效操作。');
        const checked = parseIds(parsed.ids.join(','));
        if (checked.ids.length !== parsed.ids.length) throw new Error('预览成员列表必须去重。');
        const id = randomUUID();
        const payload = { ...spec, ids: checked.ids, inputCount: parsed.inputCount, counts };
        this.db.prepare('INSERT INTO previews VALUES(?,?,?,?,?,?)').run(id, spec.guildId, spec.actorId, 'ready', now + 300000, JSON.stringify(payload));
        return this.preview(id);
    }

    requirePreview(id, guildId, actorId, now) {
        const preview = this.preview(id);
        if (!preview || preview.guildId !== guildId || preview.actorId !== actorId) throw new Error('只有原始操作者可以操作此预览。');
        if (preview.status !== 'ready') throw new Error('预览已经处理，不能重复提交。');
        if (preview.expiresAt <= now) throw new Error('预览已过期，请重新发起。');
        return preview;
    }

    cancelPreview(id, guildId, actorId, now = Date.now()) {
        return this.db.transaction(() => {
            this.requirePreview(id, guildId, actorId, now);
            this.db.prepare("UPDATE previews SET status='cancelled' WHERE id=?").run(id);
        }).immediate();
    }

    confirm(id, guildId, actorId, now = Date.now()) {
        return this.db.transaction(() => {
            const preview = this.requirePreview(id, guildId, actorId, now);
            if (this.db.prepare("SELECT 1 FROM jobs WHERE guild_id=? AND status IN ('queued','running')").get(guildId)) throw new Error('此服务器已有活动任务，请等待完成或取消后再确认。');
            const jobId = randomUUID();
            this.db.prepare(`INSERT INTO jobs(id,guild_id,actor_id,role_id,action,status,created_at,updated_at,parent_id)
                VALUES(?,?,?,?,?,'queued',?,?,?)`).run(jobId, guildId, actorId, preview.roleId, preview.action, now, now, preview.parentId || null);
            const insert = this.db.prepare('INSERT INTO members(job_id,user_id,ordinal) VALUES(?,?,?)');
            preview.ids.forEach((userId, i) => insert.run(jobId, userId, i));
            this.db.prepare("UPDATE previews SET status='consumed' WHERE id=?").run(id);
            this.log(jobId, 'created', { actorId, guildId, roleId: preview.roleId, action: preview.action, count: preview.ids.length, parentId: preview.parentId || null }, now);
            return this.get(jobId);
        }).immediate();
    }

    get(id) {
        const r = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
        return r ? { id: r.id, guildId: r.guild_id, actorId: r.actor_id, roleId: r.role_id, action: r.action,
            status: r.status, createdAt: r.created_at, updatedAt: r.updated_at, finishedAt: r.finished_at,
            cancelRequested: Boolean(r.cancel_requested), reason: r.reason, nextAt: r.next_at, parentId: r.parent_id } : null;
    }

    rows(id) {
        return this.db.prepare('SELECT user_id AS userId,status,attempts,reason,uncertain,failures FROM members WHERE job_id=? ORDER BY ordinal').all(id);
    }

    latest(guildId, actorId) {
        const row = this.db.prepare('SELECT id FROM jobs WHERE guild_id=? AND actor_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(guildId, actorId);
        return row ? this.get(row.id) : null;
    }

    ownedJob(id, guildId, actorId) {
        const job = this.get(id);
        if (!job || job.guildId !== guildId || job.actorId !== actorId) throw new Error('任务不存在，或您不是此任务的原始操作者。');
        return job;
    }

    cancel(id, guildId, actorId, now = Date.now()) {
        return this.db.transaction(() => {
            const job = this.ownedJob(id, guildId, actorId);
            if (!ACTIVE.includes(job.status)) return job;
            this.db.prepare('UPDATE jobs SET cancel_requested=1,updated_at=?,next_at=0 WHERE id=?').run(now, id);
            this.log(id, 'cancel_requested', { actorId }, now);
            return this.get(id);
        }).immediate();
    }

    claim(owner, now = Date.now()) {
        return this.db.transaction(() => {
            const lock = this.db.prepare('SELECT * FROM worker_lock WHERE id=1').get();
            if (lock.owner && lock.until_ms > now) return null;
            const row = this.db.prepare("SELECT id FROM jobs WHERE status IN ('queued','running') AND next_at<=? ORDER BY created_at,rowid LIMIT 1").get(now);
            if (!row) return null;
            this.db.prepare('UPDATE worker_lock SET owner=?,until_ms=? WHERE id=1').run(owner, now + LEASE_MS);
            this.db.prepare("UPDATE jobs SET status='running',updated_at=? WHERE id=?").run(now, row.id);
            this.log(row.id, 'claimed', { owner }, now);
            return this.get(row.id);
        }).immediate();
    }

    assertLease(owner, now = Date.now()) {
        const lock = this.db.prepare('SELECT * FROM worker_lock WHERE id=1').get();
        if (lock.owner !== owner || lock.until_ms <= now) throw new Error('任务租约已失效，停止执行。');
    }

    heartbeat(owner, now = Date.now()) {
        const result = this.db.prepare('UPDATE worker_lock SET until_ms=? WHERE id=1 AND owner=? AND until_ms>?').run(now + LEASE_MS, owner, now);
        if (!result.changes) throw new Error('任务租约续期失败。');
    }

    release(owner) { this.db.prepare('UPDATE worker_lock SET owner=NULL,until_ms=0 WHERE id=1 AND owner=?').run(owner); }

    begin(id, userId, owner, now = Date.now()) {
        return this.db.transaction(() => {
            this.assertLease(owner, now);
            const job = this.get(id);
            if (!job || !ACTIVE.includes(job.status) || job.cancelRequested) throw new Error('任务已停止或取消。');
            const result = this.db.prepare(`UPDATE members SET status='inflight',attempts=attempts+1,uncertain=1
                WHERE job_id=? AND user_id=? AND status IN ('pending','inflight') AND attempts<4`).run(id, userId);
            if (!result.changes) throw new Error('成员已处理或超过尝试次数。');
            this.db.prepare('UPDATE jobs SET updated_at=? WHERE id=?').run(now, id);
            this.log(id, 'request_started', { userId }, now);
        }).immediate();
    }

    settle(id, userId, owner, status, reason = null, now = Date.now()) {
        if (!['success', 'already', 'absent', 'failed', 'reconciled', 'unexecuted'].includes(status)) throw new Error('无效成员终态。');
        return this.db.transaction(() => {
            this.assertLease(owner, now);
            const result = this.db.prepare(`UPDATE members SET status=?,reason=?,uncertain=CASE WHEN ?='failed' THEN uncertain ELSE 0 END
                WHERE job_id=? AND user_id=? AND status IN ('pending','inflight')`).run(status, reason, status, id, userId);
            if (!result.changes) throw new Error('成员结果不能重复提交。');
            this.db.prepare('UPDATE jobs SET updated_at=?,next_at=0 WHERE id=?').run(now, id);
            this.log(id, status, { userId, reason }, now);
        }).immediate();
    }

    postpone(id, userId, owner, nextAt, reason, now = Date.now()) {
        this.db.transaction(() => {
            this.assertLease(owner, now);
            this.db.prepare('UPDATE members SET failures=failures+1,reason=? WHERE job_id=? AND user_id=?').run(reason, id, userId);
            this.db.prepare('UPDATE jobs SET next_at=?,reason=?,updated_at=? WHERE id=?').run(nextAt, reason, now, id);
            this.log(id, 'retry_wait', { nextAt, reason }, now);
        }).immediate();
    }

    finish(id, owner, status = 'completed', reason = null, now = Date.now()) {
        if (!['completed', 'stopped', 'cancelled'].includes(status)) throw new Error('无效任务终态。');
        return this.db.transaction(() => {
            this.assertLease(owner, now);
            const job = this.get(id);
            if (!job || !ACTIVE.includes(job.status)) throw new Error('任务已结束。');
            this.db.prepare("UPDATE members SET status='unexecuted',reason=? WHERE job_id=? AND status IN ('pending','inflight')").run(reason, id);
            this.db.prepare('UPDATE jobs SET status=?,reason=?,updated_at=?,finished_at=?,next_at=0 WHERE id=?').run(status, reason, now, now, id);
            this.log(id, status, { reason }, now);
            return this.get(id);
        }).immediate();
    }

    expirePreviews(now = Date.now()) {
        this.db.prepare("UPDATE previews SET status='expired' WHERE status='ready' AND expires_at<=?").run(now);
        // Preview ID lists are transient, not task results/audit history.
        this.db.prepare('DELETE FROM previews WHERE expires_at<?').run(now - 86400000);
    }

    close() { if (this.db.open) this.db.close(); }
}

module.exports = { Store, DEFAULT_FILE, LEASE_MS };
