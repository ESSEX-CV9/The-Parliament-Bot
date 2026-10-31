const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');

const ACTIVE = ['queued', 'running', 'finalizing'];
const DEFAULT_DIRECTORY = path.join(__dirname, '../../../../data/member-id-export');

function validId(id) {
    return typeof id === 'string' && /^[1-9]\d{0,19}$/.test(id)
        && BigInt(id) <= 18446744073709551615n;
}

// 同项目其他模块使用独立 SQLite；ID、计数、游标必须在同一事务中提交。
class ExportStore {
    constructor(directory = DEFAULT_DIRECTORY) {
        this.directory = directory;
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fs.chmodSync(directory, 0o700);
        const parent = fs.openSync(path.dirname(directory), 'r');
        try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
        this.db = new Database(path.join(directory, 'exports.sqlite'));
        fs.chmodSync(path.join(directory, 'exports.sqlite'), 0o600);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = FULL');
        this.db.pragma('foreign_keys = ON');
        this.db.pragma('busy_timeout = 5000');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, status TEXT NOT NULL,
                owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL, finished_at INTEGER, payload TEXT NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS one_active_export ON jobs(guild_id)
                WHERE status IN ('queued', 'running', 'finalizing');
            CREATE TABLE IF NOT EXISTS members (
                ordinal INTEGER PRIMARY KEY,
                job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                id TEXT NOT NULL, UNIQUE(job_id, id)
            );
            CREATE INDEX IF NOT EXISTS member_pages ON members(job_id, ordinal);
            CREATE TABLE IF NOT EXISTS downloads (
                token TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                expires_at INTEGER NOT NULL
            );
        `);
    }

    decode(row) { return row ? JSON.parse(row.payload) : null; }

    get(guildId, id) {
        return this.decode(this.db.prepare('SELECT payload FROM jobs WHERE guild_id=? AND id=?').get(guildId, id));
    }

    latest(guildId) {
        return this.decode(this.db.prepare('SELECT payload FROM jobs WHERE guild_id=? ORDER BY rowid DESC LIMIT 1').get(guildId));
    }

    latestCompleted(guildId) {
        return this.decode(this.db.prepare(`SELECT payload FROM jobs WHERE guild_id=? AND status='completed'
            ORDER BY finished_at DESC, rowid DESC LIMIT 1`).get(guildId));
    }

    save(job, owner = null, leaseUntil = 0) {
        this.db.prepare(`UPDATE jobs SET status=?, owner=?, lease_until=?, updated_at=?, finished_at=?, payload=? WHERE id=?`)
            .run(job.status, owner, leaseUntil, job.updatedAt, job.finishedAt ?? null, JSON.stringify(job), job.id);
        return job;
    }

    create(guildId, now = Date.now()) {
        return this.db.transaction(() => {
            const existing = this.decode(this.db.prepare("SELECT payload FROM jobs WHERE guild_id=? AND status IN ('queued','running','finalizing')").get(guildId));
            if (existing) return existing;
            const previous = this.latest(guildId);
            if (previous?.status === 'failed') {
                return this.save({ ...previous, status: 'queued', finishedAt: null, updatedAt: now, nextRetryAt: null });
            }
            const job = {
                id: randomUUID(), guildId, status: 'queued', after: '0', count: 0, pages: 0,
                retries: 0, lastError: null, nextRetryAt: null, createdAt: now, updatedAt: now,
            };
            this.db.prepare('INSERT INTO jobs(id,guild_id,status,updated_at,payload) VALUES(?,?,?,?,?)')
                .run(job.id, guildId, job.status, now, JSON.stringify(job));
            return job;
        }).immediate();
    }

    claim(owner, now = Date.now(), leaseMs = 90000) {
        return this.db.transaction(() => {
            const row = this.db.prepare(`SELECT * FROM jobs WHERE status IN ('queued','running','finalizing')
                AND lease_until<=? ORDER BY rowid LIMIT 1`).get(now);
            if (!row) return null;
            const job = this.decode(row);
            if (job.status === 'queued') job.status = 'running';
            job.updatedAt = now;
            return this.save(job, owner, now + leaseMs);
        }).immediate();
    }

    owned(id, owner, now) {
        const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
        if (!row || row.owner !== owner || row.lease_until <= now || !ACTIVE.includes(row.status)) {
            throw new Error('任务租约已失效');
        }
        return row;
    }

    heartbeat(id, owner, now = Date.now(), leaseMs = 90000) {
        return this.db.prepare(`UPDATE jobs SET lease_until=? WHERE id=? AND owner=? AND lease_until>?
            AND status IN ('running','finalizing')`).run(now + leaseMs, id, owner, now).changes === 1;
    }

    update(id, owner, fields, now = Date.now()) {
        return this.db.transaction(() => {
            const row = this.owned(id, owner, now);
            const job = { ...this.decode(row), ...fields, updatedAt: now };
            return this.save(job, ACTIVE.includes(job.status) ? owner : null, ACTIVE.includes(job.status) ? row.lease_until : 0);
        }).immediate();
    }

    commitPage(id, owner, ids, now = Date.now()) {
        if (!Array.isArray(ids) || ids.length > 1000 || ids.some(value => !validId(value))) {
            throw new Error('成员列表包含无效 ID 或分页大小');
        }
        return this.db.transaction(() => {
            const row = this.owned(id, owner, now);
            const job = this.decode(row);
            if (job.status !== 'running') throw new Error('任务不在分页状态');
            if (!ids.length) {
                job.status = 'finalizing';
            } else {
                const insert = this.db.prepare('INSERT OR IGNORE INTO members(job_id,id) VALUES(?,?)');
                const exists = this.db.prepare('SELECT 1 FROM members WHERE job_id=? AND id=?');
                let after = BigInt(job.after);
                for (const value of new Set(ids)) {
                    const snowflake = BigInt(value);
                    if (snowflake <= BigInt(job.after) && !exists.get(id, value)) {
                        throw new Error('成员列表游标倒退，不能确认完整性');
                    }
                    job.count += insert.run(id, value).changes;
                    if (snowflake > after) after = snowflake;
                }
                if (after <= BigInt(job.after)) throw new Error('成员列表游标未前进');
                job.after = after.toString();
                job.pages += 1;
            }
            job.nextRetryAt = null;
            job.updatedAt = now;
            return this.save(job, owner, row.lease_until);
        }).immediate();
    }

    rows(id, afterOrdinal, limit = 1000) {
        return this.db.prepare('SELECT ordinal,id FROM members WHERE job_id=? AND ordinal>? ORDER BY ordinal LIMIT ?')
            .all(id, afterOrdinal, limit);
    }

    count(id) { return this.db.prepare('SELECT COUNT(*) AS count FROM members WHERE job_id=?').get(id).count; }

    release(id, owner) {
        this.db.prepare('UPDATE jobs SET owner=NULL,lease_until=0 WHERE id=? AND owner=?').run(id, owner);
    }

    pin(guildId, id, now = Date.now()) {
        return this.db.transaction(() => {
            const job = this.get(guildId, id);
            if (!job || job.status !== 'completed') throw new Error('任务尚未完成或不可下载');
            const token = randomUUID();
            this.db.prepare('INSERT INTO downloads VALUES(?,?,?)').run(token, id, now + 90000);
            return token;
        }).immediate();
    }

    renewPin(token) {
        const now = Date.now();
        return this.db.prepare(`UPDATE downloads SET expires_at=? WHERE token=? AND expires_at>?
            AND EXISTS(SELECT 1 FROM jobs WHERE jobs.id=downloads.job_id AND status='completed')`)
            .run(now + 90000, token, now).changes === 1;
    }

    hasPin(token, now = Date.now()) {
        return Boolean(this.db.prepare(`SELECT 1 FROM downloads JOIN jobs ON jobs.id=downloads.job_id
            WHERE token=? AND expires_at>? AND status='completed'`).get(token, now));
    }

    fileJobs() { return this.db.prepare('SELECT payload FROM jobs').all().map(row => this.decode(row)); }

    unpin(token) { this.db.prepare('DELETE FROM downloads WHERE token=?').run(token); }

    expired(now, retentionMs) {
        return this.db.prepare(`SELECT id FROM jobs WHERE status IN ('completed','failed','expired') AND finished_at<?
            AND NOT EXISTS(SELECT 1 FROM downloads WHERE job_id=jobs.id AND expires_at>?)`)
            .all(now - retentionMs, now).map(row => row.id);
    }

    expire(id, now, retentionMs) {
        return this.db.transaction(() => {
            const row = this.db.prepare(`SELECT * FROM jobs WHERE id=? AND finished_at<?
                AND status IN ('completed','failed','expired')
                AND NOT EXISTS(SELECT 1 FROM downloads WHERE job_id=jobs.id AND expires_at>?)`)
                .get(id, now - retentionMs, now);
            if (!row) return false;
            const job = this.decode(row);
            this.save({ ...job, status: 'expired', updatedAt: now });
            return true;
        }).immediate();
    }

    remove(id) {
        this.db.prepare("DELETE FROM jobs WHERE id=? AND status IN ('completed','failed','expired')").run(id);
    }

    close() { if (this.db.open) this.db.close(); }
}

module.exports = { ExportStore, DEFAULT_DIRECTORY, validId };
