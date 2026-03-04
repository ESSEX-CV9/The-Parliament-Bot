const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '../../../../data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const CI_DB_FILE = path.join(DATA_DIR, 'controlledInvite.sqlite');
const db = new Database(CI_DB_FILE);

let initialized = false;
const stmts = {};

function nowIso() {
    return new Date().toISOString();
}

function initializeControlledInviteDatabase() {
    if (initialized) return;

    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');

    db.exec(`
        -- 配置表：每对主服-分服一条记录
        CREATE TABLE IF NOT EXISTS ci_configs (
            main_guild_id           TEXT NOT NULL,
            sub_guild_id            TEXT NOT NULL,
            sub_invite_channel_id   TEXT,
            entry_channel_id        TEXT,
            entry_message_id        TEXT,
            log_channel_id          TEXT,
            invite_max_age_seconds  INTEGER NOT NULL DEFAULT 900,
            cooldown_seconds        INTEGER NOT NULL DEFAULT 10800,
            ban_on_unknown_join     INTEGER NOT NULL DEFAULT 1,
            blacklist_owner_on_misuse INTEGER NOT NULL DEFAULT 1,
            enabled                 INTEGER NOT NULL DEFAULT 1,
            updated_at              TEXT NOT NULL,
            PRIMARY KEY (main_guild_id, sub_guild_id)
        );

        -- 资格角色表：主服身份组
        CREATE TABLE IF NOT EXISTS ci_eligible_roles (
            main_guild_id   TEXT NOT NULL,
            role_id         TEXT NOT NULL,
            created_at      TEXT NOT NULL,
            PRIMARY KEY (main_guild_id, role_id)
        );

        -- 邀请申请记录表
        CREATE TABLE IF NOT EXISTS ci_invite_requests (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            main_guild_id       TEXT NOT NULL,
            sub_guild_id        TEXT NOT NULL,
            owner_user_id       TEXT NOT NULL,
            invite_code         TEXT NOT NULL,
            invite_url          TEXT NOT NULL,
            status              TEXT NOT NULL DEFAULT 'active',
            created_at          TEXT NOT NULL,
            expires_at          TEXT NOT NULL,
            consumed_at         TEXT,
            suspect_at          TEXT,
            misuse_confirmed_at TEXT,
            misuse_action_json  TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_cir_sub_code ON ci_invite_requests(sub_guild_id, invite_code);
        CREATE INDEX IF NOT EXISTS idx_cir_owner ON ci_invite_requests(main_guild_id, sub_guild_id, owner_user_id, status);
        CREATE INDEX IF NOT EXISTS idx_cir_status_expires ON ci_invite_requests(status, expires_at);

        -- 冷却表
        CREATE TABLE IF NOT EXISTS ci_cooldowns (
            main_guild_id   TEXT NOT NULL,
            sub_guild_id    TEXT NOT NULL,
            user_id         TEXT NOT NULL,
            next_available_at TEXT NOT NULL,
            PRIMARY KEY (main_guild_id, sub_guild_id, user_id)
        );

        -- 黑名单表
        CREATE TABLE IF NOT EXISTS ci_blacklist (
            main_guild_id       TEXT NOT NULL,
            user_id             TEXT NOT NULL,
            sub_guild_id        TEXT DEFAULT '',
            reason              TEXT,
            source_request_id   INTEGER,
            created_by          TEXT NOT NULL DEFAULT 'admin',
            created_at          TEXT NOT NULL,
            expires_at          TEXT,
            PRIMARY KEY (main_guild_id, user_id, sub_guild_id)
        );

        -- 邀请请求预占位（并发一致性）
        CREATE TABLE IF NOT EXISTS ci_request_reservations (
            main_guild_id       TEXT NOT NULL,
            sub_guild_id        TEXT NOT NULL,
            user_id             TEXT NOT NULL,
            reserved_at         TEXT NOT NULL,
            expires_at          TEXT NOT NULL,
            PRIMARY KEY (main_guild_id, sub_guild_id, user_id)
        );
    `);

    // ========== ci_configs ==========
    stmts.upsertConfig = db.prepare(`
        INSERT INTO ci_configs (main_guild_id, sub_guild_id, enabled, updated_at)
        VALUES (@mainGuildId, @subGuildId, 1, @updatedAt)
        ON CONFLICT(main_guild_id, sub_guild_id) DO UPDATE SET enabled = 1, updated_at = @updatedAt
    `);
    stmts.getConfig = db.prepare(`
        SELECT * FROM ci_configs WHERE main_guild_id = ? AND sub_guild_id = ?
    `);
    stmts.getConfigsByMain = db.prepare(`
        SELECT * FROM ci_configs WHERE main_guild_id = ?
    `);
    stmts.getConfigBySub = db.prepare(`
        SELECT * FROM ci_configs WHERE sub_guild_id = ?
    `);
    stmts.getAllConfigs = db.prepare(`
        SELECT * FROM ci_configs
    `);
    stmts.deleteConfig = db.prepare(`
        UPDATE ci_configs SET enabled = 0, updated_at = ? WHERE main_guild_id = ? AND sub_guild_id = ?
    `);
    stmts.updateConfigField = db.prepare(`
        UPDATE ci_configs SET updated_at = @updatedAt
        WHERE main_guild_id = @mainGuildId AND sub_guild_id = @subGuildId
    `);
    stmts.setSubInviteChannel = db.prepare(`
        UPDATE ci_configs SET sub_invite_channel_id = ?, updated_at = ? WHERE main_guild_id = ? AND sub_guild_id = ?
    `);
    stmts.setLogChannel = db.prepare(`
        UPDATE ci_configs SET log_channel_id = ?, updated_at = ? WHERE main_guild_id = ? AND sub_guild_id = ?
    `);
    stmts.setEntryMessage = db.prepare(`
        UPDATE ci_configs SET entry_channel_id = ?, entry_message_id = ?, updated_at = ? WHERE main_guild_id = ? AND sub_guild_id = ?
    `);
    stmts.setInviteMaxAge = db.prepare(`
        UPDATE ci_configs SET invite_max_age_seconds = ?, updated_at = ? WHERE main_guild_id = ? AND sub_guild_id = ?
    `);
    stmts.setCooldown = db.prepare(`
        UPDATE ci_configs SET cooldown_seconds = ?, updated_at = ? WHERE main_guild_id = ? AND sub_guild_id = ?
    `);
    stmts.setEnabled = db.prepare(`
        UPDATE ci_configs SET enabled = ?, updated_at = ? WHERE main_guild_id = ? AND sub_guild_id = ?
    `);
    stmts.setBanOnUnknown = db.prepare(`
        UPDATE ci_configs SET ban_on_unknown_join = ?, updated_at = ? WHERE main_guild_id = ? AND sub_guild_id = ?
    `);
    stmts.setBlacklistOnMisuse = db.prepare(`
        UPDATE ci_configs SET blacklist_owner_on_misuse = ?, updated_at = ? WHERE main_guild_id = ? AND sub_guild_id = ?
    `);

    // ========== ci_eligible_roles ==========
    stmts.addEligibleRole = db.prepare(`
        INSERT OR IGNORE INTO ci_eligible_roles (main_guild_id, role_id, created_at)
        VALUES (?, ?, ?)
    `);
    stmts.removeEligibleRole = db.prepare(`
        DELETE FROM ci_eligible_roles WHERE main_guild_id = ? AND role_id = ?
    `);
    stmts.getEligibleRoles = db.prepare(`
        SELECT role_id FROM ci_eligible_roles WHERE main_guild_id = ?
    `);
    stmts.clearEligibleRoles = db.prepare(`
        DELETE FROM ci_eligible_roles WHERE main_guild_id = ?
    `);

    // ========== ci_invite_requests ==========
    stmts.insertRequest = db.prepare(`
        INSERT INTO ci_invite_requests (main_guild_id, sub_guild_id, owner_user_id, invite_code, invite_url, status, created_at, expires_at)
        VALUES (@mainGuildId, @subGuildId, @ownerUserId, @inviteCode, @inviteUrl, 'active', @createdAt, @expiresAt)
    `);
    stmts.getActiveRequestByOwner = db.prepare(`
        SELECT * FROM ci_invite_requests
        WHERE main_guild_id = ? AND sub_guild_id = ? AND owner_user_id = ? AND status = 'active'
        LIMIT 1
    `);
    stmts.getActiveRequestByCode = db.prepare(`
        SELECT * FROM ci_invite_requests
        WHERE sub_guild_id = ? AND invite_code = ? AND status = 'active'
        LIMIT 1
    `);
    stmts.getActiveRequestsByOwnerAnySubGuild = db.prepare(`
        SELECT * FROM ci_invite_requests
        WHERE main_guild_id = ? AND owner_user_id = ? AND status = 'active'
    `);
    stmts.getActiveRequestsBySubGuild = db.prepare(`
        SELECT * FROM ci_invite_requests
        WHERE sub_guild_id = ? AND status = 'active'
    `);
    stmts.markConsumed = db.prepare(`
        UPDATE ci_invite_requests SET status = 'consumed', consumed_at = ?
        WHERE id = ? AND status = 'active'
    `);
    stmts.markExpired = db.prepare(`
        UPDATE ci_invite_requests SET status = 'expired'
        WHERE id = ? AND status = 'active'
    `);
    stmts.markRevoked = db.prepare(`
        UPDATE ci_invite_requests SET status = 'revoked'
        WHERE id = ? AND status = 'active'
    `);
    stmts.markSuspect = db.prepare(`
        UPDATE ci_invite_requests SET status = 'suspect', suspect_at = ?
        WHERE id = ? AND status = 'active'
    `);
    stmts.markMisused = db.prepare(`
        UPDATE ci_invite_requests SET status = 'misused', misuse_confirmed_at = ?, misuse_action_json = ?
        WHERE id = ? AND status = 'suspect'
    `);
    stmts.markSuspectConsumed = db.prepare(`
        UPDATE ci_invite_requests SET status = 'consumed', consumed_at = ?
        WHERE id = ? AND status = 'suspect'
    `);
    stmts.getExpiredActiveRequests = db.prepare(`
        SELECT * FROM ci_invite_requests
        WHERE status = 'active' AND expires_at <= ?
    `);
    stmts.getActiveNotExpiringSoon = db.prepare(`
        SELECT * FROM ci_invite_requests
        WHERE status = 'active' AND expires_at > ?
    `);
    stmts.getSuspectRequests = db.prepare(`
        SELECT * FROM ci_invite_requests WHERE status = 'suspect'
    `);
    stmts.getActiveRequestsForSubGuild = db.prepare(`
        SELECT * FROM ci_invite_requests
        WHERE sub_guild_id = ? AND status IN ('active', 'suspect')
        ORDER BY created_at DESC
    `);
    stmts.revokeActiveByOwner = db.prepare(`
        UPDATE ci_invite_requests SET status = 'revoked'
        WHERE main_guild_id = ? AND owner_user_id = ? AND status = 'active'
    `);
    stmts.revokeActiveByOwnerAndSubGuild = db.prepare(`
        UPDATE ci_invite_requests SET status = 'revoked'
        WHERE main_guild_id = ? AND sub_guild_id = ? AND owner_user_id = ? AND status = 'active'
    `);

    // ========== ci_cooldowns ==========
    stmts.getCooldown = db.prepare(`
        SELECT next_available_at FROM ci_cooldowns
        WHERE main_guild_id = ? AND sub_guild_id = ? AND user_id = ?
    `);
    stmts.setCooldown = db.prepare(`
        INSERT INTO ci_cooldowns (main_guild_id, sub_guild_id, user_id, next_available_at)
        VALUES (@mainGuildId, @subGuildId, @userId, @nextAvailableAt)
        ON CONFLICT(main_guild_id, sub_guild_id, user_id) DO UPDATE SET next_available_at = @nextAvailableAt
    `);

    // ========== ci_blacklist ==========
    stmts.addBlacklist = db.prepare(`
        INSERT INTO ci_blacklist (main_guild_id, user_id, sub_guild_id, reason, source_request_id, created_by, created_at, expires_at)
        VALUES (@mainGuildId, @userId, @subGuildId, @reason, @sourceRequestId, @createdBy, @createdAt, @expiresAt)
        ON CONFLICT(main_guild_id, user_id, sub_guild_id) DO UPDATE SET
            reason = @reason, source_request_id = @sourceRequestId, created_by = @createdBy,
            created_at = @createdAt, expires_at = @expiresAt
    `);
    stmts.removeBlacklist = db.prepare(`
        DELETE FROM ci_blacklist WHERE main_guild_id = ? AND user_id = ? AND sub_guild_id = ?
    `);
    stmts.removeBlacklistAll = db.prepare(`
        DELETE FROM ci_blacklist WHERE main_guild_id = ? AND user_id = ?
    `);
    stmts.getBlacklist = db.prepare(`
        SELECT * FROM ci_blacklist WHERE main_guild_id = ? AND user_id = ?
    `);
    stmts.isBlacklisted = db.prepare(`
        SELECT 1 FROM ci_blacklist
        WHERE main_guild_id = ? AND user_id = ? AND (sub_guild_id = '' OR sub_guild_id = ?)
        AND (expires_at IS NULL OR expires_at > ?)
        LIMIT 1
    `);
    stmts.getBlacklistByMainGuild = db.prepare(`
        SELECT * FROM ci_blacklist WHERE main_guild_id = ? AND (sub_guild_id = '' OR sub_guild_id = ?)
        ORDER BY created_at DESC
    `);

    // ========== ci_request_reservations ==========
    stmts.clearExpiredReservations = db.prepare(`
        DELETE FROM ci_request_reservations WHERE expires_at <= ?
    `);
    stmts.insertReservation = db.prepare(`
        INSERT OR IGNORE INTO ci_request_reservations (main_guild_id, sub_guild_id, user_id, reserved_at, expires_at)
        VALUES (@mainGuildId, @subGuildId, @userId, @reservedAt, @expiresAt)
    `);
    stmts.releaseReservation = db.prepare(`
        DELETE FROM ci_request_reservations WHERE main_guild_id = ? AND sub_guild_id = ? AND user_id = ?
    `);

    stmts.reserveInviteRequestSlotTx = db.transaction(({ mainGuildId, subGuildId, userId, reservedAt, expiresAt, now }) => {
        stmts.clearExpiredReservations.run(now);

        const existingRequest = stmts.getActiveRequestByOwner.get(mainGuildId, subGuildId, userId) || null;
        if (existingRequest) {
            return {
                ok: false,
                reason: 'existing_active',
                existingRequest,
            };
        }

        const insertResult = stmts.insertReservation.run({ mainGuildId, subGuildId, userId, reservedAt, expiresAt });
        if (insertResult.changes === 0) {
            return {
                ok: false,
                reason: 'already_reserved',
            };
        }

        return { ok: true };
    });

    initialized = true;
    console.log('[ControlledInvite] 数据库初始化完成');
}

// ========== Config ==========

function bindGuilds(mainGuildId, subGuildId) {
    return stmts.upsertConfig.run({ mainGuildId, subGuildId, updatedAt: nowIso() });
}

function unbindGuilds(mainGuildId, subGuildId) {
    return stmts.deleteConfig.run(nowIso(), mainGuildId, subGuildId);
}

function getConfig(mainGuildId, subGuildId) {
    return stmts.getConfig.get(mainGuildId, subGuildId) || null;
}

function getConfigsByMainGuild(mainGuildId) {
    return stmts.getConfigsByMain.all(mainGuildId);
}

function getConfigBySubGuild(subGuildId) {
    return stmts.getConfigBySub.get(subGuildId) || null;
}

function getAllConfigs() {
    return stmts.getAllConfigs.all();
}

function setSubInviteChannel(mainGuildId, subGuildId, channelId) {
    return stmts.setSubInviteChannel.run(channelId, nowIso(), mainGuildId, subGuildId);
}

function setLogChannel(mainGuildId, subGuildId, channelId) {
    return stmts.setLogChannel.run(channelId, nowIso(), mainGuildId, subGuildId);
}

function setEntryMessage(mainGuildId, subGuildId, channelId, messageId) {
    return stmts.setEntryMessage.run(channelId, messageId, nowIso(), mainGuildId, subGuildId);
}

function setInviteMaxAge(mainGuildId, subGuildId, seconds) {
    return stmts.setInviteMaxAge.run(seconds, nowIso(), mainGuildId, subGuildId);
}

function setCooldownSeconds(mainGuildId, subGuildId, seconds) {
    return stmts.setCooldown.run(seconds, nowIso(), mainGuildId, subGuildId);
}

function setEnabled(mainGuildId, subGuildId, enabled) {
    return stmts.setEnabled.run(enabled ? 1 : 0, nowIso(), mainGuildId, subGuildId);
}

function setBanOnUnknownJoin(mainGuildId, subGuildId, ban) {
    return stmts.setBanOnUnknown.run(ban ? 1 : 0, nowIso(), mainGuildId, subGuildId);
}

function setBlacklistOwnerOnMisuse(mainGuildId, subGuildId, blacklist) {
    return stmts.setBlacklistOnMisuse.run(blacklist ? 1 : 0, nowIso(), mainGuildId, subGuildId);
}

// ========== Eligible Roles ==========

function addEligibleRole(mainGuildId, roleId) {
    return stmts.addEligibleRole.run(mainGuildId, roleId, nowIso());
}

function removeEligibleRole(mainGuildId, roleId) {
    return stmts.removeEligibleRole.run(mainGuildId, roleId);
}

function getEligibleRoles(mainGuildId) {
    return stmts.getEligibleRoles.all(mainGuildId).map(r => r.role_id);
}

function clearEligibleRoles(mainGuildId) {
    return stmts.clearEligibleRoles.run(mainGuildId);
}

// ========== Invite Requests ==========

function createInviteRequest({ mainGuildId, subGuildId, ownerUserId, inviteCode, inviteUrl, expiresAt }) {
    const now = nowIso();
    return stmts.insertRequest.run({
        mainGuildId, subGuildId, ownerUserId, inviteCode, inviteUrl, createdAt: now, expiresAt,
    });
}

function tryReserveInviteRequestSlot(mainGuildId, subGuildId, userId, reservationTtlSeconds = 45) {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + reservationTtlSeconds * 1000).toISOString();

    return stmts.reserveInviteRequestSlotTx({
        mainGuildId,
        subGuildId,
        userId,
        reservedAt: now,
        expiresAt,
        now,
    });
}

function releaseInviteRequestSlot(mainGuildId, subGuildId, userId) {
    return stmts.releaseReservation.run(mainGuildId, subGuildId, userId);
}

function clearExpiredInviteRequestReservations() {
    return stmts.clearExpiredReservations.run(nowIso());
}

function getActiveRequestByOwner(mainGuildId, subGuildId, ownerUserId) {
    return stmts.getActiveRequestByOwner.get(mainGuildId, subGuildId, ownerUserId) || null;
}

function getActiveRequestByCode(subGuildId, inviteCode) {
    return stmts.getActiveRequestByCode.get(subGuildId, inviteCode) || null;
}

function getActiveRequestsByOwnerAnySubGuild(mainGuildId, ownerUserId) {
    return stmts.getActiveRequestsByOwnerAnySubGuild.all(mainGuildId, ownerUserId);
}

function getActiveRequestsBySubGuild(subGuildId) {
    return stmts.getActiveRequestsBySubGuild.all(subGuildId);
}

function markRequestConsumed(id) {
    return stmts.markConsumed.run(nowIso(), id);
}

function markRequestExpired(id) {
    return stmts.markExpired.run(id);
}

function markRequestRevoked(id) {
    return stmts.markRevoked.run(id);
}

function markRequestSuspect(id) {
    return stmts.markSuspect.run(nowIso(), id);
}

function markRequestMisused(id, actionJson) {
    return stmts.markMisused.run(nowIso(), actionJson || null, id);
}

function markSuspectConsumed(id) {
    return stmts.markSuspectConsumed.run(nowIso(), id);
}

function getExpiredActiveRequests() {
    return stmts.getExpiredActiveRequests.all(nowIso());
}

function getActiveNotExpiringSoon(bufferSeconds = 90) {
    const threshold = new Date(Date.now() + bufferSeconds * 1000).toISOString();
    return stmts.getActiveNotExpiringSoon.all(threshold);
}

function getSuspectRequests() {
    return stmts.getSuspectRequests.all();
}

function getActiveRequestsForSubGuild(subGuildId) {
    return stmts.getActiveRequestsForSubGuild.all(subGuildId);
}

function revokeActiveByOwner(mainGuildId, ownerUserId) {
    return stmts.revokeActiveByOwner.run(mainGuildId, ownerUserId);
}

function revokeActiveByOwnerAndSubGuild(mainGuildId, subGuildId, ownerUserId) {
    return stmts.revokeActiveByOwnerAndSubGuild.run(mainGuildId, subGuildId, ownerUserId);
}

// ========== Cooldowns ==========

function getCooldown(mainGuildId, subGuildId, userId) {
    const row = stmts.getCooldown.get(mainGuildId, subGuildId, userId);
    return row ? row.next_available_at : null;
}

function setCooldown(mainGuildId, subGuildId, userId, nextAvailableAt) {
    return stmts.setCooldown.run({ mainGuildId, subGuildId, userId, nextAvailableAt });
}

function isOnCooldown(mainGuildId, subGuildId, userId) {
    const nextAvailable = getCooldown(mainGuildId, subGuildId, userId);
    if (!nextAvailable) return { onCooldown: false };
    const remaining = new Date(nextAvailable).getTime() - Date.now();
    if (remaining <= 0) return { onCooldown: false };
    return { onCooldown: true, remainingMs: remaining, nextAvailableAt: nextAvailable };
}

// ========== Blacklist ==========

function addToBlacklist({ mainGuildId, userId, subGuildId = '', reason = null, sourceRequestId = null, createdBy = 'admin' }) {
    return stmts.addBlacklist.run({
        mainGuildId, userId, subGuildId, reason,
        sourceRequestId, createdBy, createdAt: nowIso(), expiresAt: null,
    });
}

function removeFromBlacklist(mainGuildId, userId, subGuildId = '') {
    if (subGuildId === '') {
        return stmts.removeBlacklistAll.run(mainGuildId, userId);
    }
    return stmts.removeBlacklist.run(mainGuildId, userId, subGuildId);
}

function isUserBlacklisted(mainGuildId, userId, subGuildId = '') {
    const row = stmts.isBlacklisted.get(mainGuildId, userId, subGuildId, nowIso());
    return !!row;
}

function getBlacklistEntries(mainGuildId, userId) {
    return stmts.getBlacklist.all(mainGuildId, userId);
}

function getBlacklistByMainGuild(mainGuildId, subGuildId = '') {
    return stmts.getBlacklistByMainGuild.all(mainGuildId, subGuildId);
}

module.exports = {
    initializeControlledInviteDatabase,

    // Config
    bindGuilds,
    unbindGuilds,
    getConfig,
    getConfigsByMainGuild,
    getConfigBySubGuild,
    getAllConfigs,
    setSubInviteChannel,
    setLogChannel,
    setEntryMessage,
    setInviteMaxAge,
    setCooldownSeconds,
    setEnabled,
    setBanOnUnknownJoin,
    setBlacklistOwnerOnMisuse,

    // Eligible Roles
    addEligibleRole,
    removeEligibleRole,
    getEligibleRoles,
    clearEligibleRoles,

    // Invite Requests
    createInviteRequest,
    tryReserveInviteRequestSlot,
    releaseInviteRequestSlot,
    clearExpiredInviteRequestReservations,
    getActiveRequestByOwner,
    getActiveRequestByCode,
    getActiveRequestsByOwnerAnySubGuild,
    getActiveRequestsBySubGuild,
    markRequestConsumed,
    markRequestExpired,
    markRequestRevoked,
    markRequestSuspect,
    markRequestMisused,
    markSuspectConsumed,
    getExpiredActiveRequests,
    getActiveNotExpiringSoon,
    getSuspectRequests,
    getActiveRequestsForSubGuild,
    revokeActiveByOwner,
    revokeActiveByOwnerAndSubGuild,

    // Cooldowns
    getCooldown,
    setCooldown,
    isOnCooldown,

    // Blacklist
    addToBlacklist,
    removeFromBlacklist,
    isUserBlacklisted,
    getBlacklistEntries,
    getBlacklistByMainGuild,
};
