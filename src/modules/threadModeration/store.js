const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DEFAULT_FILE = path.join(__dirname, '../../../data/threadModeration.sqlite');

class Store {
    constructor(filename = DEFAULT_FILE) {
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        this.db = new Database(filename);
        try {
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('synchronous = FULL');
            this.db.pragma('busy_timeout = 5000');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS config (
                    guild_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('channel','role')),
                    target_id TEXT NOT NULL, channel_type INTEGER, actor_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
                    PRIMARY KEY(guild_id,kind,target_id)
                );
                CREATE TABLE IF NOT EXISTS config_audit (
                    id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, kind TEXT NOT NULL, target_id TEXT NOT NULL,
                    action TEXT NOT NULL, actor_id TEXT NOT NULL, at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS operations (
                    id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, thread_id TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('pending','review','succeeded','failed')),
                    payload TEXT NOT NULL, updated_at INTEGER NOT NULL
                );
                CREATE UNIQUE INDEX IF NOT EXISTS one_unfinished_thread ON operations(guild_id,thread_id)
                    WHERE status IN ('pending','review');
                CREATE TABLE IF NOT EXISTS worker (
                    id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, expires_at INTEGER NOT NULL
                );
                INSERT OR IGNORE INTO worker VALUES(1,NULL,0);
            `);
        } catch (error) { this.db.close(); throw error; }
    }

    config(guildId) {
        return this.db.prepare('SELECT * FROM config WHERE guild_id=? ORDER BY kind,target_id').all(guildId);
    }

    has(guildId, kind, id) {
        return Boolean(this.db.prepare('SELECT 1 FROM config WHERE guild_id=? AND kind=? AND target_id=?').get(guildId, kind, id));
    }

    configure(guildId, kind, id, action, actorId, channelType = null) {
        if (!['channel', 'role'].includes(kind) || !['add', 'remove'].includes(action)) throw new Error('无效配置操作。');
        return this.db.transaction(() => {
            const now = Date.now();
            const result = action === 'add'
                ? this.db.prepare('INSERT OR IGNORE INTO config VALUES(?,?,?,?,?,?)').run(guildId, kind, id, channelType, actorId, now)
                : this.db.prepare('DELETE FROM config WHERE guild_id=? AND kind=? AND target_id=?').run(guildId, kind, id);
            if (result.changes) this.db.prepare('INSERT INTO config_audit(guild_id,kind,target_id,action,actor_id,at) VALUES(?,?,?,?,?,?)')
                .run(guildId, kind, id, action, actorId, now);
            return Boolean(result.changes);
        }).immediate();
    }

    create(spec) {
        return this.db.transaction(() => {
            if (this.get(spec.id)) throw new Error('该请求已处理。');
            if (this.db.prepare("SELECT 1 FROM operations WHERE guild_id=? AND thread_id=? AND status IN ('pending','review')").get(spec.guildId, spec.threadId)) {
                throw new Error('该帖子有未完成或待人工核验的操作，请先检查记录。');
            }
            const op = { ...spec, status: 'pending', phase: 'prepared', createdAt: Date.now(), messageId: null, error: null, recovery: null };
            this.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)')
                .run(op.id, op.guildId, op.threadId, op.status, JSON.stringify(op), Date.now());
            return op;
        }).immediate();
    }

    get(id) {
        const row = this.db.prepare('SELECT payload FROM operations WHERE id=?').get(id);
        return row ? JSON.parse(row.payload) : null;
    }

    update(id, patch) {
        return this.db.transaction(() => {
            const op = this.get(id);
            if (!op) throw new Error('操作记录不存在。');
            const next = { ...op, ...patch, id: op.id, guildId: op.guildId, threadId: op.threadId };
            this.db.prepare('UPDATE operations SET status=?,payload=?,updated_at=? WHERE id=?')
                .run(next.status, JSON.stringify(next), Date.now(), id);
            return next;
        }).immediate();
    }

    unfinished() {
        return this.db.prepare("SELECT payload FROM operations WHERE status IN ('pending','review') ORDER BY updated_at")
            .all().map(row => JSON.parse(row.payload));
    }

    lease(owner, now, ttl) {
        return Boolean(this.db.prepare('UPDATE worker SET owner=?,expires_at=? WHERE id=1 AND (owner=? OR expires_at<=?)')
            .run(owner, now + ttl, owner, now).changes);
    }

    owns(owner, now = Date.now()) {
        return Boolean(this.db.prepare('SELECT 1 FROM worker WHERE owner=? AND expires_at>?').get(owner, now));
    }

    release(owner) {
        this.db.prepare('UPDATE worker SET owner=NULL,expires_at=0 WHERE owner=?').run(owner);
    }
}

module.exports = { Store };
