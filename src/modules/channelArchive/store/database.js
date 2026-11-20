// src/modules/channelArchive/store/database.js
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { DATA_DIR, ARCHIVE_STATUS, SUBTHREAD_STATUS, VOTE_STATUS } = require('../utils/constants');

const DEFAULT_FILE = path.join(DATA_DIR, 'channelArchive.sqlite');

const ARCHIVE_COLUMNS = new Set([
    'source_channel_name',
    'status',
    'target_forum_id',
    'target_thread_id',
    'last_synced_message_id',
    'total_synced_count',
    'progress_message_id',
    'last_error',
    'completed_at',
]);
const SUBTHREAD_COLUMNS = new Set([
    'thread_name',
    'thread_creator_id',
    'thread_created_at',
    'status',
    'target_forum_id',
    'target_thread_id',
    'last_synced_message_id',
    'synced_count',
    'last_error',
]);

function parseVote(row) {
    if (!row) return null;
    let approvedUsers = [];
    try {
        approvedUsers = JSON.parse(row.approved_users || '[]');
    } catch (_) {
        approvedUsers = [];
    }
    return { ...row, approvedUsers };
}

class ArchiveStore {
    constructor(filename = DEFAULT_FILE) {
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        this.db = new Database(filename);
        try {
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('synchronous = NORMAL');
            this.db.pragma('busy_timeout = 5000');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS guild_configs (
                    guild_id            TEXT PRIMARY KEY,
                    event_role_id       TEXT NOT NULL,
                    mod_role_id         TEXT NOT NULL,
                    allowed_category_id TEXT NOT NULL,
                    target_forum_id     TEXT NOT NULL,
                    updated_at          INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS channel_archives (
                    source_channel_id      TEXT PRIMARY KEY,
                    guild_id               TEXT NOT NULL,
                    source_channel_name    TEXT NOT NULL,
                    status                 TEXT NOT NULL CHECK(status IN ('PENDING_VOTE','ARCHIVING','ARCHIVED','DELETED')),
                    target_forum_id        TEXT,
                    target_thread_id       TEXT,
                    last_synced_message_id TEXT,
                    total_synced_count     INTEGER NOT NULL DEFAULT 0,
                    progress_message_id    TEXT,
                    last_error             TEXT,
                    created_at             INTEGER NOT NULL,
                    updated_at             INTEGER NOT NULL,
                    completed_at           INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_archive_guild_status
                    ON channel_archives(guild_id, status);

                CREATE TABLE IF NOT EXISTS vote_sessions (
                    vote_id        TEXT PRIMARY KEY,
                    guild_id       TEXT NOT NULL,
                    channel_id     TEXT NOT NULL,
                    message_id     TEXT NOT NULL,
                    vote_type      TEXT NOT NULL CHECK(vote_type IN ('ARCHIVE','DELETE')),
                    initiator_id   TEXT NOT NULL,
                    approved_users TEXT NOT NULL DEFAULT '[]',
                    status         TEXT NOT NULL CHECK(status IN ('ACTIVE','PASSED','VETOED','EXPIRED')),
                    expires_at     INTEGER NOT NULL,
                    created_at     INTEGER NOT NULL,
                    updated_at     INTEGER NOT NULL
                );
                CREATE UNIQUE INDEX IF NOT EXISTS one_active_vote_per_channel
                    ON vote_sessions(channel_id) WHERE status = 'ACTIVE';

                CREATE TABLE IF NOT EXISTS audit_logs (
                    id                TEXT PRIMARY KEY,
                    guild_id          TEXT NOT NULL,
                    action_type       TEXT NOT NULL CHECK(action_type IN ('ARCHIVE_START','ARCHIVE_DONE','VOTE_VETO','CHANNEL_DELETE')),
                    channel_id        TEXT NOT NULL,
                    channel_name      TEXT,
                    initiator_id      TEXT,
                    voters_snapshot   TEXT,
                    target_thread_id  TEXT,
                    created_at        INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_audit_guild_time
                    ON audit_logs(guild_id, created_at);

                CREATE TABLE IF NOT EXISTS subthread_archives (
                    thread_id              TEXT PRIMARY KEY,
                    guild_id               TEXT NOT NULL,
                    source_channel_id      TEXT NOT NULL,
                    thread_name            TEXT NOT NULL,
                    thread_creator_id      TEXT,
                    thread_created_at      INTEGER,
                    status                 TEXT NOT NULL CHECK(status IN ('PENDING','ARCHIVING','ARCHIVED','FAILED')),
                    target_forum_id        TEXT,
                    target_thread_id       TEXT,
                    last_synced_message_id TEXT,
                    synced_count           INTEGER NOT NULL DEFAULT 0,
                    last_error             TEXT,
                    created_at             INTEGER NOT NULL,
                    updated_at             INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_subthread_source
                    ON subthread_archives(source_channel_id);
            `);
        } catch (error) {
            this.db.close();
            throw error;
        }
    }

    close() {
        try {
            this.db.close();
        } catch (_) {
            // ignore
        }
    }

    // ---------- config ----------
    getConfig(guildId) {
        return this.db.prepare('SELECT * FROM guild_configs WHERE guild_id = ?').get(guildId) || null;
    }

    saveConfig({ guildId, eventRoleId, modRoleId, allowedCategoryId, targetForumId }) {
        const now = Date.now();
        this.db.prepare(`
            INSERT INTO guild_configs (guild_id, event_role_id, mod_role_id, allowed_category_id, target_forum_id, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(guild_id) DO UPDATE SET
                event_role_id = excluded.event_role_id,
                mod_role_id = excluded.mod_role_id,
                allowed_category_id = excluded.allowed_category_id,
                target_forum_id = excluded.target_forum_id,
                updated_at = excluded.updated_at
        `).run(guildId, eventRoleId, modRoleId, allowedCategoryId, targetForumId, now);
        return this.getConfig(guildId);
    }

    // ---------- channel archives ----------
    getArchive(channelId) {
        return this.db.prepare('SELECT * FROM channel_archives WHERE source_channel_id = ?').get(channelId) || null;
    }

    upsertPendingArchive({ channelId, guildId, channelName }) {
        const now = Date.now();
        return this.db.prepare(`
            INSERT INTO channel_archives (
                source_channel_id, guild_id, source_channel_name, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_channel_id) DO UPDATE SET
                source_channel_name = excluded.source_channel_name,
                status = 'PENDING_VOTE',
                last_error = NULL,
                updated_at = excluded.updated_at
            WHERE channel_archives.status = 'PENDING_VOTE'
        `).run(channelId, guildId, channelName, ARCHIVE_STATUS.PENDING_VOTE, now, now).changes;
    }

    deletePendingArchive(channelId) {
        return this.db.prepare(
            "DELETE FROM channel_archives WHERE source_channel_id = ? AND status = 'PENDING_VOTE'",
        ).run(channelId).changes;
    }

    setArchive(channelId, patch) {
        const fields = [];
        const values = [];
        for (const [key, value] of Object.entries(patch || {})) {
            if (!ARCHIVE_COLUMNS.has(key)) continue;
            fields.push(`${key} = ?`);
            values.push(value);
        }
        if (!fields.length) return;
        fields.push('updated_at = ?');
        values.push(Date.now(), channelId);
        this.db.prepare(`UPDATE channel_archives SET ${fields.join(', ')} WHERE source_channel_id = ?`).run(...values);
    }

    /**
     * 取消归档状态：删除归档记录与子区记录（不删除已生成的备份帖）。
     */
    deleteArchive(channelId) {
        return this.db.transaction(() => {
            this.db.prepare('DELETE FROM subthread_archives WHERE source_channel_id = ?').run(channelId);
            const info = this.db.prepare('DELETE FROM channel_archives WHERE source_channel_id = ?').run(channelId);
            return info.changes > 0;
        })();
    }

    markArchiveStarted(channelId, targetForumId) {
        this.setArchive(channelId, {
            status: ARCHIVE_STATUS.ARCHIVING,
            target_forum_id: targetForumId,
            last_error: null,
        });
    }

    updateArchiveCheckpoint(channelId, lastMessageId, syncedCount) {
        this.db.prepare(`
            UPDATE channel_archives
            SET last_synced_message_id = ?, total_synced_count = ?, updated_at = ?
            WHERE source_channel_id = ?
        `).run(lastMessageId || null, syncedCount || 0, Date.now(), channelId);
    }

    markArchived(channelId) {
        const now = Date.now();
        this.db.prepare(`
            UPDATE channel_archives
            SET status = ?, completed_at = ?, updated_at = ?, last_error = NULL
            WHERE source_channel_id = ?
        `).run(ARCHIVE_STATUS.ARCHIVED, now, now, channelId);
    }

    markDeleted(channelId) {
        const now = Date.now();
        this.db.prepare(`
            UPDATE channel_archives
            SET status = ?, completed_at = ?, updated_at = ?
            WHERE source_channel_id = ?
        `).run(ARCHIVE_STATUS.DELETED, now, now, channelId);
    }

    listArchiving() {
        return this.db.prepare(
            "SELECT * FROM channel_archives WHERE status = 'ARCHIVING' ORDER BY created_at",
        ).all();
    }

    listRetryable() {
        return this.db.prepare(`
            SELECT * FROM channel_archives a
            WHERE a.status = 'ARCHIVING'
               OR (a.status = 'ARCHIVED' AND EXISTS (
                    SELECT 1 FROM subthread_archives s
                    WHERE s.source_channel_id = a.source_channel_id AND s.status <> 'ARCHIVED'
               ))
            ORDER BY a.created_at
        `).all();
    }

    // ---------- subthreads ----------
    upsertSubthread({
        threadId,
        guildId,
        sourceChannelId,
        threadName,
        creatorId = null,
        createdAt = null,
    }) {
        const now = Date.now();
        this.db.prepare(`
            INSERT INTO subthread_archives (
                thread_id, guild_id, source_channel_id, thread_name,
                thread_creator_id, thread_created_at, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(thread_id) DO UPDATE SET
                thread_name = excluded.thread_name,
                thread_creator_id = COALESCE(excluded.thread_creator_id, subthread_archives.thread_creator_id),
                thread_created_at = COALESCE(excluded.thread_created_at, subthread_archives.thread_created_at),
                updated_at = excluded.updated_at
        `).run(
            threadId,
            guildId,
            sourceChannelId,
            threadName,
            creatorId,
            createdAt,
            SUBTHREAD_STATUS.PENDING,
            now,
            now,
        );
        return this.getSubthread(threadId);
    }

    getSubthread(threadId) {
        return this.db.prepare('SELECT * FROM subthread_archives WHERE thread_id = ?').get(threadId) || null;
    }

    listSubthreads(sourceChannelId) {
        return this.db.prepare(
            'SELECT * FROM subthread_archives WHERE source_channel_id = ? ORDER BY thread_created_at, thread_id',
        ).all(sourceChannelId);
    }

    setSubthread(threadId, patch) {
        const fields = [];
        const values = [];
        for (const [key, value] of Object.entries(patch || {})) {
            if (!SUBTHREAD_COLUMNS.has(key)) continue;
            fields.push(`${key} = ?`);
            values.push(value);
        }
        if (!fields.length) return;
        fields.push('updated_at = ?');
        values.push(Date.now(), threadId);
        this.db.prepare(`UPDATE subthread_archives SET ${fields.join(', ')} WHERE thread_id = ?`).run(...values);
    }

    // ---------- votes ----------
    createVote({
        voteId = randomUUID(),
        guildId,
        channelId,
        messageId,
        voteType,
        initiatorId,
        approvedUsers,
        expiresAt,
    }) {
        const now = Date.now();
        this.db.prepare(`
            INSERT INTO vote_sessions (
                vote_id, guild_id, channel_id, message_id, vote_type,
                initiator_id, approved_users, status, expires_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            voteId,
            guildId,
            channelId,
            messageId || '',
            voteType,
            initiatorId,
            JSON.stringify(approvedUsers || []),
            VOTE_STATUS.ACTIVE,
            expiresAt,
            now,
            now,
        );
        return this.getVote(voteId);
    }

    getVote(voteId) {
        return parseVote(this.db.prepare('SELECT * FROM vote_sessions WHERE vote_id = ?').get(voteId));
    }

    getActiveVoteByChannel(channelId) {
        return parseVote(this.db.prepare(
            "SELECT * FROM vote_sessions WHERE channel_id = ? AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1",
        ).get(channelId));
    }

    listActiveVotes() {
        return this.db.prepare("SELECT * FROM vote_sessions WHERE status = 'ACTIVE' ORDER BY created_at")
            .all()
            .map(parseVote);
    }

    getLatestVoteByChannel(channelId) {
        return parseVote(this.db.prepare(
            'SELECT * FROM vote_sessions WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1',
        ).get(channelId));
    }

    getLatestVoteByChannelAndType(channelId, voteType) {
        return parseVote(this.db.prepare(
            'SELECT * FROM vote_sessions WHERE channel_id = ? AND vote_type = ? ORDER BY created_at DESC LIMIT 1',
        ).get(channelId, voteType));
    }

    setVoteMessage(voteId, messageId) {
        this.db.prepare('UPDATE vote_sessions SET message_id = ?, updated_at = ? WHERE vote_id = ?')
            .run(messageId, Date.now(), voteId);
    }

    approveAndCheck(voteId, userId, threshold) {
        const tx = this.db.transaction(() => {
            const current = parseVote(this.db.prepare('SELECT * FROM vote_sessions WHERE vote_id = ?').get(voteId));
            if (!current || current.status !== VOTE_STATUS.ACTIVE) {
                return { vote: current, justPassed: false };
            }
            if (current.expires_at <= Date.now()) {
                this.db.prepare("UPDATE vote_sessions SET status = 'EXPIRED', updated_at = ? WHERE vote_id = ? AND status = 'ACTIVE'")
                    .run(Date.now(), voteId);
                return { vote: this.getVote(voteId), justPassed: false };
            }

            const users = new Set(current.approvedUsers);
            users.add(userId);
            const approved = [...users];
            this.db.prepare('UPDATE vote_sessions SET approved_users = ?, updated_at = ? WHERE vote_id = ?')
                .run(JSON.stringify(approved), Date.now(), voteId);

            if (approved.length >= threshold) {
                const result = this.db.prepare(
                    "UPDATE vote_sessions SET status = 'PASSED', updated_at = ? WHERE vote_id = ? AND status = 'ACTIVE'",
                ).run(Date.now(), voteId);
                if (result.changes) {
                    return { vote: this.getVote(voteId), justPassed: true };
                }
            }
            return { vote: this.getVote(voteId), justPassed: false };
        });
        return tx.immediate();
    }

    withdraw(voteId, userId) {
        const tx = this.db.transaction(() => {
            const current = this.getVote(voteId);
            if (!current || current.status !== VOTE_STATUS.ACTIVE) return current;
            const approved = current.approvedUsers.filter(id => id !== userId);
            this.db.prepare('UPDATE vote_sessions SET approved_users = ?, updated_at = ? WHERE vote_id = ?')
                .run(JSON.stringify(approved), Date.now(), voteId);
            return this.getVote(voteId);
        });
        return tx.immediate();
    }

    veto(voteId) {
        const result = this.db.prepare(
            "UPDATE vote_sessions SET status = 'VETOED', updated_at = ? WHERE vote_id = ? AND status = 'ACTIVE'",
        ).run(Date.now(), voteId);
        return { changed: Boolean(result.changes), vote: this.getVote(voteId) };
    }

    expireVote(voteId) {
        const result = this.db.prepare(
            "UPDATE vote_sessions SET status = 'EXPIRED', updated_at = ? WHERE vote_id = ? AND status = 'ACTIVE'",
        ).run(Date.now(), voteId);
        return { changed: Boolean(result.changes), vote: this.getVote(voteId) };
    }

    expireOverdueVotes(now = Date.now()) {
        return this.db.prepare(
            "UPDATE vote_sessions SET status = 'EXPIRED', updated_at = ? WHERE status = 'ACTIVE' AND expires_at <= ?",
        ).run(now, now).changes;
    }

    // ---------- audit ----------
    addAudit({
        guildId,
        actionType,
        channelId,
        channelName,
        initiatorId,
        votersSnapshot,
        targetThreadId,
    }) {
        const id = randomUUID();
        this.db.prepare(`
            INSERT INTO audit_logs (
                id, guild_id, action_type, channel_id, channel_name,
                initiator_id, voters_snapshot, target_thread_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            guildId,
            actionType,
            channelId,
            channelName || null,
            initiatorId || null,
            JSON.stringify(votersSnapshot || []),
            targetThreadId || null,
            Date.now(),
        );
        return id;
    }

    recentAudits(guildId, channelId, limit = 10) {
        return this.db.prepare(`
            SELECT * FROM audit_logs
            WHERE guild_id = ? AND channel_id = ?
            ORDER BY created_at DESC
            LIMIT ?
        `).all(guildId, channelId, limit);
    }
}

module.exports = {
    ArchiveStore,
    DEFAULT_FILE,
};
