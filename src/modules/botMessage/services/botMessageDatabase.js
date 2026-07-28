// src/modules/botMessage/services/botMessageDatabase.js
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '../../../../data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const BOT_MESSAGE_DB_FILE = path.join(DATA_DIR, 'botMessage.sqlite');
const db = new Database(BOT_MESSAGE_DB_FILE);

// 每条消息最多保留的历史版本数（超出的旧记录会被裁剪）
const MAX_HISTORY_PER_MESSAGE = 30;

let initialized = false;
const stmts = {};

function nowIso() {
    return new Date().toISOString();
}

function initializeBotMessageDatabase() {
    if (initialized) return;

    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');

    db.exec(`
        CREATE TABLE IF NOT EXISTS bot_message_settings (
            guild_id    TEXT NOT NULL,
            key         TEXT NOT NULL,
            value       TEXT NOT NULL,
            updated_at  TEXT NOT NULL,
            PRIMARY KEY (guild_id, key)
        );

        CREATE TABLE IF NOT EXISTS bot_message_history (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id        TEXT NOT NULL,
            channel_id      TEXT NOT NULL,
            message_id      TEXT NOT NULL,
            editor_id       TEXT NOT NULL,
            action          TEXT NOT NULL,
            before_content  TEXT,
            before_embeds   TEXT,
            after_content   TEXT,
            after_embeds    TEXT,
            created_at      TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_bmh_message ON bot_message_history(guild_id, message_id, id);
    `);

    stmts.getSetting = db.prepare(`
        SELECT value FROM bot_message_settings WHERE guild_id = ? AND key = ?
    `);
    stmts.setSetting = db.prepare(`
        INSERT INTO bot_message_settings (guild_id, key, value, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    stmts.deleteSetting = db.prepare(`
        DELETE FROM bot_message_settings WHERE guild_id = ? AND key = ?
    `);
    stmts.insertHistory = db.prepare(`
        INSERT INTO bot_message_history
            (guild_id, channel_id, message_id, editor_id, action, before_content, before_embeds, after_content, after_embeds, created_at)
        VALUES
            (@guildId, @channelId, @messageId, @editorId, @action, @beforeContent, @beforeEmbeds, @afterContent, @afterEmbeds, @createdAt)
    `);
    stmts.getLatestHistory = db.prepare(`
        SELECT * FROM bot_message_history
        WHERE guild_id = ? AND message_id = ?
        ORDER BY id DESC LIMIT 1
    `);
    stmts.getHistory = db.prepare(`
        SELECT * FROM bot_message_history
        WHERE guild_id = ? AND message_id = ?
        ORDER BY id DESC LIMIT ?
    `);
    stmts.pruneHistory = db.prepare(`
        DELETE FROM bot_message_history
        WHERE guild_id = ? AND message_id = ? AND id NOT IN (
            SELECT id FROM bot_message_history
            WHERE guild_id = ? AND message_id = ?
            ORDER BY id DESC LIMIT ?
        )
    `);

    initialized = true;
}

function ensureInit() {
    if (!initialized) initializeBotMessageDatabase();
}

function getSetting(guildId, key) {
    ensureInit();
    const row = stmts.getSetting.get(guildId, key);
    return row ? row.value : null;
}

function setSetting(guildId, key, value) {
    ensureInit();
    stmts.setSetting.run(guildId, key, String(value), nowIso());
}

function deleteSetting(guildId, key) {
    ensureInit();
    stmts.deleteSetting.run(guildId, key);
}

/**
 * 获取允许使用「机器人消息」指令的身份组ID列表
 * @param {string} guildId
 * @returns {string[]}
 */
function getBotMessageAllowedRoles(guildId) {
    const raw = getSetting(guildId, 'allowed_role_ids');
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : [];
    } catch (_) {
        return [];
    }
}

function setBotMessageAllowedRoles(guildId, roleIds) {
    const unique = [...new Set((roleIds || []).filter(Boolean).map(String))];
    setSetting(guildId, 'allowed_role_ids', JSON.stringify(unique));
    return unique;
}

/**
 * 获取操作日志频道ID（未配置返回 null）
 */
function getLogChannelId(guildId) {
    return getSetting(guildId, 'log_channel_id') || null;
}

function setLogChannelId(guildId, channelId) {
    if (!channelId) {
        deleteSetting(guildId, 'log_channel_id');
        return null;
    }
    setSetting(guildId, 'log_channel_id', channelId);
    return channelId;
}

/**
 * 记录一次消息变更（编辑前/编辑后快照），并裁剪过旧的历史
 * @param {object} record
 * @returns {number} 新记录的自增ID
 */
function insertHistory(record) {
    ensureInit();
    const payload = {
        guildId: record.guildId,
        channelId: record.channelId,
        messageId: record.messageId,
        editorId: record.editorId,
        action: record.action,
        beforeContent: record.beforeContent ?? null,
        beforeEmbeds: record.beforeEmbeds ? JSON.stringify(record.beforeEmbeds) : null,
        afterContent: record.afterContent ?? null,
        afterEmbeds: record.afterEmbeds ? JSON.stringify(record.afterEmbeds) : null,
        createdAt: nowIso(),
    };

    const info = stmts.insertHistory.run(payload);

    try {
        stmts.pruneHistory.run(
            record.guildId,
            record.messageId,
            record.guildId,
            record.messageId,
            MAX_HISTORY_PER_MESSAGE,
        );
    } catch (error) {
        console.error('[BotMessage] 裁剪历史记录失败:', error);
    }

    return info.lastInsertRowid;
}

function parseHistoryRow(row) {
    if (!row) return null;
    const safeParse = (text) => {
        if (!text) return null;
        try {
            return JSON.parse(text);
        } catch (_) {
            return null;
        }
    };
    return {
        ...row,
        beforeEmbeds: safeParse(row.before_embeds),
        afterEmbeds: safeParse(row.after_embeds),
    };
}

/**
 * 获取某条消息最近一次变更记录
 */
function getLatestHistory(guildId, messageId) {
    ensureInit();
    return parseHistoryRow(stmts.getLatestHistory.get(guildId, messageId));
}

/**
 * 获取某条消息的变更记录（倒序）
 */
function getHistory(guildId, messageId, limit = 10) {
    ensureInit();
    return stmts.getHistory.all(guildId, messageId, limit).map(parseHistoryRow);
}

module.exports = {
    initializeBotMessageDatabase,
    getSetting,
    setSetting,
    deleteSetting,
    getBotMessageAllowedRoles,
    setBotMessageAllowedRoles,
    getLogChannelId,
    setLogChannelId,
    insertHistory,
    getLatestHistory,
    getHistory,
    MAX_HISTORY_PER_MESSAGE,
};
