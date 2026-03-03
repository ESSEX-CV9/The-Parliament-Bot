const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '../../../../data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const PUNISHMENT_DB_FILE = path.join(DATA_DIR, 'punishment.sqlite');
const db = new Database(PUNISHMENT_DB_FILE);

let initialized = false;

function nowIso() {
    return new Date().toISOString();
}

function initializePunishmentDatabase() {
    if (initialized) return;

    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');

    db.exec(`
        CREATE TABLE IF NOT EXISTS punishment_records (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id        TEXT NOT NULL,
            target_user_id  TEXT NOT NULL,
            executor_id     TEXT NOT NULL,
            type            TEXT NOT NULL,
            reason          TEXT,
            duration_ms     INTEGER,
            expires_at      TEXT,
            status          TEXT NOT NULL DEFAULT 'active',
            created_at      TEXT NOT NULL,
            updated_at      TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_pr_guild_user ON punishment_records(guild_id, target_user_id);
        CREATE INDEX IF NOT EXISTS idx_pr_status_type ON punishment_records(status, type);
        CREATE INDEX IF NOT EXISTS idx_pr_expires ON punishment_records(expires_at);

        CREATE TABLE IF NOT EXISTS punishment_sync_targets (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            source_guild_id TEXT NOT NULL,
            target_guild_id TEXT NOT NULL,
            sync_ban        INTEGER NOT NULL DEFAULT 1,
            sync_mute       INTEGER NOT NULL DEFAULT 1,
            sync_warn_role  INTEGER NOT NULL DEFAULT 1,
            enabled         INTEGER NOT NULL DEFAULT 1,
            created_at      TEXT NOT NULL,
            UNIQUE(source_guild_id, target_guild_id)
        );

        CREATE INDEX IF NOT EXISTS idx_pst_source ON punishment_sync_targets(source_guild_id);

        CREATE TABLE IF NOT EXISTS punishment_warn_role_config (
            guild_id    TEXT PRIMARY KEY,
            role_id     TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS punishment_settings (
            guild_id    TEXT NOT NULL,
            key         TEXT NOT NULL,
            value       TEXT NOT NULL,
            updated_at  TEXT NOT NULL,
            PRIMARY KEY (guild_id, key)
        );
    `);

    initialized = true;
    console.log('[Punishment] 数据库初始化完成');
}

// ========== punishment_records ==========

const stmtInsertRecord = db.prepare(`
    INSERT INTO punishment_records (guild_id, target_user_id, executor_id, type, reason, duration_ms, expires_at, status, created_at, updated_at)
    VALUES (@guildId, @targetUserId, @executorId, @type, @reason, @durationMs, @expiresAt, @status, @createdAt, @updatedAt)
`);

function insertPunishmentRecord({ guildId, targetUserId, executorId, type, reason, durationMs, expiresAt }) {
    const now = nowIso();
    const status = (type === 'unban') ? 'completed' : 'active';
    return stmtInsertRecord.run({
        guildId,
        targetUserId,
        executorId,
        type,
        reason: reason || null,
        durationMs: durationMs || null,
        expiresAt: expiresAt || null,
        status,
        createdAt: now,
        updatedAt: now,
    });
}

const stmtGetActiveByType = db.prepare(`
    SELECT * FROM punishment_records WHERE status = 'active' AND type = ? AND expires_at IS NOT NULL
`);

function getActiveExpirablePunishments(type) {
    return stmtGetActiveByType.all(type);
}

const stmtMarkExpired = db.prepare(`
    UPDATE punishment_records SET status = 'expired', updated_at = ? WHERE id = ?
`);

function markPunishmentExpired(id) {
    return stmtMarkExpired.run(nowIso(), id);
}

const stmtGetRecords = db.prepare(`
    SELECT * FROM punishment_records WHERE guild_id = ? AND target_user_id = ? ORDER BY created_at DESC LIMIT 20
`);

function getPunishmentRecords(guildId, targetUserId) {
    return stmtGetRecords.all(guildId, targetUserId);
}

// ========== punishment_sync_targets ==========

const stmtGetSyncTargets = db.prepare(`
    SELECT * FROM punishment_sync_targets WHERE source_guild_id = ? AND enabled = 1
`);

function getSyncTargets(sourceGuildId) {
    return stmtGetSyncTargets.all(sourceGuildId);
}

const stmtUpsertSyncTarget = db.prepare(`
    INSERT INTO punishment_sync_targets (source_guild_id, target_guild_id, created_at)
    VALUES (@sourceGuildId, @targetGuildId, @createdAt)
    ON CONFLICT(source_guild_id, target_guild_id) DO UPDATE SET enabled = 1
`);

function addSyncTarget(sourceGuildId, targetGuildId) {
    return stmtUpsertSyncTarget.run({ sourceGuildId, targetGuildId, createdAt: nowIso() });
}

const stmtRemoveSyncTarget = db.prepare(`
    DELETE FROM punishment_sync_targets WHERE source_guild_id = ? AND target_guild_id = ?
`);

function removeSyncTarget(sourceGuildId, targetGuildId) {
    return stmtRemoveSyncTarget.run(sourceGuildId, targetGuildId);
}

const stmtListSyncTargets = db.prepare(`
    SELECT * FROM punishment_sync_targets WHERE source_guild_id = ?
`);

function listSyncTargets(sourceGuildId) {
    return stmtListSyncTargets.all(sourceGuildId);
}

// ========== punishment_warn_role_config ==========

const stmtGetWarnRole = db.prepare(`
    SELECT role_id FROM punishment_warn_role_config WHERE guild_id = ?
`);

function getWarnRoleForGuild(guildId) {
    const row = stmtGetWarnRole.get(guildId);
    return row ? row.role_id : null;
}

const stmtSetWarnRole = db.prepare(`
    INSERT INTO punishment_warn_role_config (guild_id, role_id, updated_at)
    VALUES (@guildId, @roleId, @updatedAt)
    ON CONFLICT(guild_id) DO UPDATE SET role_id = @roleId, updated_at = @updatedAt
`);

function setWarnRoleForGuild(guildId, roleId) {
    return stmtSetWarnRole.run({ guildId, roleId, updatedAt: nowIso() });
}

// ========== punishment_settings ==========

const stmtGetSetting = db.prepare(`
    SELECT value FROM punishment_settings WHERE guild_id = ? AND key = ?
`);

function getSetting(guildId, key) {
    const row = stmtGetSetting.get(guildId, key);
    return row ? row.value : null;
}

const stmtSetSetting = db.prepare(`
    INSERT INTO punishment_settings (guild_id, key, value, updated_at)
    VALUES (@guildId, @key, @value, @updatedAt)
    ON CONFLICT(guild_id, key) DO UPDATE SET value = @value, updated_at = @updatedAt
`);

function setSetting(guildId, key, value) {
    return stmtSetSetting.run({ guildId, key, value, updatedAt: nowIso() });
}

module.exports = {
    initializePunishmentDatabase,
    insertPunishmentRecord,
    getActiveExpirablePunishments,
    markPunishmentExpired,
    getPunishmentRecords,
    getSyncTargets,
    addSyncTarget,
    removeSyncTarget,
    listSyncTargets,
    getWarnRoleForGuild,
    setWarnRoleForGuild,
    getSetting,
    setSetting,
};
