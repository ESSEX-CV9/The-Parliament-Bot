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
const stmts = {};

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

        CREATE TABLE IF NOT EXISTS punishment_announcement_channels (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            source_guild_id TEXT NOT NULL,
            channel_id      TEXT NOT NULL,
            created_at      TEXT NOT NULL,
            UNIQUE(source_guild_id, channel_id)
        );

        CREATE INDEX IF NOT EXISTS idx_pac_source ON punishment_announcement_channels(source_guild_id);

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

    db.exec(`
        INSERT OR IGNORE INTO punishment_announcement_channels (source_guild_id, channel_id, created_at)
        SELECT guild_id, value, COALESCE(updated_at, CURRENT_TIMESTAMP)
        FROM punishment_settings
        WHERE key = 'announcement_channel_id' AND value IS NOT NULL AND value != '';
    `);

    // 表创建完成后才 prepare statements
    stmts.insertRecord = db.prepare(`
        INSERT INTO punishment_records (guild_id, target_user_id, executor_id, type, reason, duration_ms, expires_at, status, created_at, updated_at)
        VALUES (@guildId, @targetUserId, @executorId, @type, @reason, @durationMs, @expiresAt, @status, @createdAt, @updatedAt)
    `);
    stmts.getActiveByType = db.prepare(`
        SELECT * FROM punishment_records WHERE status = 'active' AND type = ? AND expires_at IS NOT NULL
    `);
    stmts.markExpired = db.prepare(`
        UPDATE punishment_records SET status = 'expired', updated_at = ? WHERE id = ?
    `);
    stmts.getRecords = db.prepare(`
        SELECT * FROM punishment_records WHERE guild_id = ? AND target_user_id = ? ORDER BY created_at DESC LIMIT 20
    `);
    stmts.getSyncTargets = db.prepare(`
        SELECT * FROM punishment_sync_targets WHERE source_guild_id = ? AND enabled = 1
    `);
    stmts.upsertSyncTarget = db.prepare(`
        INSERT INTO punishment_sync_targets (source_guild_id, target_guild_id, created_at)
        VALUES (@sourceGuildId, @targetGuildId, @createdAt)
        ON CONFLICT(source_guild_id, target_guild_id) DO UPDATE SET enabled = 1
    `);
    stmts.removeSyncTarget = db.prepare(`
        DELETE FROM punishment_sync_targets WHERE source_guild_id = ? AND target_guild_id = ?
    `);
    stmts.listSyncTargets = db.prepare(`
        SELECT * FROM punishment_sync_targets WHERE source_guild_id = ?
    `);
    stmts.getWarnRole = db.prepare(`
        SELECT role_id FROM punishment_warn_role_config WHERE guild_id = ?
    `);
    stmts.addAnnouncementChannel = db.prepare(`
        INSERT INTO punishment_announcement_channels (source_guild_id, channel_id, created_at)
        VALUES (@sourceGuildId, @channelId, @createdAt)
        ON CONFLICT(source_guild_id, channel_id) DO NOTHING
    `);
    stmts.removeAnnouncementChannel = db.prepare(`
        DELETE FROM punishment_announcement_channels WHERE source_guild_id = ? AND channel_id = ?
    `);
    stmts.listAnnouncementChannels = db.prepare(`
        SELECT channel_id FROM punishment_announcement_channels WHERE source_guild_id = ? ORDER BY id ASC
    `);
    stmts.findLatestActivePunishment = db.prepare(`
        SELECT * FROM punishment_records WHERE guild_id = ? AND target_user_id = ? AND type = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1
    `);
    stmts.setWarnRole = db.prepare(`
        INSERT INTO punishment_warn_role_config (guild_id, role_id, updated_at)
        VALUES (@guildId, @roleId, @updatedAt)
        ON CONFLICT(guild_id) DO UPDATE SET role_id = @roleId, updated_at = @updatedAt
    `);
    stmts.getSetting = db.prepare(`
        SELECT value FROM punishment_settings WHERE guild_id = ? AND key = ?
    `);
    stmts.setSetting = db.prepare(`
        INSERT INTO punishment_settings (guild_id, key, value, updated_at)
        VALUES (@guildId, @key, @value, @updatedAt)
        ON CONFLICT(guild_id, key) DO UPDATE SET value = @value, updated_at = @updatedAt
    `);

    initialized = true;
    console.log('[Punishment] 数据库初始化完成');
}

// ========== punishment_records ==========

function insertPunishmentRecord({ guildId, targetUserId, executorId, type, reason, durationMs, expiresAt }) {
    const now = nowIso();
    const status = (type === 'unban' || type === 'unmute') ? 'completed' : 'active';
    return stmts.insertRecord.run({
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

function getActiveExpirablePunishments(type) {
    return stmts.getActiveByType.all(type);
}

function markPunishmentExpired(id) {
    return stmts.markExpired.run(nowIso(), id);
}

function getPunishmentRecords(guildId, targetUserId) {
    return stmts.getRecords.all(guildId, targetUserId);
}

// ========== punishment_sync_targets ==========

function getSyncTargets(sourceGuildId) {
    return stmts.getSyncTargets.all(sourceGuildId);
}

function addSyncTarget(sourceGuildId, targetGuildId) {
    return stmts.upsertSyncTarget.run({ sourceGuildId, targetGuildId, createdAt: nowIso() });
}

function removeSyncTarget(sourceGuildId, targetGuildId) {
    return stmts.removeSyncTarget.run(sourceGuildId, targetGuildId);
}

function listSyncTargets(sourceGuildId) {
    return stmts.listSyncTargets.all(sourceGuildId);
}

// ========== punishment_announcement_channels ==========

function addAnnouncementChannel(sourceGuildId, channelId) {
    return stmts.addAnnouncementChannel.run({ sourceGuildId, channelId, createdAt: nowIso() });
}

function removeAnnouncementChannel(sourceGuildId, channelId) {
    return stmts.removeAnnouncementChannel.run(sourceGuildId, channelId);
}

function listAnnouncementChannels(sourceGuildId) {
    return stmts.listAnnouncementChannels.all(sourceGuildId).map(row => row.channel_id);
}

function getAnnouncementChannels(sourceGuildId) {
    const channels = listAnnouncementChannels(sourceGuildId);
    if (channels.length > 0) return channels;

    const legacyChannelId = getSetting(sourceGuildId, 'announcement_channel_id');
    return legacyChannelId ? [legacyChannelId] : [];
}

function findLatestActivePunishment(guildId, targetUserId, type) {
    return stmts.findLatestActivePunishment.get(guildId, targetUserId, type) || null;
}

// ========== punishment_warn_role_config ==========

function getWarnRoleForGuild(guildId) {
    const row = stmts.getWarnRole.get(guildId);
    return row ? row.role_id : null;
}

function setWarnRoleForGuild(guildId, roleId) {
    return stmts.setWarnRole.run({ guildId, roleId, updatedAt: nowIso() });
}

// ========== punishment_settings ==========

function getSetting(guildId, key) {
    const row = stmts.getSetting.get(guildId, key);
    return row ? row.value : null;
}

function setSetting(guildId, key, value) {
    return stmts.setSetting.run({ guildId, key, value, updatedAt: nowIso() });
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
    addAnnouncementChannel,
    removeAnnouncementChannel,
    listAnnouncementChannels,
    getAnnouncementChannels,
    findLatestActivePunishment,
    getWarnRoleForGuild,
    setWarnRoleForGuild,
    getSetting,
    setSetting,
};
