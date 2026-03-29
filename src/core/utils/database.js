// src\core\utils\database.js
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const Database = require('better-sqlite3');

// 确保数据目录存在
const DATA_DIR = path.join(__dirname, '../../../data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const CHECK_SETTINGS_FILE = path.join(DATA_DIR, 'checkSettings.json');
const REVIEW_SETTINGS_FILE = path.join(DATA_DIR, 'reviewSettings.json');
const ALLOWED_SERVERS_FILE = path.join(DATA_DIR, 'allowedServers.json');
const COURT_SETTINGS_FILE = path.join(DATA_DIR, 'courtSettings.json');
const COURT_APPLICATIONS_FILE = path.join(DATA_DIR, 'courtApplications.json');
const COURT_VOTES_FILE = path.join(DATA_DIR, 'courtVotes.json');
const SELF_MODERATION_SETTINGS_FILE = path.join(DATA_DIR, 'selfModerationSettings.json');
const SELF_MODERATION_VOTES_FILE = path.join(DATA_DIR, 'selfModerationVotes.json');
const SELF_FILE_UPLOAD_LOGS_FILE = path.join(DATA_DIR, 'selfFileUploadLogs.json');
const ANONYMOUS_UPLOAD_OPT_OUT_FILE = path.join(__dirname, '../../../data/anonymous_upload_opt_out.json');
const ARCHIVE_SETTINGS_FILE = path.join(DATA_DIR, 'archiveSettings.json');
const AUTO_CLEANUP_SETTINGS_FILE = path.join(DATA_DIR, 'autoCleanupSettings.json');
const AUTO_CLEANUP_TASKS_FILE = path.join(DATA_DIR, 'autoCleanupTasks.json');
const SELF_ROLE_DB_FILE = path.join(DATA_DIR, 'selfRole.sqlite');
const SELF_MODERATION_BLACKLIST_FILE = path.join(DATA_DIR, 'selfModerationBlacklist.json');

// --- Self Role SQLite Database Initialization ---
const selfRoleDb = new Database(SELF_ROLE_DB_FILE);

// --- SelfRole 配置 JSON 兼容层（v3 Step 1） ---
// 说明：当前 role_settings.roles 仍以“角色配置数组”的 JSON 字符串存储。
// 为保证后续大版本演进的兼容性，读取/写入时统一做结构归一化与容错解析。
const SELF_ROLE_ROLE_CONFIG_SCHEMA_VERSION = 2;

function safeJsonParse(text, fallback) {
    try {
        return JSON.parse(text);
    } catch (err) {
        return fallback;
    }
}

function normalizeSelfRoleRoleConfig(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return null;
    }

    const roleConfig = { ...input };

    // schemaVersion: 用于后续演进（不依赖它判定逻辑，只作为标记）
    if (typeof roleConfig.schemaVersion !== 'number') {
        roleConfig.schemaVersion = SELF_ROLE_ROLE_CONFIG_SCHEMA_VERSION;
    }

    if (typeof roleConfig.roleId !== 'string') {
        // roleId 缺失则该条配置无效
        return null;
    }

    if (typeof roleConfig.label !== 'string') {
        roleConfig.label = roleConfig.label == null ? '' : String(roleConfig.label);
    }
    if (typeof roleConfig.description !== 'string') {
        roleConfig.description = roleConfig.description == null ? '' : String(roleConfig.description);
    }
    if (!roleConfig.conditions || typeof roleConfig.conditions !== 'object' || Array.isArray(roleConfig.conditions)) {
        roleConfig.conditions = {};
    }

    // 配套身份组（用于审核通过/直授时一并发放）
    if (!Array.isArray(roleConfig.bundleRoleIds)) {
        roleConfig.bundleRoleIds = [];
    }
    roleConfig.bundleRoleIds = [...new Set(
        roleConfig.bundleRoleIds
            .filter(rid => typeof rid === 'string')
            .map(rid => rid.trim())
            .filter(Boolean)
    )];

    // 生命周期配置（周期询问/强制清退/onlyWhenFull 等）
    if (!roleConfig.lifecycle || typeof roleConfig.lifecycle !== 'object' || Array.isArray(roleConfig.lifecycle)) {
        roleConfig.lifecycle = {};
    }
    if (typeof roleConfig.lifecycle.enabled !== 'boolean') {
        roleConfig.lifecycle.enabled = false;
    }
    if (roleConfig.lifecycle.inquiryDays != null) {
        const v = Number(roleConfig.lifecycle.inquiryDays);
        roleConfig.lifecycle.inquiryDays = Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
    }
    if (roleConfig.lifecycle.forceRemoveDays != null) {
        const v = Number(roleConfig.lifecycle.forceRemoveDays);
        roleConfig.lifecycle.forceRemoveDays = Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
    }
    if (typeof roleConfig.lifecycle.onlyWhenFull !== 'boolean') {
        roleConfig.lifecycle.onlyWhenFull = false;
    }
    if (roleConfig.lifecycle.reportChannelId != null && typeof roleConfig.lifecycle.reportChannelId !== 'string') {
        roleConfig.lifecycle.reportChannelId = String(roleConfig.lifecycle.reportChannelId);
    }

    return roleConfig;
}

function normalizeSelfRoleSettings(input) {
    const settings = input && typeof input === 'object' ? { ...input } : {};
    const rolesRaw = Array.isArray(settings.roles) ? settings.roles : [];
    const roles = rolesRaw.map(normalizeSelfRoleRoleConfig).filter(Boolean);
    return { ...settings, roles };
}

function initializeSelfRoleDatabase() {
    // role_settings 表
    selfRoleDb.exec(`
        CREATE TABLE IF NOT EXISTS role_settings (
            guild_id TEXT PRIMARY KEY,
            roles TEXT NOT NULL,
            last_successful_save TEXT
        )
    `);

    // user_activity 表
    selfRoleDb.exec(`
        CREATE TABLE IF NOT EXISTS user_activity (
            guild_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            message_count INTEGER DEFAULT 0,
            mentioned_count INTEGER DEFAULT 0,
            mentioning_count INTEGER DEFAULT 0,
            PRIMARY KEY (guild_id, channel_id, user_id)
        )
    `);

    // daily_user_activity 表 ：按日期统计的用户活跃度
    selfRoleDb.exec(`
        CREATE TABLE IF NOT EXISTS daily_user_activity (
            guild_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            date TEXT NOT NULL,
            message_count INTEGER DEFAULT 0,
            mentioned_count INTEGER DEFAULT 0,
            mentioning_count INTEGER DEFAULT 0,
            PRIMARY KEY (guild_id, channel_id, user_id, date)
        )
    `);

    // role_applications 表
    selfRoleDb.exec(`
        CREATE TABLE IF NOT EXISTS role_applications (
            message_id TEXT PRIMARY KEY,
            applicant_id TEXT NOT NULL,
            role_id TEXT NOT NULL,
            status TEXT NOT NULL,
            approvers TEXT,
            rejecters TEXT
        )
    `);

    // role_cooldowns 表 ：被人工审核拒绝后的冷却期记录（单位：ms）
    
    selfRoleDb.exec(`
        CREATE TABLE IF NOT EXISTS role_cooldowns (
            guild_id TEXT NOT NULL,
            role_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            PRIMARY KEY (guild_id, role_id, user_id)
        )
    `);

    // 为 role_applications 表进行列演进：reason 文本列（可空）
    try {
        const cols = selfRoleDb.prepare("PRAGMA table_info(role_applications)").all();

        const hasReason = Array.isArray(cols) && cols.some(c => c.name === 'reason');
        if (!hasReason) {
            selfRoleDb.exec("ALTER TABLE role_applications ADD COLUMN reason TEXT");
            console.log('[SelfRole] 🔧 已为 role_applications 添加 reason 列');
        }

        const hasRejectReasons = Array.isArray(cols) && cols.some(c => c.name === 'reject_reasons');
        if (!hasRejectReasons) {
            selfRoleDb.exec("ALTER TABLE role_applications ADD COLUMN reject_reasons TEXT");
            console.log('[SelfRole] 🔧 已为 role_applications 添加 reject_reasons 列');
        }
    } catch (migErr) {
        console.error('[SelfRole] ❌ 检查/添加 role_applications 扩展列时出错：', migErr);
    }

    // --- SelfRole v2 运行态表（v3 Step 1） ---
    // 说明：以下表用于承载“名额预留/申请生命周期/grant 生命周期/面板注册/告警”等能力。
    // 目前仍保留旧表（role_applications 等）用于兼容旧版本流程；后续步骤将逐步切换到 v2 表。
    selfRoleDb.exec(`
        CREATE TABLE IF NOT EXISTS sr_applications_v2 (
            application_id    TEXT PRIMARY KEY,
            guild_id          TEXT NOT NULL,
            applicant_id      TEXT NOT NULL,
            role_id           TEXT NOT NULL,
            status            TEXT NOT NULL,
            reason            TEXT,
            review_message_id TEXT,
            review_channel_id TEXT,
            slot_reserved     INTEGER DEFAULT 0,
            reserved_until    INTEGER,
            created_at        INTEGER NOT NULL,
            resolved_at       INTEGER,
            resolution_reason TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sr_app_v2_guild_role_status
            ON sr_applications_v2 (guild_id, role_id, status);
        CREATE INDEX IF NOT EXISTS idx_sr_app_v2_reserved_until
            ON sr_applications_v2 (reserved_until);
        CREATE INDEX IF NOT EXISTS idx_sr_app_v2_review_message_id
            ON sr_applications_v2 (review_message_id);
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_sr_app_v2_pending
            ON sr_applications_v2 (guild_id, applicant_id, role_id)
            WHERE status = 'pending';
    `);

    // 为 sr_applications_v2 表进行列演进：review_channel_id（用于定位审核面板消息所在频道/子区/论坛主题）
    try {
        const cols = selfRoleDb.prepare("PRAGMA table_info(sr_applications_v2)").all();
        const hasReviewChannelId = Array.isArray(cols) && cols.some(c => c.name === 'review_channel_id');
        if (!hasReviewChannelId) {
            selfRoleDb.exec("ALTER TABLE sr_applications_v2 ADD COLUMN review_channel_id TEXT");
            console.log('[SelfRole] 🔧 已为 sr_applications_v2 添加 review_channel_id 列');
        }
    } catch (migErr) {
        console.error('[SelfRole] ❌ 检查/添加 sr_applications_v2 扩展列时出错：', migErr);
    }

    selfRoleDb.exec(`
        CREATE TABLE IF NOT EXISTS sr_application_votes (
            application_id TEXT NOT NULL,
            voter_id       TEXT NOT NULL,
            vote           TEXT NOT NULL,
            reason         TEXT,
            updated_at     INTEGER NOT NULL,
            PRIMARY KEY (application_id, voter_id)
        );
        CREATE INDEX IF NOT EXISTS idx_sr_votes_application_id
            ON sr_application_votes (application_id);
    `);

    selfRoleDb.exec(`
        CREATE TABLE IF NOT EXISTS sr_grants (
            grant_id                  TEXT PRIMARY KEY,
            guild_id                  TEXT NOT NULL,
            user_id                   TEXT NOT NULL,
            primary_role_id           TEXT NOT NULL,
            application_id            TEXT,
            granted_at                INTEGER NOT NULL,
            status                    TEXT NOT NULL,
            next_inquiry_at           INTEGER,
            force_remove_at           INTEGER,
            last_inquiry_at           INTEGER,
            last_decision             TEXT,
            ended_at                  INTEGER,
            ended_reason              TEXT,
            manual_attention_required INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_sr_grants_guild_role_status
            ON sr_grants (guild_id, primary_role_id, status);
        CREATE INDEX IF NOT EXISTS idx_sr_grants_next_inquiry_at
            ON sr_grants (next_inquiry_at);
        CREATE INDEX IF NOT EXISTS idx_sr_grants_force_remove_at
            ON sr_grants (force_remove_at);
    `);

    selfRoleDb.exec(`
        CREATE TABLE IF NOT EXISTS sr_grant_roles (
            grant_id  TEXT NOT NULL,
            role_id   TEXT NOT NULL,
            role_kind TEXT NOT NULL,
            PRIMARY KEY (grant_id, role_id)
        );
        CREATE INDEX IF NOT EXISTS idx_sr_grant_roles_grant_id
            ON sr_grant_roles (grant_id);
    `);

    selfRoleDb.exec(`
        CREATE TABLE IF NOT EXISTS sr_renewal_sessions (
            session_id              TEXT PRIMARY KEY,
            grant_id                TEXT NOT NULL,
            cycle_no                INTEGER NOT NULL,
            status                  TEXT NOT NULL,
            dm_message_id           TEXT,
            asked_at                INTEGER,
            responded_at            INTEGER,
            decision                TEXT,
            report_message_id       TEXT,
            requires_admin_followup INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_sr_renewal_sessions_grant_id
            ON sr_renewal_sessions (grant_id);
        CREATE INDEX IF NOT EXISTS idx_sr_renewal_sessions_status
            ON sr_renewal_sessions (status);
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_sr_renewal_sessions_pending_by_grant
            ON sr_renewal_sessions (grant_id)
            WHERE status = 'pending';
    `);

    selfRoleDb.exec(`
        CREATE TABLE IF NOT EXISTS sr_panels (
            panel_id         TEXT PRIMARY KEY,
            guild_id         TEXT NOT NULL,
            channel_id       TEXT NOT NULL,
            message_id       TEXT NOT NULL,
            panel_type       TEXT NOT NULL,
            is_active        INTEGER DEFAULT 1,
            created_at       INTEGER NOT NULL,
            last_rendered_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_sr_panels_guild_type_active
            ON sr_panels (guild_id, panel_type, is_active);
    `);

    selfRoleDb.exec(`
        CREATE TABLE IF NOT EXISTS sr_system_alerts (
            alert_id       TEXT PRIMARY KEY,
            guild_id       TEXT NOT NULL,
            role_id        TEXT,
            grant_id       TEXT,
            application_id TEXT,
            alert_type     TEXT NOT NULL,
            severity       TEXT NOT NULL,
            message        TEXT NOT NULL,
            action_required TEXT,
            created_at     INTEGER NOT NULL,
            resolved_at    INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_sr_alerts_guild_resolved_at
            ON sr_system_alerts (guild_id, resolved_at);
        CREATE INDEX IF NOT EXISTS idx_sr_alerts_type
            ON sr_system_alerts (alert_type);
    `);

    console.log('[SelfRole] ✅ SQLite 数据库和表结构初始化完成。');
}

// 在模块加载时立即初始化数据库
initializeSelfRoleDatabase();


// 初始化文件
if (!fs.existsSync(SETTINGS_FILE)) {
    fs.writeFileSync(SETTINGS_FILE, '{}', 'utf8');
}
if (!fs.existsSync(MESSAGES_FILE)) {
    fs.writeFileSync(MESSAGES_FILE, '{}', 'utf8');
}
if (!fs.existsSync(CHECK_SETTINGS_FILE)) {
    fs.writeFileSync(CHECK_SETTINGS_FILE, '{}', 'utf8');
}
if (!fs.existsSync(REVIEW_SETTINGS_FILE)) {
    fs.writeFileSync(REVIEW_SETTINGS_FILE, '{}', 'utf8');
}
if (!fs.existsSync(ALLOWED_SERVERS_FILE)) {
    fs.writeFileSync(ALLOWED_SERVERS_FILE, '{}', 'utf8');
}
if (!fs.existsSync(COURT_SETTINGS_FILE)) {
    fs.writeFileSync(COURT_SETTINGS_FILE, '{}', 'utf8');
}
if (!fs.existsSync(COURT_APPLICATIONS_FILE)) {
    fs.writeFileSync(COURT_APPLICATIONS_FILE, '{}', 'utf8');
}
if (!fs.existsSync(COURT_VOTES_FILE)) {
    fs.writeFileSync(COURT_VOTES_FILE, '{}', 'utf8');
}

if (!fs.existsSync(SELF_MODERATION_SETTINGS_FILE)) {
    fs.writeFileSync(SELF_MODERATION_SETTINGS_FILE, '{}', 'utf8');
}
if (!fs.existsSync(SELF_MODERATION_VOTES_FILE)) {
    fs.writeFileSync(SELF_MODERATION_VOTES_FILE, '{}', 'utf8');
}
if (!fs.existsSync(SELF_FILE_UPLOAD_LOGS_FILE)) {
    fs.writeFileSync(SELF_FILE_UPLOAD_LOGS_FILE, '[]', 'utf8');
}
if (!fs.existsSync(ARCHIVE_SETTINGS_FILE)) {
    fs.writeFileSync(ARCHIVE_SETTINGS_FILE, '{}', 'utf8');
}
if (!fs.existsSync(AUTO_CLEANUP_SETTINGS_FILE)) {
    fs.writeFileSync(AUTO_CLEANUP_SETTINGS_FILE, '{}', 'utf8');
}
if (!fs.existsSync(AUTO_CLEANUP_TASKS_FILE)) {
    fs.writeFileSync(AUTO_CLEANUP_TASKS_FILE, '{}', 'utf8');
}
if (!fs.existsSync(SELF_MODERATION_BLACKLIST_FILE)) {
    fs.writeFileSync(SELF_MODERATION_BLACKLIST_FILE, '{}', 'utf8');
}

// --- 自助身份组模块 (SQLite) ---

/**
 * 获取指定服务器的自助身份组设置。
 * @param {string} guildId - 服务器ID。
 * @returns {Promise<object|null>} 服务器的设置对象，不存在则返回 null。
 */
async function getSelfRoleSettings(guildId) {
    const stmt = selfRoleDb.prepare('SELECT roles, last_successful_save FROM role_settings WHERE guild_id = ?');
    const row = stmt.get(guildId);
    if (!row) return null;

    const normalized = normalizeSelfRoleSettings({ roles: safeJsonParse(row.roles, []) });
    return {
        roles: normalized.roles,
        lastSuccessfulSave: row.last_successful_save,
    };
}

/**
 * 保存指定服务器的自助身份组设置。
 * @param {string} guildId - 服务器ID。
 * @param {object} data - 要保存的设置对象。
 * @returns {Promise<object>} 已保存的设置对象。
 */
async function saveSelfRoleSettings(guildId, data) {
    const normalized = normalizeSelfRoleSettings(data || {});
    const stmt = selfRoleDb.prepare(`
        INSERT INTO role_settings (guild_id, roles, last_successful_save)
        VALUES (?, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET
            roles = excluded.roles,
            last_successful_save = excluded.last_successful_save
    `);
    stmt.run(guildId, JSON.stringify(normalized.roles || []), normalized.lastSuccessfulSave || null);
    return normalized;
}

/**
 * 获取所有服务器的自助身份组设置。
 * @returns {Promise<object>} 包含所有服务器设置的对象。
 */
async function getAllSelfRoleSettings() {
    const stmt = selfRoleDb.prepare('SELECT guild_id, roles, last_successful_save FROM role_settings');
    const rows = stmt.all();
    const settings = {};
    for (const row of rows) {
        const normalized = normalizeSelfRoleSettings({ roles: safeJsonParse(row.roles, []) });
        settings[row.guild_id] = {
            roles: normalized.roles,
            lastSuccessfulSave: row.last_successful_save,
        };
    }
    return settings;
}

/**
 * 获取指定服务器的所有用户活跃度数据。
 * @param {string} guildId - 服务器ID。
 * @returns {Promise<object>} 包含所有频道和用户活跃度数据的对象。
 */
async function getUserActivity(guildId) {
    const stmt = selfRoleDb.prepare('SELECT channel_id, user_id, message_count, mentioned_count, mentioning_count FROM user_activity WHERE guild_id = ?');
    const rows = stmt.all(guildId);
    const activity = {};
    for (const row of rows) {
        if (!activity[row.channel_id]) {
            activity[row.channel_id] = {};
        }
        activity[row.channel_id][row.user_id] = {
            messageCount: row.message_count,
            mentionedCount: row.mentioned_count,
            mentioningCount: row.mentioning_count,
        };
    }
    return activity;
}

/**
 * 批量保存多个服务器的用户活跃度数据。
 * 此函数使用单个事务来高效处理来自内存缓存的所有数据。
 * @param {object} batchData - 包含所有待更新服务器活跃度数据的缓存对象。
 * @returns {Promise<object>} 已保存的活跃度数据对象。
 */
async function saveUserActivityBatch(batchData) {
    const stmt = selfRoleDb.prepare(`
        INSERT INTO user_activity (guild_id, channel_id, user_id, message_count, mentioned_count, mentioning_count)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, channel_id, user_id) DO UPDATE SET
            message_count = user_activity.message_count + excluded.message_count,
            mentioned_count = user_activity.mentioned_count + excluded.mentioned_count,
            mentioning_count = user_activity.mentioning_count + excluded.mentioning_count
    `);

    const transaction = selfRoleDb.transaction((guilds) => {
        for (const guildId in guilds) {
            const channels = guilds[guildId];
            for (const channelId in channels) {
                const users = channels[channelId];
                for (const userId in users) {
                    const activity = users[userId];
                    stmt.run(
                        guildId,
                        channelId,
                        userId,
                        activity.messageCount || 0,
                        activity.mentionedCount || 0,
                        activity.mentioningCount || 0
                    );
                }
            }
        }
    });

    try {
        transaction(batchData);
    } catch (err) {
        console.error('[SelfRole] ❌ 批量保存用户活跃度数据到 SQLite 时出错:', err);
        throw err; // 向上抛出异常，以便调用者可以处理
    }
    
    return batchData;
}


/**
 * 批量保存每日用户活跃度数据。
 * @param {object} batchData - 批量数据，格式: { guildId: { channelId: { userId: { messageCount, mentionedCount, mentioningCount } } } }
 * @param {string} date - 日期字符串，格式: YYYY-MM-DD
 * @returns {Promise<object>} 已保存的批量数据。
 */
async function saveDailyUserActivityBatch(batchData, date) {
    const stmt = selfRoleDb.prepare(`
        INSERT INTO daily_user_activity (guild_id, channel_id, user_id, date, message_count, mentioned_count, mentioning_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, channel_id, user_id, date) DO UPDATE SET
            message_count = message_count + excluded.message_count,
            mentioned_count = mentioned_count + excluded.mentioned_count,
            mentioning_count = mentioning_count + excluded.mentioning_count
    `);

    const transaction = selfRoleDb.transaction((guilds, targetDate) => {
        for (const guildId in guilds) {
            const channels = guilds[guildId];
            for (const channelId in channels) {
                const users = channels[channelId];
                for (const userId in users) {
                    const activity = users[userId];
                    stmt.run(
                        guildId,
                        channelId,
                        userId,
                        targetDate,
                        activity.messageCount || 0,
                        activity.mentionedCount || 0,
                        activity.mentioningCount || 0
                    );
                }
            }
        }
    });

    try {
        transaction(batchData, date);
    } catch (err) {
        console.error('[SelfRole] ❌ 批量保存每日用户活跃度数据到 SQLite 时出错:', err);
        throw err;
    }

    return batchData;
}

/**
 * 获取用户在指定频道的每日活跃度数据。
 * @param {string} guildId - 服务器ID。
 * @param {string} channelId - 频道ID。
 * @param {string} userId - 用户ID。
 * @param {number} days - 查询最近多少天的数据（可选，默认30天）。
 * @returns {Promise<Array>} 每日活跃度数据数组。
 */
async function getUserDailyActivity(guildId, channelId, userId, days = 30) {
    const stmt = selfRoleDb.prepare(`
        SELECT date, message_count, mentioned_count, mentioning_count
        FROM daily_user_activity
        WHERE guild_id = ? AND channel_id = ? AND user_id = ?
        ORDER BY date DESC
        LIMIT ?
    `);
    const rows = stmt.all(guildId, channelId, userId, days);
    return rows.map(row => ({
        date: row.date,
        messageCount: row.message_count,
        mentionedCount: row.mentioned_count,
        mentioningCount: row.mentioning_count,
    }));
}

/**
 * 计算用户在指定频道中满足每日发言阈值的天数。
 * @param {string} guildId - 服务器ID。
 * @param {string} channelId - 频道ID。
 * @param {string} userId - 用户ID。
 * @param {number} dailyThreshold - 每日发言数阈值。
 * @param {number} days - 查询最近多少天的数据（可选，默认90天）。
 * @returns {Promise<number>} 满足阈值的天数。
 */
async function getUserActiveDaysCount(guildId, channelId, userId, dailyThreshold, days = 90) {
    // 使用 UTC 时间计算起始日期，确保与数据存储时的日期计算一致
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startDateStr = startDate.toISOString().split('T')[0]; // YYYY-MM-DD 格式（UTC）

    const stmt = selfRoleDb.prepare(`
        SELECT COUNT(*) as active_days
        FROM daily_user_activity
        WHERE guild_id = ? AND channel_id = ? AND user_id = ?
        AND message_count >= ?
        AND date >= ?
    `);
    const row = stmt.get(guildId, channelId, userId, dailyThreshold, startDateStr);
    return row ? row.active_days : 0;
}

/**
 * 根据消息ID获取一个自助身份组的投票申请。
 * @param {string} messageId - 投票面板的消息ID。
 * @returns {Promise<object|null>} 申请对象，如果不存在返回 null。
 */
async function getSelfRoleApplication(messageId) {
    const stmt = selfRoleDb.prepare('SELECT * FROM role_applications WHERE message_id = ?');
    const row = stmt.get(messageId);
    if (!row) return null;
    return {
        messageId: row.message_id,
        applicantId: row.applicant_id,
        roleId: row.role_id,
        status: row.status,
        approvers: JSON.parse(row.approvers || '[]'),
        rejecters: JSON.parse(row.rejecters || '[]'),
        reason: row.reason || null,
        rejectReasons: JSON.parse(row.reject_reasons || '{}'),
    };
}

/**
 * 创建或更新自助身份组的投票申请。
 * @param {string} messageId - 投票面板的消息ID，标识用。
 * @param {object} data - 要保存的申请数据。
 * @returns {Promise<object>} 已保存的申请对象。
 */
async function saveSelfRoleApplication(messageId, data) {
    const stmt = selfRoleDb.prepare(`
        INSERT INTO role_applications (message_id, applicant_id, role_id, status, approvers, rejecters, reason, reject_reasons)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET
            applicant_id = excluded.applicant_id,
            role_id = excluded.role_id,
            status = excluded.status,
            approvers = excluded.approvers,
            rejecters = excluded.rejecters,
            reason = excluded.reason,
            reject_reasons = excluded.reject_reasons
    `);
    stmt.run(
        messageId,
        data.applicantId,
        data.roleId,
        data.status,
        JSON.stringify(data.approvers || []),
        JSON.stringify(data.rejecters || []),
        data.reason || null,
        JSON.stringify(data.rejectReasons || {})
    );
    return data;
}

/**
 * 根据消息ID删除一个已结束的自助身份组投票申请。
 * @param {string} messageId - 投票面板的消息ID。
 * @returns {Promise<void>}
 */
async function deleteSelfRoleApplication(messageId) {
    const stmt = selfRoleDb.prepare('DELETE FROM role_applications WHERE message_id = ?');
    stmt.run(messageId);
}

/**
 * 根据“申请人 + 身份组”查询是否存在待审核申请（用于防止重复创建人工审核面板）
 * @param {string} applicantId - 申请人用户ID
 * @param {string} roleId - 身份组ID
 * @returns {Promise<object|null>} 若存在返回申请对象，否则返回 null
 */
async function getPendingApplicationByApplicantRole(applicantId, roleId) {
    const stmt = selfRoleDb.prepare(`
        SELECT message_id, applicant_id, role_id, status, approvers, rejecters, reason, reject_reasons
        FROM role_applications
        WHERE applicant_id = ? AND role_id = ? AND status = 'pending'
        LIMIT 1
    `);
    const row = stmt.get(applicantId, roleId);
    if (!row) return null;
    return {
        messageId: row.message_id,
        applicantId: row.applicant_id,
        roleId: row.role_id,
        status: row.status,
        approvers: JSON.parse(row.approvers || '[]'),
        rejecters: JSON.parse(row.rejecters || '[]'),
        reason: row.reason || null,
        rejectReasons: JSON.parse(row.reject_reasons || '{}'),
    };
}

/**
 * 设置（或更新）某用户对某身份组的“被拒绝后冷却期”
 * @param {string} guildId - 服务器ID
 * @param {string} roleId - 身份组ID
 * @param {string} userId - 用户ID
 * @param {number} cooldownDays - 冷却天数
 * @returns {Promise<{guildId:string, roleId:string, userId:string, expiresAt:number}>}
 */
async function setSelfRoleCooldown(guildId, roleId, userId, cooldownDays) {
    const safeDays = Math.max(0, parseInt(cooldownDays) || 0);
    const expiresAt = Date.now() + safeDays * 24 * 60 * 60 * 1000;

    const stmt = selfRoleDb.prepare(`
        INSERT INTO role_cooldowns (guild_id, role_id, user_id, expires_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, role_id, user_id) DO UPDATE SET
            expires_at = excluded.expires_at
    `);
    stmt.run(guildId, roleId, userId, expiresAt);

    return { guildId, roleId, userId, expiresAt };
}

/**
 * 获取某用户对某身份组的冷却记录
 * @param {string} guildId - 服务器ID
 * @param {string} roleId - 身份组ID
 * @param {string} userId - 用户ID
 * @returns {Promise<{expiresAt:number}|null>} 若存在返回对象，否则返回 null
 */
async function getSelfRoleCooldown(guildId, roleId, userId) {
    const stmt = selfRoleDb.prepare(`
        SELECT expires_at FROM role_cooldowns
        WHERE guild_id = ? AND role_id = ? AND user_id = ?
        LIMIT 1
    `);
    const row = stmt.get(guildId, roleId, userId);
    if (!row) return null;
    return { expiresAt: row.expires_at };
}

/**
 * 清除某用户对某身份组的冷却记录
 * @param {string} guildId - 服务器ID
 * @param {string} roleId - 身份组ID
 * @param {string} userId - 用户ID
 * @returns {Promise<boolean>} 永远返回 true（若不存在记录也视为已清除）
 */
async function clearSelfRoleCooldown(guildId, roleId, userId) {
    const stmt = selfRoleDb.prepare(`
        DELETE FROM role_cooldowns
        WHERE guild_id = ? AND role_id = ? AND user_id = ?
    `);
    stmt.run(guildId, roleId, userId);
    return true;
}

/**
 * 清空指定服务器和频道的所有用户活跃度数据。
 * @param {string} guildId - 服务器ID。
 * @param {string} channelId - 频道ID。
 * @returns {Promise<void>}
 */
async function clearChannelActivity(guildId, channelId) {
    const transaction = selfRoleDb.transaction((gid, cid) => {
        // 总活跃度
        selfRoleDb
            .prepare('DELETE FROM user_activity WHERE guild_id = ? AND channel_id = ?')
            .run(gid, cid);

        // 每日活跃度（重要：保持与 user_activity 的重置语义一致）
        selfRoleDb
            .prepare('DELETE FROM daily_user_activity WHERE guild_id = ? AND channel_id = ?')
            .run(gid, cid);
    });

    transaction(guildId, channelId);
}

/**
 * 统计 legacy (role_applications) 表中某身份组的待审核数量。
 * 注意：legacy 表没有 guild_id，但 role_id 为全局 snowflake，可作为唯一键使用。
 * @param {string} roleId
 * @returns {Promise<number>}
 */
async function countLegacyPendingSelfRoleApplications(roleId) {
    const stmt = selfRoleDb.prepare(`
        SELECT COUNT(*) as c
        FROM role_applications
        WHERE role_id = ? AND status = 'pending'
    `);
    const row = stmt.get(roleId);
    return row ? row.c : 0;
}

/**
 * 统计 v2 (sr_applications_v2) 表中“待审核且已预留名额”的申请数量。
 * @param {string} guildId
 * @param {string} roleId
 * @param {number} nowMs
 * @returns {Promise<number>}
 */
async function countReservedPendingSelfRoleApplicationsV2(guildId, roleId, nowMs = Date.now()) {
    const stmt = selfRoleDb.prepare(`
        SELECT COUNT(*) as c
        FROM sr_applications_v2
        WHERE guild_id = ?
          AND role_id = ?
          AND status = 'pending'
          AND slot_reserved = 1
          AND (reserved_until IS NULL OR reserved_until > ?)
    `);
    const row = stmt.get(guildId, roleId, nowMs);
    return row ? row.c : 0;
}

/**
 * 获取指定服务器的 active 面板记录。
 * @param {string} guildId
 * @param {'user'|'admin'} panelType
 * @returns {Promise<Array<{panelId:string,guildId:string,channelId:string,messageId:string,panelType:string,isActive:boolean,createdAt:number,lastRenderedAt:number|null}>>}
 */
async function getActiveSelfRolePanels(guildId, panelType) {
    const type = panelType === 'admin' ? 'admin' : 'user';
    const stmt = selfRoleDb.prepare(`
        SELECT panel_id, guild_id, channel_id, message_id, panel_type, is_active, created_at, last_rendered_at
        FROM sr_panels
        WHERE guild_id = ? AND panel_type = ? AND is_active = 1
        ORDER BY created_at DESC
    `);
    const rows = stmt.all(guildId, type);
    return rows.map(r => ({
        panelId: r.panel_id,
        guildId: r.guild_id,
        channelId: r.channel_id,
        messageId: r.message_id,
        panelType: r.panel_type,
        isActive: !!r.is_active,
        createdAt: r.created_at,
        lastRenderedAt: r.last_rendered_at,
    }));
}

/**
 * 将某服务器内某类型的所有 active 面板标记为 inactive。
 * @param {string} guildId
 * @param {'user'|'admin'} panelType
 * @returns {Promise<number>} changes
 */
async function deactivateSelfRolePanels(guildId, panelType) {
    const type = panelType === 'admin' ? 'admin' : 'user';
    const stmt = selfRoleDb.prepare(`
        UPDATE sr_panels
        SET is_active = 0
        WHERE guild_id = ? AND panel_type = ? AND is_active = 1
    `);
    const info = stmt.run(guildId, type);
    return info?.changes || 0;
}

/**
 * 将指定 panel_id 标记为 inactive。
 * @param {string} panelId
 */
async function deactivateSelfRolePanel(panelId) {
    const stmt = selfRoleDb.prepare(`
        UPDATE sr_panels
        SET is_active = 0
        WHERE panel_id = ?
    `);
    const info = stmt.run(panelId);
    return (info?.changes || 0) > 0;
}

/**
 * 注册一个新的面板消息，并将同类型旧面板标记为 inactive。
 * 说明：panel_id 直接使用 messageId，避免额外 ID 生成依赖。
 * @param {string} guildId
 * @param {string} channelId
 * @param {string} messageId
 * @param {'user'|'admin'} panelType
 */
async function registerSelfRolePanelMessage(guildId, channelId, messageId, panelType) {
    const type = panelType === 'admin' ? 'admin' : 'user';
    const now = Date.now();
    const panelId = messageId;

    const tx = selfRoleDb.transaction((gid, cid, mid, pType, ts) => {
        // 先停用同类面板（每个 guild 默认只保留一个 active）
        selfRoleDb
            .prepare('UPDATE sr_panels SET is_active = 0 WHERE guild_id = ? AND panel_type = ? AND is_active = 1')
            .run(gid, pType);

        // 再插入新面板
        selfRoleDb
            .prepare(`
                INSERT OR REPLACE INTO sr_panels
                (panel_id, guild_id, channel_id, message_id, panel_type, is_active, created_at, last_rendered_at)
                VALUES (?, ?, ?, ?, ?, 1, ?, ?)
            `)
            .run(panelId, gid, cid, mid, pType, ts, ts);
    });

    tx(guildId, channelId, messageId, type, now);

    return {
        panelId,
        guildId,
        channelId,
        messageId,
        panelType: type,
        isActive: true,
        createdAt: now,
        lastRenderedAt: now,
    };
}

/**
 * 更新面板的 last_rendered_at。
 * @param {string} panelId
 * @param {number} renderedAt
 * @returns {Promise<boolean>}
 */
async function touchSelfRolePanelRenderedAt(panelId, renderedAt = Date.now()) {
    const stmt = selfRoleDb.prepare(`
        UPDATE sr_panels
        SET last_rendered_at = ?
        WHERE panel_id = ?
    `);
    const info = stmt.run(renderedAt, panelId);
    return (info?.changes || 0) > 0;
}

/**
 * 获取一条 v2 申请记录。
 * @param {string} applicationId
 * @returns {Promise<null|{
 *   applicationId:string,
 *   guildId:string,
 *   applicantId:string,
 *   roleId:string,
 *   status:string,
 *   reason:string|null,
 *   reviewMessageId:string|null,
 *   reviewChannelId:string|null,
 *   slotReserved:boolean,
 *   reservedUntil:number|null,
 *   createdAt:number,
 *   resolvedAt:number|null,
 *   resolutionReason:string|null,
 * }>}
 */
async function getSelfRoleApplicationV2(applicationId) {
    const stmt = selfRoleDb.prepare(`
        SELECT * FROM sr_applications_v2
        WHERE application_id = ?
        LIMIT 1
    `);
    const row = stmt.get(applicationId);
    if (!row) return null;

    return {
        applicationId: row.application_id,
        guildId: row.guild_id,
        applicantId: row.applicant_id,
        roleId: row.role_id,
        status: row.status,
        reason: row.reason || null,
        reviewMessageId: row.review_message_id || null,
        reviewChannelId: row.review_channel_id || null,
        slotReserved: !!row.slot_reserved,
        reservedUntil: row.reserved_until == null ? null : row.reserved_until,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at == null ? null : row.resolved_at,
        resolutionReason: row.resolution_reason || null,
    };
}

/**
 * 通过 review_message_id 查找 v2 申请记录（用于与 legacy 投票面板 message_id 对齐）。
 * @param {string} reviewMessageId
 */
async function getSelfRoleApplicationV2ByReviewMessageId(reviewMessageId) {
    const stmt = selfRoleDb.prepare(`
        SELECT application_id
        FROM sr_applications_v2
        WHERE review_message_id = ?
        ORDER BY created_at DESC
        LIMIT 1
    `);
    const row = stmt.get(reviewMessageId);
    if (!row) return null;
    return getSelfRoleApplicationV2(row.application_id);
}

/**
 * 列出 legacy 表中所有 pending 申请（用于迁移/兼容）。
 * @returns {Promise<Array<{messageId:string, applicantId:string, roleId:string, status:string, reason:string|null}>>}
 */
async function listLegacyPendingSelfRoleApplications() {
    const stmt = selfRoleDb.prepare(`
        SELECT message_id, applicant_id, role_id, status, reason
        FROM role_applications
        WHERE status = 'pending'
        ORDER BY message_id DESC
    `);
    const rows = stmt.all();
    return rows.map(r => ({
        messageId: r.message_id,
        applicantId: r.applicant_id,
        roleId: r.role_id,
        status: r.status,
        reason: r.reason || null,
    }));
}

/**
 * 创建/更新 v2 申请记录（UPSERT）。
 * 注意：本函数不做复杂校验，调用方负责保证业务规则。
 * @param {string} applicationId
 * @param {object} data
 */
async function saveSelfRoleApplicationV2(applicationId, data) {
    const stmt = selfRoleDb.prepare(`
        INSERT INTO sr_applications_v2 (
            application_id,
            guild_id,
            applicant_id,
            role_id,
            status,
            reason,
            review_message_id,
            review_channel_id,
            slot_reserved,
            reserved_until,
            created_at,
            resolved_at,
            resolution_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(application_id) DO UPDATE SET
            guild_id = excluded.guild_id,
            applicant_id = excluded.applicant_id,
            role_id = excluded.role_id,
            status = excluded.status,
            reason = excluded.reason,
            review_message_id = excluded.review_message_id,
            review_channel_id = excluded.review_channel_id,
            slot_reserved = excluded.slot_reserved,
            reserved_until = excluded.reserved_until,
            created_at = excluded.created_at,
            resolved_at = excluded.resolved_at,
            resolution_reason = excluded.resolution_reason
    `);

    stmt.run(
        applicationId,
        data.guildId,
        data.applicantId,
        data.roleId,
        data.status,
        data.reason || null,
        data.reviewMessageId || null,
        data.reviewChannelId || null,
        data.slotReserved ? 1 : 0,
        data.reservedUntil == null ? null : data.reservedUntil,
        data.createdAt,
        data.resolvedAt == null ? null : data.resolvedAt,
        data.resolutionReason || null,
    );

    return {
        applicationId,
        ...data,
    };
}

/**
 * 查询是否存在 pending 的 v2 申请（用于防重复）。
 * @param {string} guildId
 * @param {string} applicantId
 * @param {string} roleId
 */
async function getPendingSelfRoleApplicationV2ByApplicantRole(guildId, applicantId, roleId) {
    const stmt = selfRoleDb.prepare(`
        SELECT application_id
        FROM sr_applications_v2
        WHERE guild_id = ? AND applicant_id = ? AND role_id = ? AND status = 'pending'
        ORDER BY created_at DESC
        LIMIT 1
    `);
    const row = stmt.get(guildId, applicantId, roleId);
    if (!row) return null;
    return getSelfRoleApplicationV2(row.application_id);
}

/**
 * 列出某用户在某服务器的所有 pending v2 申请。
 * @param {string} guildId
 * @param {string} applicantId
 */
async function listPendingSelfRoleApplicationsV2ByApplicant(guildId, applicantId) {
    const stmt = selfRoleDb.prepare(`
        SELECT application_id
        FROM sr_applications_v2
        WHERE guild_id = ? AND applicant_id = ? AND status = 'pending'
        ORDER BY created_at DESC
    `);
    const rows = stmt.all(guildId, applicantId);
    return Promise.all(rows.map(r => getSelfRoleApplicationV2(r.application_id)));
}

/**
 * 终结一条 v2 申请（approved/rejected/withdrawn/expired 等），并释放预留名额。
 * @param {string} applicationId
 * @param {string} status
 * @param {string} resolutionReason
 * @param {number} resolvedAt
 * @returns {Promise<boolean>}
 */
async function resolveSelfRoleApplicationV2(applicationId, status, resolutionReason = null, resolvedAt = Date.now()) {
    const stmt = selfRoleDb.prepare(`
        UPDATE sr_applications_v2
        SET status = ?,
            resolved_at = ?,
            resolution_reason = ?,
            slot_reserved = 0,
            reserved_until = NULL
        WHERE application_id = ?
    `);
    const info = stmt.run(status, resolvedAt, resolutionReason, applicationId);
    return (info?.changes || 0) > 0;
}

/**
 * 扫描并终结所有已过期的 pending 申请（reserved_until <= now）。
 * @param {number} nowMs
 * @returns {Promise<Array<ReturnType<typeof getSelfRoleApplicationV2>>>}
 */
async function expirePendingSelfRoleApplicationsV2(nowMs = Date.now()) {
    const selectStmt = selfRoleDb.prepare(`
        SELECT application_id
        FROM sr_applications_v2
        WHERE status = 'pending'
          AND slot_reserved = 1
          AND reserved_until IS NOT NULL
          AND reserved_until <= ?
        ORDER BY reserved_until ASC
    `);
    const rows = selectStmt.all(nowMs);
    if (!rows || rows.length === 0) return [];

    const appIds = rows.map(r => r.application_id);
    const apps = await Promise.all(appIds.map(id => getSelfRoleApplicationV2(id)));

    const tx = selfRoleDb.transaction((ids, ts) => {
        const updateStmt = selfRoleDb.prepare(`
            UPDATE sr_applications_v2
            SET status = 'expired',
                resolved_at = ?,
                resolution_reason = 'expired',
                slot_reserved = 0,
                reserved_until = NULL
            WHERE application_id = ?
        `);
        for (const id of ids) {
            updateStmt.run(ts, id);
        }
    });
    tx(appIds, nowMs);

    return apps.filter(Boolean);
}

/**
 * 获取 grant 记录
 * @param {string} grantId
 */
async function getSelfRoleGrant(grantId) {
    const stmt = selfRoleDb.prepare(`
        SELECT * FROM sr_grants
        WHERE grant_id = ?
        LIMIT 1
    `);
    const row = stmt.get(grantId);
    if (!row) return null;

    return {
        grantId: row.grant_id,
        guildId: row.guild_id,
        userId: row.user_id,
        primaryRoleId: row.primary_role_id,
        applicationId: row.application_id || null,
        grantedAt: row.granted_at,
        status: row.status,
        nextInquiryAt: row.next_inquiry_at == null ? null : row.next_inquiry_at,
        forceRemoveAt: row.force_remove_at == null ? null : row.force_remove_at,
        lastInquiryAt: row.last_inquiry_at == null ? null : row.last_inquiry_at,
        lastDecision: row.last_decision || null,
        endedAt: row.ended_at == null ? null : row.ended_at,
        endedReason: row.ended_reason || null,
        manualAttentionRequired: !!row.manual_attention_required,
    };
}

/**
 * 获取某用户对某主身份组的 active grant（若存在）。
 */
async function getActiveSelfRoleGrantByUserRole(guildId, userId, primaryRoleId) {
    const stmt = selfRoleDb.prepare(`
        SELECT grant_id
        FROM sr_grants
        WHERE guild_id = ? AND user_id = ? AND primary_role_id = ? AND status = 'active'
        ORDER BY granted_at DESC
        LIMIT 1
    `);
    const row = stmt.get(guildId, userId, primaryRoleId);
    if (!row) return null;
    return getSelfRoleGrant(row.grant_id);
}

/**
 * 结束某用户对某主身份组的所有 active grants（用于避免重复 active grant）。
 */
async function endActiveSelfRoleGrantsForUserRole(guildId, userId, primaryRoleId, endedReason = 'replaced', endedAt = Date.now()) {
    const stmt = selfRoleDb.prepare(`
        UPDATE sr_grants
        SET status = 'ended',
            ended_at = ?,
            ended_reason = ?
        WHERE guild_id = ? AND user_id = ? AND primary_role_id = ? AND status = 'active'
    `);
    const info = stmt.run(endedAt, endedReason, guildId, userId, primaryRoleId);
    return info?.changes || 0;
}

/**
 * 创建一个新的 active grant，并写入关联的角色集合。
 * 说明：为保持“只管理 bot 发放对象”的边界，本表仅记录通过本模块发放的角色。
 * @param {object} params
 * @param {string} params.guildId
 * @param {string} params.userId
 * @param {string} params.primaryRoleId
 * @param {string|null} params.applicationId
 * @param {number} params.grantedAt
 * @param {string[]} params.bundleRoleIds
 */
async function createSelfRoleGrant({
    guildId,
    userId,
    primaryRoleId,
    applicationId = null,
    grantedAt = Date.now(),
    bundleRoleIds = [],
}) {
    const grantId = randomUUID();
    const safeBundle = Array.isArray(bundleRoleIds)
        ? [...new Set(bundleRoleIds.filter(rid => typeof rid === 'string' && rid && rid !== primaryRoleId))]
        : [];

    const tx = selfRoleDb.transaction((data) => {
        // 先结束旧的 active grant（若存在）
        selfRoleDb
            .prepare(`
                UPDATE sr_grants
                SET status = 'ended',
                    ended_at = ?,
                    ended_reason = 'replaced'
                WHERE guild_id = ? AND user_id = ? AND primary_role_id = ? AND status = 'active'
            `)
            .run(data.grantedAt, data.guildId, data.userId, data.primaryRoleId);

        // 再插入新 grant
        selfRoleDb
            .prepare(`
                INSERT INTO sr_grants (
                    grant_id,
                    guild_id,
                    user_id,
                    primary_role_id,
                    application_id,
                    granted_at,
                    status,
                    next_inquiry_at,
                    force_remove_at,
                    last_inquiry_at,
                    last_decision,
                    ended_at,
                    ended_reason,
                    manual_attention_required
                ) VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, NULL, NULL, NULL, NULL, NULL, 0)
            `)
            .run(
                data.grantId,
                data.guildId,
                data.userId,
                data.primaryRoleId,
                data.applicationId,
                data.grantedAt,
            );

        const insertRoleStmt = selfRoleDb.prepare(`
            INSERT OR REPLACE INTO sr_grant_roles (grant_id, role_id, role_kind)
            VALUES (?, ?, ?)
        `);
        insertRoleStmt.run(data.grantId, data.primaryRoleId, 'primary');
        for (const rid of data.safeBundle) {
            insertRoleStmt.run(data.grantId, rid, 'bundle');
        }
    });

    tx({
        grantId,
        guildId,
        userId,
        primaryRoleId,
        applicationId,
        grantedAt,
        safeBundle,
    });

    return {
        grantId,
        guildId,
        userId,
        primaryRoleId,
        applicationId,
        grantedAt,
        status: 'active',
        bundleRoleIds: safeBundle,
    };
}

/**
 * 列出某 grant 关联的角色集合。
 */
async function listSelfRoleGrantRoles(grantId) {
    const stmt = selfRoleDb.prepare(`
        SELECT role_id, role_kind
        FROM sr_grant_roles
        WHERE grant_id = ?
        ORDER BY role_kind ASC
    `);
    const rows = stmt.all(grantId);
    return rows.map(r => ({ roleId: r.role_id, roleKind: r.role_kind }));
}

/**
 * 统计某个身份组当前被“本模块 grant 记录”占用的现任人数（去重到 user 维度）。
 *
 * 口径：仅统计 sr_grants.status='active' 且 sr_grant_roles 包含该 roleId 的记录。
 * 用途：名额上限/空缺/onlyWhenFull 判断。
 * 说明：服务器内非 bot 授予的同身份组成员不占用申请名额。
 *
 * @param {string} guildId
 * @param {string} roleId
 * @returns {Promise<number>}
 */
async function countActiveSelfRoleGrantHoldersByRole(guildId, roleId) {
    if (!guildId || !roleId) return 0;
    const stmt = selfRoleDb.prepare(`
        SELECT COUNT(DISTINCT g.user_id) AS cnt
        FROM sr_grants g
        INNER JOIN sr_grant_roles r ON r.grant_id = g.grant_id
        WHERE g.guild_id = ?
          AND g.status = 'active'
          AND r.role_id = ?
    `);
    const row = stmt.get(guildId, roleId);
    const n = Number(row?.cnt || 0);
    return Number.isFinite(n) ? n : 0;
}

/**
 * 列出所有 active grants
 */
async function listAllActiveSelfRoleGrants() {
    const stmt = selfRoleDb.prepare(`
        SELECT *
        FROM sr_grants
        WHERE status = 'active'
        ORDER BY granted_at ASC
    `);
    const rows = stmt.all();
    return rows.map(row => ({
        grantId: row.grant_id,
        guildId: row.guild_id,
        userId: row.user_id,
        primaryRoleId: row.primary_role_id,
        applicationId: row.application_id || null,
        grantedAt: row.granted_at,
        status: row.status,
        nextInquiryAt: row.next_inquiry_at == null ? null : row.next_inquiry_at,
        forceRemoveAt: row.force_remove_at == null ? null : row.force_remove_at,
        lastInquiryAt: row.last_inquiry_at == null ? null : row.last_inquiry_at,
        lastDecision: row.last_decision || null,
        endedAt: row.ended_at == null ? null : row.ended_at,
        endedReason: row.ended_reason || null,
        manualAttentionRequired: !!row.manual_attention_required,
    }));
}

/**
 * 列出指定时间之后结束的 grants（用于一致性巡检）。
 * @param {number} sinceMs
 * @param {number} limit
 */
async function listEndedSelfRoleGrantsSince(sinceMs, limit = 200) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit || 200)));
    const stmt = selfRoleDb.prepare(`
        SELECT *
        FROM sr_grants
        WHERE status = 'ended'
          AND ended_at IS NOT NULL
          AND ended_at >= ?
        ORDER BY ended_at DESC
        LIMIT ?
    `);
    const rows = stmt.all(sinceMs, safeLimit);
    return rows.map(row => ({
        grantId: row.grant_id,
        guildId: row.guild_id,
        userId: row.user_id,
        primaryRoleId: row.primary_role_id,
        applicationId: row.application_id || null,
        grantedAt: row.granted_at,
        status: row.status,
        nextInquiryAt: row.next_inquiry_at == null ? null : row.next_inquiry_at,
        forceRemoveAt: row.force_remove_at == null ? null : row.force_remove_at,
        lastInquiryAt: row.last_inquiry_at == null ? null : row.last_inquiry_at,
        lastDecision: row.last_decision || null,
        endedAt: row.ended_at == null ? null : row.ended_at,
        endedReason: row.ended_reason || null,
        manualAttentionRequired: !!row.manual_attention_required,
    }));
}

/**
 * 更新 grant 的调度字段（next_inquiry_at/force_remove_at）
 */
async function updateSelfRoleGrantSchedule(grantId, { nextInquiryAt = null, forceRemoveAt = null }) {
    const stmt = selfRoleDb.prepare(`
        UPDATE sr_grants
        SET next_inquiry_at = ?,
            force_remove_at = ?
        WHERE grant_id = ?
    `);
    const info = stmt.run(nextInquiryAt, forceRemoveAt, grantId);
    return (info?.changes || 0) > 0;
}

/**
 * 更新 grant 的询问相关字段
 */
async function updateSelfRoleGrantInquiry(grantId, { lastInquiryAt = null, nextInquiryAt = null }) {
    const stmt = selfRoleDb.prepare(`
        UPDATE sr_grants
        SET last_inquiry_at = ?,
            next_inquiry_at = ?
        WHERE grant_id = ?
    `);
    const info = stmt.run(lastInquiryAt, nextInquiryAt, grantId);
    return (info?.changes || 0) > 0;
}

/**
 * 写入 grant 的最后决定（stay/leave 等）
 */
async function updateSelfRoleGrantLastDecision(grantId, lastDecision) {
    const stmt = selfRoleDb.prepare(`
        UPDATE sr_grants
        SET last_decision = ?
        WHERE grant_id = ?
    `);
    const info = stmt.run(lastDecision, grantId);
    return (info?.changes || 0) > 0;
}

/**
 * 结束 grant
 */
async function endSelfRoleGrant(grantId, endedReason = 'ended', endedAt = Date.now()) {
    const stmt = selfRoleDb.prepare(`
        UPDATE sr_grants
        SET status = 'ended',
            ended_at = ?,
            ended_reason = ?
        WHERE grant_id = ?
    `);
    const info = stmt.run(endedAt, endedReason, grantId);
    return (info?.changes || 0) > 0;
}

/**
 * 获取 renewal session
 */
async function getSelfRoleRenewalSession(sessionId) {
    const stmt = selfRoleDb.prepare(`
        SELECT *
        FROM sr_renewal_sessions
        WHERE session_id = ?
        LIMIT 1
    `);
    const row = stmt.get(sessionId);
    if (!row) return null;
    return {
        sessionId: row.session_id,
        grantId: row.grant_id,
        cycleNo: row.cycle_no,
        status: row.status,
        dmMessageId: row.dm_message_id || null,
        askedAt: row.asked_at == null ? null : row.asked_at,
        respondedAt: row.responded_at == null ? null : row.responded_at,
        decision: row.decision || null,
        reportMessageId: row.report_message_id || null,
        requiresAdminFollowup: !!row.requires_admin_followup,
    };
}

/**
 * 获取某 grant 最新的 pending renewal session（若存在）。
 */
async function getPendingSelfRoleRenewalSessionByGrant(grantId) {
    const stmt = selfRoleDb.prepare(`
        SELECT session_id
        FROM sr_renewal_sessions
        WHERE grant_id = ? AND status = 'pending'
        ORDER BY asked_at DESC
        LIMIT 1
    `);
    const row = stmt.get(grantId);
    if (!row) return null;
    return getSelfRoleRenewalSession(row.session_id);
}

/**
 * 创建 renewal session（cycle_no 自动递增）
 */
async function createSelfRoleRenewalSession({ grantId, status = 'pending', dmMessageId = null, askedAt = Date.now(), reportMessageId = null, requiresAdminFollowup = false }) {
    const sessionId = randomUUID();

    const tx = selfRoleDb.transaction((data) => {
        const cycleRow = selfRoleDb
            .prepare('SELECT IFNULL(MAX(cycle_no), 0) as c FROM sr_renewal_sessions WHERE grant_id = ?')
            .get(data.grantId);
        const nextCycle = (cycleRow?.c || 0) + 1;

        selfRoleDb
            .prepare(`
                INSERT INTO sr_renewal_sessions (
                    session_id,
                    grant_id,
                    cycle_no,
                    status,
                    dm_message_id,
                    asked_at,
                    responded_at,
                    decision,
                    report_message_id,
                    requires_admin_followup
                ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
            `)
            .run(
                data.sessionId,
                data.grantId,
                nextCycle,
                data.status,
                data.dmMessageId,
                data.askedAt,
                data.reportMessageId,
                data.requiresAdminFollowup ? 1 : 0,
            );

        return nextCycle;
    });

    const cycleNo = tx({ sessionId, grantId, status, dmMessageId, askedAt, reportMessageId, requiresAdminFollowup });
    return getSelfRoleRenewalSession(sessionId);
}

/**
 * 更新 renewal session
 */
async function updateSelfRoleRenewalSession(
    sessionId,
    {
        status,
        dmMessageId,
        respondedAt,
        decision,
        reportMessageId,
        requiresAdminFollowup,
    } = {},
) {
    const current = await getSelfRoleRenewalSession(sessionId);
    if (!current) return false;

    const nextStatus = status === undefined ? current.status : status;
    const nextDmMessageId = dmMessageId === undefined ? current.dmMessageId : dmMessageId;
    const nextRespondedAt = respondedAt === undefined ? current.respondedAt : respondedAt;
    const nextDecision = decision === undefined ? current.decision : decision;
    const nextReportMessageId = reportMessageId === undefined ? current.reportMessageId : reportMessageId;
    const nextRequires = requiresAdminFollowup === undefined ? current.requiresAdminFollowup : requiresAdminFollowup;

    const stmt = selfRoleDb.prepare(`
        UPDATE sr_renewal_sessions
        SET status = ?,
            dm_message_id = ?,
            responded_at = ?,
            decision = ?,
            report_message_id = ?,
            requires_admin_followup = ?
        WHERE session_id = ?
    `);
    const info = stmt.run(
        nextStatus,
        nextDmMessageId,
        nextRespondedAt,
        nextDecision,
        nextReportMessageId,
        nextRequires ? 1 : 0,
        sessionId,
    );
    return (info?.changes || 0) > 0;
}

/**
 * 将某 grant 标记为需要管理员介入（manual_attention_required）。
 * @param {string} grantId
 * @param {boolean} required
 */
async function setSelfRoleGrantManualAttentionRequired(grantId, required = true) {
    const stmt = selfRoleDb.prepare(`
        UPDATE sr_grants
        SET manual_attention_required = ?
        WHERE grant_id = ?
    `);
    const info = stmt.run(required ? 1 : 0, grantId);
    return (info?.changes || 0) > 0;
}

/**
 * 创建一条 SelfRole 系统告警（sr_system_alerts）。
 */
async function createSelfRoleSystemAlert({
    guildId,
    roleId = null,
    grantId = null,
    applicationId = null,
    alertType,
    severity = 'medium',
    message,
    actionRequired = null,
    createdAt = Date.now(),
}) {
    const alertId = randomUUID();

    const stmt = selfRoleDb.prepare(`
        INSERT INTO sr_system_alerts (
            alert_id,
            guild_id,
            role_id,
            grant_id,
            application_id,
            alert_type,
            severity,
            message,
            action_required,
            created_at,
            resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `);

    stmt.run(
        alertId,
        guildId,
        roleId,
        grantId,
        applicationId,
        alertType,
        severity,
        String(message || ''),
        actionRequired ? String(actionRequired) : null,
        createdAt,
    );

    return {
        alertId,
        guildId,
        roleId,
        grantId,
        applicationId,
        alertType,
        severity,
        message: String(message || ''),
        actionRequired: actionRequired ? String(actionRequired) : null,
        createdAt,
        resolvedAt: null,
    };
}

/**
 * 列出某服务器未解决的 SelfRole 告警。
 */
async function listActiveSelfRoleSystemAlerts(guildId, limit = 50) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit || 50)));
    const stmt = selfRoleDb.prepare(`
        SELECT *
        FROM sr_system_alerts
        WHERE guild_id = ? AND resolved_at IS NULL
        ORDER BY created_at DESC
        LIMIT ?
    `);
    const rows = stmt.all(guildId, safeLimit);
    return rows.map(r => ({
        alertId: r.alert_id,
        guildId: r.guild_id,
        roleId: r.role_id || null,
        grantId: r.grant_id || null,
        applicationId: r.application_id || null,
        alertType: r.alert_type,
        severity: r.severity,
        message: r.message,
        actionRequired: r.action_required || null,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
    }));
}

/**
 * 获取一条 SelfRole 告警
 */
async function getSelfRoleSystemAlert(alertId) {
    const stmt = selfRoleDb.prepare(`
        SELECT *
        FROM sr_system_alerts
        WHERE alert_id = ?
        LIMIT 1
    `);
    const r = stmt.get(alertId);
    if (!r) return null;
    return {
        alertId: r.alert_id,
        guildId: r.guild_id,
        roleId: r.role_id || null,
        grantId: r.grant_id || null,
        applicationId: r.application_id || null,
        alertType: r.alert_type,
        severity: r.severity,
        message: r.message,
        actionRequired: r.action_required || null,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
    };
}

/**
 * 统计某 grant 未解决告警数量。
 */
async function countActiveSelfRoleSystemAlertsByGrant(grantId) {
    const stmt = selfRoleDb.prepare(`
        SELECT COUNT(*) as c
        FROM sr_system_alerts
        WHERE grant_id = ? AND resolved_at IS NULL
    `);
    const row = stmt.get(grantId);
    return row ? row.c : 0;
}

/**
 * 查询某 grant + alertType 是否已存在未解决告警（用于去重）。
 */
async function getActiveSelfRoleSystemAlertByGrantType(grantId, alertType) {
    const stmt = selfRoleDb.prepare(`
        SELECT alert_id
        FROM sr_system_alerts
        WHERE grant_id = ?
          AND alert_type = ?
          AND resolved_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
    `);
    const row = stmt.get(grantId, alertType);
    if (!row) return null;
    return getSelfRoleSystemAlert(row.alert_id);
}

/**
 * 查询某 application + alertType 是否已存在未解决告警（用于去重）。
 * @param {string|null} applicationId
 * @param {string} alertType
 */
async function getActiveSelfRoleSystemAlertByApplicationType(applicationId, alertType) {
    if (!applicationId) return null;
    const stmt = selfRoleDb.prepare(`
        SELECT alert_id
        FROM sr_system_alerts
        WHERE application_id = ?
          AND alert_type = ?
          AND resolved_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
    `);
    const row = stmt.get(applicationId, alertType);
    if (!row) return null;
    return getSelfRoleSystemAlert(row.alert_id);
}

/**
 * 解决一条 SelfRole 告警。
 */
async function resolveSelfRoleSystemAlert(alertId, resolvedAt = Date.now()) {
    const stmt = selfRoleDb.prepare(`
        UPDATE sr_system_alerts
        SET resolved_at = ?
        WHERE alert_id = ?
    `);
    const info = stmt.run(resolvedAt, alertId);
    return (info?.changes || 0) > 0;
}


// --- 其他模块 (JSON) ---

// 读取设置数据
function readSettings() {
    try {
        const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('读取设置文件失败:', err);
        return {};
    }
}

// 写入设置数据
function writeSettings(data) {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('写入设置文件失败:', err);
    }
}

// 读取消息数据
function readMessages() {
    try {
        const data = fs.readFileSync(MESSAGES_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('读取消息文件失败:', err);
        return {};
    }
}

// 写入消息数据
function writeMessages(data) {
    try {
        fs.writeFileSync(MESSAGES_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('写入消息文件失败:', err);
    }
}

// 读取检查设置数据
function readCheckSettings() {
    try {
        const data = fs.readFileSync(CHECK_SETTINGS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('读取检查设置文件失败:', err);
        return {};
    }
}

// 写入检查设置数据
function writeCheckSettings(data) {
    try {
        fs.writeFileSync(CHECK_SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('写入检查设置文件失败:', err);
    }
}

// 保存表单权限设置
async function saveFormPermissionSettings(guildId, permissionSettings) {
    const settings = readSettings();
    if (!settings[guildId]) {
        settings[guildId] = {};
    }
    settings[guildId].formPermissions = permissionSettings;
    writeSettings(settings);
    console.log(`成功保存表单权限设置 - guildId: ${guildId}`, permissionSettings);
    return permissionSettings;
}

// 获取表单权限设置
async function getFormPermissionSettings(guildId) {
    const settings = readSettings();
    const result = settings[guildId]?.formPermissions;
    console.log(`获取表单权限设置 - guildId: ${guildId}`, result);
    return result;
}

// 保存支持按钮权限设置
async function saveSupportPermissionSettings(guildId, permissionSettings) {
    const settings = readSettings();
    if (!settings[guildId]) {
        settings[guildId] = {};
    }
    settings[guildId].supportPermissions = permissionSettings;
    writeSettings(settings);
    console.log(`成功保存支持按钮权限设置 - guildId: ${guildId}`, permissionSettings);
    return permissionSettings;
}

// 获取支持按钮权限设置
async function getSupportPermissionSettings(guildId) {
    const settings = readSettings();
    const result = settings[guildId]?.supportPermissions;
    console.log(`获取支持按钮权限设置 - guildId: ${guildId}`, result);
    return result;
}

// 读取审核设置数据
function readReviewSettings() {
    try {
        const data = fs.readFileSync(REVIEW_SETTINGS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('读取审核设置文件失败:', err);
        return {};
    }
}

// 写入审核设置数据
function writeReviewSettings(data) {
    try {
        fs.writeFileSync(REVIEW_SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('写入审核设置文件失败:', err);
    }
}

// 读取允许服务器数据
function readAllowedServers() {
    try {
        const data = fs.readFileSync(ALLOWED_SERVERS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('读取允许服务器文件失败:', err);
        return {};
    }
}

// 写入允许服务器数据
function writeAllowedServers(data) {
    try {
        fs.writeFileSync(ALLOWED_SERVERS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('写入允许服务器文件失败:', err);
    }
}

// 获取下一个提案ID
function getNextId() {
    try {
        const messages = readMessages();
        
        // 从现有消息中找出最大ID
        let maxId = 0;
        for (const messageId in messages) {
            const message = messages[messageId];
            if (message.proposalId && !isNaN(parseInt(message.proposalId))) {
                const proposalId = parseInt(message.proposalId);
                if (proposalId > maxId) {
                    maxId = proposalId;
                }
            }
        }
        
        // 返回最大ID+1，或者1（如果没有现存消息）
        return maxId > 0 ? maxId + 1 : 1;
    } catch (err) {
        console.error('获取下一个ID失败:', err);
        return 1; // 默认从1开始
    }
}

// 保存设置
async function saveSettings(guildId, settingsData) {
    const settings = readSettings();
    settings[guildId] = settingsData;
    writeSettings(settings);
    console.log(`成功保存设置 - guildId: ${guildId}`, settingsData);
    return settingsData;
}

// 获取设置
async function getSettings(guildId) {
    const settings = readSettings();
    const result = settings[guildId];
    console.log(`获取设置 - guildId: ${guildId}`, result);
    return result;
}

// 保存消息
async function saveMessage(messageData) {
    const messages = readMessages();
    messages[messageData.messageId] = messageData;
    writeMessages(messages);
    console.log(`成功保存消息 - messageId: ${messageData.messageId}`);
    return messageData;
}

// 获取消息
async function getMessage(messageId) {
    const messages = readMessages();
    return messages[messageId];
}

// 更新消息
async function updateMessage(messageId, updates) {
    const messages = readMessages();
    const message = messages[messageId];
    if (message) {
        const updated = { ...message, ...updates };
        messages[messageId] = updated;
        writeMessages(messages);
        return updated;
    }
    return null;
}

// 获取所有消息
async function getAllMessages() {
    return readMessages();
}

// 保存检查频道设置
async function saveCheckChannelSettings(guildId, checkSettings) {
    const settings = readCheckSettings();
    settings[guildId] = checkSettings;
    writeCheckSettings(settings);
    console.log(`成功保存检查设置 - guildId: ${guildId}`, checkSettings);
    return checkSettings;
}

// 获取检查频道设置
async function getCheckChannelSettings(guildId) {
    const settings = readCheckSettings();
    const result = settings[guildId];
    console.log(`获取检查设置 - guildId: ${guildId}`, result);
    return result;
}

// 获取所有检查频道设置
async function getAllCheckChannelSettings() {
    return readCheckSettings();
}

// 保存审核设置
async function saveReviewSettings(guildId, reviewSettings) {
    const settings = readReviewSettings();
    settings[guildId] = reviewSettings;
    writeReviewSettings(settings);
    console.log(`成功保存审核设置 - guildId: ${guildId}`, reviewSettings);
    return reviewSettings;
}

// 获取审核设置
async function getReviewSettings(guildId) {
    const settings = readReviewSettings();
    const result = settings[guildId];
    console.log(`获取审核设置 - guildId: ${guildId}`, result);
    return result;
}

// 获取服务器的允许服务器列表
async function getAllowedServers(guildId) {
    const servers = readAllowedServers();
    if (!servers[guildId]) {
        return [];
    }
    // 返回服务器ID列表
    const result = Object.keys(servers[guildId]);
    console.log(`获取允许服务器列表 - guildId: ${guildId}`, result);
    return result;
}

// 添加允许的服务器
async function addAllowedServer(guildId, targetGuildId) {
    const servers = readAllowedServers();
    if (!servers[guildId]) {
        servers[guildId] = {};
    }
    
    if (!servers[guildId][targetGuildId]) {
        servers[guildId][targetGuildId] = {
            allowedForums: []
        };
        writeAllowedServers(servers);
        console.log(`成功添加允许服务器 - guildId: ${guildId}, targetGuildId: ${targetGuildId}`);
        return true;
    }
    
    console.log(`服务器已存在于允许列表中 - guildId: ${guildId}, targetGuildId: ${targetGuildId}`);
    return false;
}

// 移除允许的服务器
async function removeAllowedServer(guildId, targetGuildId) {
    const servers = readAllowedServers();
    if (!servers[guildId] || !servers[guildId][targetGuildId]) {
        return false;
    }
    
    delete servers[guildId][targetGuildId];
    writeAllowedServers(servers);
    console.log(`成功移除允许服务器 - guildId: ${guildId}, targetGuildId: ${targetGuildId}`);
    return true;
}

// 检查服务器是否在允许列表中
async function isServerAllowed(guildId, targetGuildId) {
    const servers = readAllowedServers();
    const allowed = !!(servers[guildId] && servers[guildId][targetGuildId]);
    console.log(`检查服务器是否允许 - guildId: ${guildId}, targetGuildId: ${targetGuildId}, allowed: ${allowed}`);
    return allowed;
}

// 获取服务器的允许论坛频道列表
async function getAllowedForums(guildId, targetServerId) {
    const servers = readAllowedServers();
    if (!servers[guildId] || !servers[guildId][targetServerId]) {
        return [];
    }
    const result = servers[guildId][targetServerId].allowedForums || [];
    console.log(`获取允许论坛列表 - guildId: ${guildId}, targetServerId: ${targetServerId}`, result);
    return result;
}

// 添加允许的论坛频道
async function addAllowedForum(guildId, targetServerId, forumChannelId) {
    const servers = readAllowedServers();
    
    // 确保数据结构存在
    if (!servers[guildId]) {
        servers[guildId] = {};
    }
    if (!servers[guildId][targetServerId]) {
        servers[guildId][targetServerId] = { allowedForums: [] };
    }
    if (!servers[guildId][targetServerId].allowedForums) {
        servers[guildId][targetServerId].allowedForums = [];
    }
    
    // 检查是否已存在
    if (!servers[guildId][targetServerId].allowedForums.includes(forumChannelId)) {
        servers[guildId][targetServerId].allowedForums.push(forumChannelId);
        writeAllowedServers(servers);
        console.log(`成功添加允许论坛 - guildId: ${guildId}, targetServerId: ${targetServerId}, forumId: ${forumChannelId}`);
        return true;
    }
    
    console.log(`论坛已存在于允许列表中 - guildId: ${guildId}, targetServerId: ${targetServerId}, forumId: ${forumChannelId}`);
    return false;
}

// 移除允许的论坛频道
async function removeAllowedForum(guildId, targetServerId, forumChannelId) {
    const servers = readAllowedServers();
    
    if (!servers[guildId] || !servers[guildId][targetServerId] || !servers[guildId][targetServerId].allowedForums) {
        return false;
    }
    
    const index = servers[guildId][targetServerId].allowedForums.indexOf(forumChannelId);
    if (index > -1) {
        servers[guildId][targetServerId].allowedForums.splice(index, 1);
        writeAllowedServers(servers);
        console.log(`成功移除允许论坛 - guildId: ${guildId}, targetServerId: ${targetServerId}, forumId: ${forumChannelId}`);
        return true;
    }
    
    console.log(`论坛不在允许列表中 - guildId: ${guildId}, targetServerId: ${targetServerId}, forumId: ${forumChannelId}`);
    return false;
}

// 检查论坛频道是否在允许列表中
async function isForumAllowed(guildId, targetServerId, forumChannelId) {
    const allowedForums = await getAllowedForums(guildId, targetServerId);
    const allowed = allowedForums.includes(forumChannelId);
    console.log(`检查论坛是否允许 - guildId: ${guildId}, targetServerId: ${targetServerId}, forumId: ${forumChannelId}, allowed: ${allowed}`);
    return allowed;
}

// 获取服务器的详细白名单信息（包括论坛）
async function getServerWhitelistDetails(guildId, targetServerId) {
    const servers = readAllowedServers();
    if (!servers[guildId] || !servers[guildId][targetServerId]) {
        return { allowed: false, allowedForums: [] };
    }
    
    return {
        allowed: true,
        allowedForums: servers[guildId][targetServerId].allowedForums || []
    };
}

// 法庭设置相关函数
function readCourtSettings() {
    try {
        const data = fs.readFileSync(COURT_SETTINGS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('读取法庭设置文件失败:', err);
        return {};
    }
}

function writeCourtSettings(data) {
    try {
        fs.writeFileSync(COURT_SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('写入法庭设置文件失败:', err);
    }
}

// 法庭申请相关函数
function readCourtApplications() {
    try {
        const data = fs.readFileSync(COURT_APPLICATIONS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('读取法庭申请文件失败:', err);
        return {};
    }
}

function writeCourtApplications(data) {
    try {
        fs.writeFileSync(COURT_APPLICATIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('写入法庭申请文件失败:', err);
    }
}

// 法庭投票相关函数
function readCourtVotes() {
    try {
        const data = fs.readFileSync(COURT_VOTES_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('读取法庭投票文件失败:', err);
        return {};
    }
}

function writeCourtVotes(data) {
    try {
        fs.writeFileSync(COURT_VOTES_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('写入法庭投票文件失败:', err);
    }
}

// 保存法庭设置
async function saveCourtSettings(guildId, courtSettings) {
    const settings = readCourtSettings();
    settings[guildId] = courtSettings;
    writeCourtSettings(settings);
    console.log(`成功保存法庭设置 - guildId: ${guildId}`, courtSettings);
    return courtSettings;
}

// 获取法庭设置
async function getCourtSettings(guildId) {
    const settings = readCourtSettings();
    const result = settings[guildId];
    console.log(`获取法庭设置 - guildId: ${guildId}`, result);
    return result;
}

// 获取下一个法庭申请ID
function getNextCourtId() {
    try {
        const applications = readCourtApplications();
        
        let maxId = 0;
        for (const applicationId in applications) {
            const application = applications[applicationId];
            if (application.courtId && !isNaN(parseInt(application.courtId))) {
                const courtId = parseInt(application.courtId);
                if (courtId > maxId) {
                    maxId = courtId;
                }
            }
        }
        
        return maxId > 0 ? maxId + 1 : 1;
    } catch (err) {
        console.error('获取下一个法庭ID失败:', err);
        return 1;
    }
}

// 保存法庭申请
async function saveCourtApplication(applicationData) {
    const applications = readCourtApplications();
    applications[applicationData.messageId] = applicationData;
    writeCourtApplications(applications);
    console.log(`成功保存法庭申请 - messageId: ${applicationData.messageId}`);
    return applicationData;
}

// 获取法庭申请
async function getCourtApplication(messageId) {
    const applications = readCourtApplications();
    return applications[messageId];
}

// 更新法庭申请
async function updateCourtApplication(messageId, updates) {
    const applications = readCourtApplications();
    const application = applications[messageId];
    if (application) {
        const updated = { ...application, ...updates };
        applications[messageId] = updated;
        writeCourtApplications(applications);
        return updated;
    }
    return null;
}

// 获取所有法庭申请
async function getAllCourtApplications() {
    return readCourtApplications();
}

// 保存法庭投票
async function saveCourtVote(voteData) {
    const votes = readCourtVotes();
    votes[voteData.threadId] = voteData;
    writeCourtVotes(votes);
    console.log(`成功保存法庭投票 - threadId: ${voteData.threadId}`);
    return voteData;
}

// 获取法庭投票
async function getCourtVote(threadId) {
    const votes = readCourtVotes();
    return votes[threadId];
}

// 更新法庭投票
async function updateCourtVote(threadId, updates) {
    const votes = readCourtVotes();
    const vote = votes[threadId];
    if (vote) {
        const updated = { ...vote, ...updates };
        votes[threadId] = updated;
        writeCourtVotes(votes);
        return updated;
    }
    return null;
}

// 获取所有法庭投票
async function getAllCourtVotes() {
    return readCourtVotes();
}

// 自助管理设置相关函数
function readSelfModerationSettings() {
    try {
        const data = fs.readFileSync(SELF_MODERATION_SETTINGS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('读取自助管理设置文件失败:', err);
        return {};
    }
}

function writeSelfModerationSettings(data) {
    try {
        fs.writeFileSync(SELF_MODERATION_SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('写入自助管理设置文件失败:', err);
    }
}

// 自助管理投票相关函数
function readSelfModerationVotes() {
    try {
        const data = fs.readFileSync(SELF_MODERATION_VOTES_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('读取自助管理投票文件失败:', err);
        return {};
    }
}

function writeSelfModerationVotes(data) {
    try {
        fs.writeFileSync(SELF_MODERATION_VOTES_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('写入自助管理投票文件失败:', err);
    }
}

// 保存自助管理设置
async function saveSelfModerationSettings(guildId, settings) {
    const allSettings = readSelfModerationSettings();
    allSettings[guildId] = settings;
    writeSelfModerationSettings(allSettings);
    console.log(`成功保存自助管理设置 - guildId: ${guildId}`, settings);
    return settings;
}

// 获取自助管理设置
async function getSelfModerationSettings(guildId) {
    const allSettings = readSelfModerationSettings();
    const result = allSettings[guildId];
    console.log(`获取自助管理设置 - guildId: ${guildId}`, result);
    return result;
}

// 保存自助管理投票
async function saveSelfModerationVote(voteData) {
    const votes = readSelfModerationVotes();
    const voteKey = `${voteData.guildId}_${voteData.targetMessageId}_${voteData.type}`;
    votes[voteKey] = voteData;
    writeSelfModerationVotes(votes);
    console.log(`成功保存自助管理投票 - voteKey: ${voteKey}`);
    return voteData;
}

// 获取自助管理投票
async function getSelfModerationVote(guildId, targetMessageId, type) {
    const votes = readSelfModerationVotes();
    const voteKey = `${guildId}_${targetMessageId}_${type}`;
    return votes[voteKey];
}

// 更新自助管理投票
async function updateSelfModerationVote(guildId, targetMessageId, type, updates) {
    const votes = readSelfModerationVotes();
    const voteKey = `${guildId}_${targetMessageId}_${type}`;
    const vote = votes[voteKey];
    if (vote) {
        const updated = { ...vote, ...updates };
        votes[voteKey] = updated;
        writeSelfModerationVotes(votes);
        return updated;
    }
    return null;
}

// 获取所有自助管理投票
async function getAllSelfModerationVotes() {
    return readSelfModerationVotes();
}

// 删除自助管理投票
async function deleteSelfModerationVote(guildId, targetMessageId, type) {
    const votes = readSelfModerationVotes();
    const voteKey = `${guildId}_${targetMessageId}_${type}`;
    if (votes[voteKey]) {
        delete votes[voteKey];
        writeSelfModerationVotes(votes);
        console.log(`成功删除自助管理投票 - voteKey: ${voteKey}`);
        return true;
    }
    return false;
}

// 保存服务器的全局冷却时间设置
async function saveSelfModerationGlobalCooldown(guildId, type, cooldownMinutes) {
    const settings = readSelfModerationSettings();
    if (!settings[guildId]) {
        settings[guildId] = {
            guildId,
            deleteRoles: [],
            muteRoles: [],
            allowedChannels: []
        };
    }
    
    if (type === 'delete') {
        settings[guildId].deleteCooldownMinutes = cooldownMinutes;
    } else if (type === 'mute') {
        settings[guildId].muteCooldownMinutes = cooldownMinutes;
    }
    
    settings[guildId].updatedAt = new Date().toISOString();
    writeSelfModerationSettings(settings);
    
    console.log(`成功保存全局冷却时间 - 服务器: ${guildId}, 类型: ${type}, 冷却: ${cooldownMinutes}分钟`);
    return settings[guildId];
}

// 获取服务器的全局冷却时间设置
async function getSelfModerationGlobalCooldown(guildId, type) {
    const settings = readSelfModerationSettings();
    if (!settings[guildId]) {
        return 0; // 默认无冷却
    }
    
    if (type === 'delete') {
        return settings[guildId].deleteCooldownMinutes || 0;
    } else if (type === 'mute') {
        return settings[guildId].muteCooldownMinutes || 0;
    }
    
    return 0;
}

// 保存用户最后使用时间（简化版）
async function updateUserLastUsage(guildId, userId, type) {
    const votes = readSelfModerationVotes();
    const usageKey = `usage_${guildId}_${userId}_${type}`;
    
    votes[usageKey] = {
        guildId,
        userId,
        type,
        lastUsed: new Date().toISOString()
    };
    
    writeSelfModerationVotes(votes);
    return votes[usageKey];
}

// 获取用户最后使用时间
async function getUserLastUsage(guildId, userId, type) {
    const votes = readSelfModerationVotes();
    const usageKey = `usage_${guildId}_${userId}_${type}`;
    return votes[usageKey];
}

// 检查用户是否在冷却期内（基于全局设置）
async function checkUserGlobalCooldown(guildId, userId, type) {
    // 获取全局冷却设置
    const globalCooldownMinutes = await getSelfModerationGlobalCooldown(guildId, type);
    
    if (globalCooldownMinutes <= 0) {
        return { inCooldown: false, remainingMinutes: 0, cooldownMinutes: 0 };
    }
    
    // 获取用户最后使用时间
    const usageData = await getUserLastUsage(guildId, userId, type);
    
    if (!usageData || !usageData.lastUsed) {
        return { inCooldown: false, remainingMinutes: 0, cooldownMinutes: globalCooldownMinutes };
    }
    
    const lastUsed = new Date(usageData.lastUsed);
    const now = new Date();
    const elapsedMinutes = Math.floor((now - lastUsed) / (1000 * 60));
    const remainingMinutes = Math.max(0, globalCooldownMinutes - elapsedMinutes);
    
    return {
        inCooldown: remainingMinutes > 0,
        remainingMinutes,
        cooldownMinutes: globalCooldownMinutes
    };
}

// 保存消息时间限制设置
async function saveMessageTimeLimit(guildId, limitHours) {
    const settings = readSelfModerationSettings();
    if (!settings[guildId]) {
        settings[guildId] = {};
    }
    
    settings[guildId].messageTimeLimitHours = limitHours;
    settings[guildId].updatedAt = new Date().toISOString();
    
    writeSelfModerationSettings(settings);
    console.log(`成功保存消息时间限制 - 服务器: ${guildId}, 限制: ${limitHours}小时`);
}

// 获取消息时间限制设置
async function getMessageTimeLimit(guildId) {
    const settings = readSelfModerationSettings();
    if (settings[guildId] && settings[guildId].messageTimeLimitHours !== undefined) {
        return settings[guildId].messageTimeLimitHours;
    }
    return null; // 没有限制
}

// 检查消息是否在时间限制内
async function checkMessageTimeLimit(guildId, messageTimestamp) {
    const limitHours = await getMessageTimeLimit(guildId);
    
    if (limitHours === null || limitHours <= 0) {
        return { withinLimit: true, limitHours: null };
    }
    
    const messageTime = new Date(messageTimestamp);
    const now = new Date();
    const elapsedHours = (now - messageTime) / (1000 * 60 * 60);
    
    return {
        withinLimit: elapsedHours <= limitHours,
        limitHours,
        elapsedHours: Math.floor(elapsedHours)
    };
}

// 添加读取和写入归档设置的基础函数
function readArchiveSettings() {
    try {
        const data = fs.readFileSync(ARCHIVE_SETTINGS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('读取归档设置文件失败:', err);
        return {};
    }
}

function writeArchiveSettings(data) {
    try {
        fs.writeFileSync(ARCHIVE_SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('写入归档设置文件失败:', err);
    }
}

// 保存归档频道设置
async function saveArchiveChannelSettings(guildId, archiveSettings) {
    const settings = readArchiveSettings();
    settings[guildId] = archiveSettings;
    writeArchiveSettings(settings);
    console.log(`成功保存归档频道设置 - guildId: ${guildId}`, archiveSettings);
    return archiveSettings;
}

// 获取归档频道设置
async function getArchiveChannelSettings(guildId) {
    const settings = readArchiveSettings();
    const result = settings[guildId];
    console.log(`获取归档频道设置 - guildId: ${guildId}`, result);
    return result;
}

// 保存归档查看身份组设置
async function saveArchiveViewRoleSettings(guildId, roleId) {
    const settings = readArchiveSettings();
    if (!settings[guildId]) {
        settings[guildId] = {};
    }
    settings[guildId].viewRoleId = roleId;
    settings[guildId].updatedAt = new Date().toISOString();
    writeArchiveSettings(settings);
    console.log(`成功保存归档查看身份组设置 - guildId: ${guildId}, roleId: ${roleId}`);
    return settings[guildId];
}

// 获取归档查看身份组设置
async function getArchiveViewRoleSettings(guildId) {
    const settings = readArchiveSettings();
    const result = settings[guildId]?.viewRoleId;
    console.log(`获取归档查看身份组设置 - guildId: ${guildId}, roleId: ${result}`);
    return result;
}

// 清除归档查看身份组设置
async function clearArchiveViewRoleSettings(guildId) {
    const settings = readArchiveSettings();
    if (settings[guildId]) {
        delete settings[guildId].viewRoleId;
        settings[guildId].updatedAt = new Date().toISOString();
        writeArchiveSettings(settings);
    }
    console.log(`成功清除归档查看身份组设置 - guildId: ${guildId}`);
    return true;
}

// 自动清理设置相关函数
function readAutoCleanupSettings() {
    try {
        const data = fs.readFileSync(AUTO_CLEANUP_SETTINGS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('读取自动清理设置文件失败:', err);
        return {};
    }
}

function writeAutoCleanupSettings(data) {
    try {
        fs.writeFileSync(AUTO_CLEANUP_SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('写入自动清理设置文件失败:', err);
    }
}

function readAutoCleanupTasks() {
    try {
        const data = fs.readFileSync(AUTO_CLEANUP_TASKS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('读取自动清理任务文件失败:', err);
        return {};
    }
}

function writeAutoCleanupTasks(data) {
    try {
        fs.writeFileSync(AUTO_CLEANUP_TASKS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('写入自动清理任务文件失败:', err);
    }
}

// 获取服务器的自动清理设置
async function getAutoCleanupSettings(guildId) {
    const settings = readAutoCleanupSettings();
    return settings[guildId] || {
        bannedKeywords: [],
        monitorChannels: [],
        exemptChannels: [],
        cleanupRole: null,
        isEnabled: false,
        autoCleanupEnabled: true
    };
}

// 保存服务器的自动清理设置
async function saveAutoCleanupSettings(guildId, settings) {
    const allSettings = readAutoCleanupSettings();
    allSettings[guildId] = settings;
    writeAutoCleanupSettings(allSettings);
    console.log(`成功保存自动清理设置 - guildId: ${guildId}`, settings);
    return settings;
}

// 添加违禁关键字
async function addBannedKeyword(guildId, keyword) {
    const settings = await getAutoCleanupSettings(guildId);
    if (!settings.bannedKeywords.includes(keyword)) {
        settings.bannedKeywords.push(keyword);
        await saveAutoCleanupSettings(guildId, settings);
    }
    return settings;
}

// 移除违禁关键字
async function removeBannedKeyword(guildId, keyword) {
    const settings = await getAutoCleanupSettings(guildId);
    settings.bannedKeywords = settings.bannedKeywords.filter(k => k !== keyword);
    await saveAutoCleanupSettings(guildId, settings);
    return settings;
}

// 获取违禁关键字列表
async function getBannedKeywords(guildId) {
    const settings = await getAutoCleanupSettings(guildId);
    return settings.bannedKeywords;
}

// 设置清理权限角色
async function setCleanupRole(guildId, roleId) {
    const settings = await getAutoCleanupSettings(guildId);
    settings.cleanupRole = roleId;
    await saveAutoCleanupSettings(guildId, settings);
    return settings;
}

// 设置监控频道
async function setCleanupChannels(guildId, channelIds) {
    const settings = await getAutoCleanupSettings(guildId);
    settings.monitorChannels = channelIds;
    await saveAutoCleanupSettings(guildId, settings);
    return settings;
}

// 保存清理任务
async function saveCleanupTask(guildId, taskData) {
    const tasks = readAutoCleanupTasks();
    if (!tasks[guildId]) {
        tasks[guildId] = {};
    }
    tasks[guildId][taskData.taskId] = taskData;
    writeAutoCleanupTasks(tasks);
    return taskData;
}

// 获取清理任务
async function getCleanupTask(guildId, taskId) {
    const tasks = readAutoCleanupTasks();
    return tasks[guildId]?.[taskId];
}

// 更新清理任务
async function updateCleanupTask(guildId, taskId, updates) {
    const tasks = readAutoCleanupTasks();
    if (tasks[guildId]?.[taskId]) {
        Object.assign(tasks[guildId][taskId], updates);
        writeAutoCleanupTasks(tasks);
    }
    return tasks[guildId]?.[taskId];
}

// 删除清理任务
async function deleteCleanupTask(guildId, taskId) {
    const tasks = readAutoCleanupTasks();
    if (tasks[guildId]?.[taskId]) {
        delete tasks[guildId][taskId];
        writeAutoCleanupTasks(tasks);
        return true;
    }
    return false;
}

// 获取活跃的清理任务
async function getActiveCleanupTask(guildId) {
    const tasks = readAutoCleanupTasks();
    if (!tasks[guildId]) return null;
    
    for (const taskId in tasks[guildId]) {
        const task = tasks[guildId][taskId];
        if (task.status === 'running') {
            return task;
        }
    }
    return null;
}

// 添加豁免频道
async function addExemptChannel(guildId, channelId) {
    const settings = await getAutoCleanupSettings(guildId);
    if (!settings.exemptChannels) {
        settings.exemptChannels = [];
    }
    if (!settings.exemptChannels.includes(channelId)) {
        settings.exemptChannels.push(channelId);
        await saveAutoCleanupSettings(guildId, settings);
    }
    return settings;
}

// 移除豁免频道
async function removeExemptChannel(guildId, channelId) {
    const settings = await getAutoCleanupSettings(guildId);
    if (!settings.exemptChannels) {
        settings.exemptChannels = [];
    }
    settings.exemptChannels = settings.exemptChannels.filter(id => id !== channelId);
    await saveAutoCleanupSettings(guildId, settings);
    return settings;
}

// 获取豁免频道列表
async function getExemptChannels(guildId) {
    const settings = await getAutoCleanupSettings(guildId);
    return settings.exemptChannels || [];
}

// 检查频道是否被豁免
async function isChannelExempt(guildId, channelId) {
    const exemptChannels = await getExemptChannels(guildId);
    return exemptChannels.includes(channelId);
}

// 检查论坛的子帖子是否被豁免（通过父论坛豁免）
async function isForumThreadExempt(guildId, thread) {
    if (!thread.parent) return false;
    return await isChannelExempt(guildId, thread.parent.id);
}

// --- 自助补档模块函数 开始 ---

function readAnonymousUploadLogs() {
    try {
        const data = fs.readFileSync(SELF_FILE_UPLOAD_LOGS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('读取自助补档日志文件失败:', err);
        return [];
    }
}

function writeAnonymousUploadLogs(data) {
    try {
        fs.writeFileSync(SELF_FILE_UPLOAD_LOGS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('写入自助补档日志文件失败:', err);
    }
}

/**
 * 添加一条新的匿名上传日志
 * @param {object} logEntry - 日志条目
 */
async function addAnonymousUploadLog(logEntry) {
    const logs = readAnonymousUploadLogs();
    logs.unshift(logEntry); // 在开头添加新日志，方便查找
    // 限制日志数量，防止文件无限增大
    if (logs.length > 10000) {
        logs.length = 10000;
    }
    writeAnonymousUploadLogs(logs);
}

/**
 * 根据新消息的ID查找匿名上传日志
 * @param {string} newMessageId - 机器人创建的消息的ID
 * @returns {object|null} 找到的日志条目或null
 */
async function getAnonymousUploadByMessageId(newMessageId) {
    const logs = readAnonymousUploadLogs();
    return logs.find(log => log.newMessageId === newMessageId) || null;
}

// --- 新增：匿名补档屏蔽列表相关函数 ---

/**
 * 读取匿名补档屏蔽列表
 * @returns {string[]} 用户ID列表
 */
function readOptOutList() {
    try {
        const data = fs.readFileSync(ANONYMOUS_UPLOAD_OPT_OUT_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        if (err.code === 'ENOENT') {
            return [];
        }
        console.error('读取匿名上传屏蔽列表文件失败:', err);
        return [];
    }
}

/**
 * 写入匿名补档屏蔽列表
 * @param {string[]} data - 用户ID列表
 */
function writeOptOutList(data) {
    try {
        fs.writeFileSync(ANONYMOUS_UPLOAD_OPT_OUT_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('写入匿名上传屏蔽列表文件失败:', err);
    }
}

/**
 * 添加用户到匿名补档屏蔽列表
 * @param {string} userId - 用户ID
 * @returns {Promise<boolean>} 是否成功添加
 */
async function addUserToOptOutList(userId) {
    const list = readOptOutList();
    if (!list.includes(userId)) {
        list.push(userId);
        writeOptOutList(list);
        console.log(`用户 ${userId} 已添加到匿名补档屏蔽列表。`);
        return true;
    }
    return false;
}

/**
 * 从匿名补档屏蔽列表移除用户
 * @param {string} userId - 用户ID
 * @returns {Promise<boolean>} 是否成功移除
 */
async function removeUserFromOptOutList(userId) {
    const list = readOptOutList();
    const index = list.indexOf(userId);
    if (index > -1) {
        list.splice(index, 1);
        writeOptOutList(list);
        console.log(`用户 ${userId} 已从匿名补档屏蔽列表移除。`);
        return true;
    }
    return false;
}

/**
 * 检查用户是否在匿名补档屏蔽列表中
 * @param {string} userId - 用户ID
 * @returns {Promise<boolean>} 是否在列表中
 */
async function isUserOptedOut(userId) {
    const list = readOptOutList();
    return list.includes(userId);
}


// --- 自助补档模块函数 结束 ---

// --- 自助管理黑名单模块函数 开始 ---

/**
 * 读取自助管理黑名单数据
 * @returns {object} 黑名单数据
 */
function readSelfModerationBlacklist() {
    try {
        const data = fs.readFileSync(SELF_MODERATION_BLACKLIST_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('读取自助管理黑名单文件失败:', err);
        return {};
    }
}

/**
 * 写入自助管理黑名单数据
 * @param {object} data - 黑名单数据
 */
function writeSelfModerationBlacklist(data) {
    try {
        fs.writeFileSync(SELF_MODERATION_BLACKLIST_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('写入自助管理黑名单文件失败:', err);
    }
}

/**
 * 获取服务器的自助管理黑名单
 * @param {string} guildId - 服务器ID
 * @returns {Promise<object>} 黑名单数据 { userId: { bannedAt, bannedBy, reason, expiresAt } }
 */
async function getSelfModerationBlacklist(guildId) {
    const blacklist = readSelfModerationBlacklist();
    return blacklist[guildId] || {};
}

/**
 * 添加用户到自助管理黑名单
 * @param {string} guildId - 服务器ID
 * @param {string} userId - 用户ID
 * @param {string} bannedBy - 执行封禁的管理员ID
 * @param {string} reason - 封禁原因（可选）
 * @param {number} durationDays - 封禁时长（天数，0或null表示永久）
 * @returns {Promise<object>} 黑名单条目
 */
async function addUserToSelfModerationBlacklist(guildId, userId, bannedBy, reason = null, durationDays = 0) {
    const blacklist = readSelfModerationBlacklist();
    
    if (!blacklist[guildId]) {
        blacklist[guildId] = {};
    }
    
    const bannedAt = new Date().toISOString();
    let expiresAt = null;
    
    if (durationDays && durationDays > 0) {
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + durationDays);
        expiresAt = expiryDate.toISOString();
    }
    
    blacklist[guildId][userId] = {
        bannedAt,
        bannedBy,
        reason: reason || null,
        expiresAt,
        durationDays: durationDays || 0
    };
    
    writeSelfModerationBlacklist(blacklist);
    console.log(`用户 ${userId} 已添加到服务器 ${guildId} 的自助管理黑名单`);
    
    return blacklist[guildId][userId];
}

/**
 * 从自助管理黑名单移除用户
 * @param {string} guildId - 服务器ID
 * @param {string} userId - 用户ID
 * @returns {Promise<boolean>} 是否成功移除
 */
async function removeUserFromSelfModerationBlacklist(guildId, userId) {
    const blacklist = readSelfModerationBlacklist();
    
    if (!blacklist[guildId] || !blacklist[guildId][userId]) {
        return false;
    }
    
    delete blacklist[guildId][userId];
    writeSelfModerationBlacklist(blacklist);
    console.log(`用户 ${userId} 已从服务器 ${guildId} 的自助管理黑名单移除`);
    
    return true;
}

/**
 * 检查用户是否在自助管理黑名单中（会自动清理过期的封禁）
 * @param {string} guildId - 服务器ID
 * @param {string} userId - 用户ID
 * @returns {Promise<object>} { isBlacklisted: boolean, reason: string, expiresAt: string, bannedBy: string }
 */
async function isUserInSelfModerationBlacklist(guildId, userId) {
    const blacklist = readSelfModerationBlacklist();
    
    if (!blacklist[guildId] || !blacklist[guildId][userId]) {
        return { isBlacklisted: false, reason: null, expiresAt: null, bannedBy: null };
    }
    
    const entry = blacklist[guildId][userId];
    
    // 检查是否已过期
    if (entry.expiresAt) {
        const now = new Date();
        const expiryDate = new Date(entry.expiresAt);
        
        if (now >= expiryDate) {
            // 已过期，自动移除
            delete blacklist[guildId][userId];
            writeSelfModerationBlacklist(blacklist);
            console.log(`用户 ${userId} 的封禁已过期，自动从黑名单移除`);
            return { isBlacklisted: false, reason: null, expiresAt: null, bannedBy: null };
        }
    }
    
    return {
        isBlacklisted: true,
        reason: entry.reason,
        expiresAt: entry.expiresAt,
        bannedBy: entry.bannedBy,
        bannedAt: entry.bannedAt
    };
}

/**
 * 清理服务器中所有过期的黑名单条目
 * @param {string} guildId - 服务器ID
 * @returns {Promise<number>} 清理的条目数量
 */
async function cleanupExpiredBlacklist(guildId) {
    const blacklist = readSelfModerationBlacklist();
    
    if (!blacklist[guildId]) {
        return 0;
    }
    
    const now = new Date();
    let cleanedCount = 0;
    
    for (const userId in blacklist[guildId]) {
        const entry = blacklist[guildId][userId];
        
        if (entry.expiresAt) {
            const expiryDate = new Date(entry.expiresAt);
            
            if (now >= expiryDate) {
                delete blacklist[guildId][userId];
                cleanedCount++;
            }
        }
    }
    
    if (cleanedCount > 0) {
        writeSelfModerationBlacklist(blacklist);
        console.log(`服务器 ${guildId} 清理了 ${cleanedCount} 个过期的黑名单条目`);
    }
    
    return cleanedCount;
}

// --- 自助管理黑名单模块函数 结束 ---


module.exports = {
    saveSettings,
    getSettings,
    saveMessage,
    getMessage,
    updateMessage,
    getAllMessages,
    getNextId,
    saveFormPermissionSettings,
    getFormPermissionSettings,
    saveSupportPermissionSettings,
    getSupportPermissionSettings,

    // 审核相关导出
    saveCheckChannelSettings,
    getCheckChannelSettings,
    getAllCheckChannelSettings,
    saveReviewSettings,
    getReviewSettings,
    getAllowedServers,
    addAllowedServer,
    removeAllowedServer,
    isServerAllowed,
    getAllowedForums,
    addAllowedForum,
    removeAllowedForum,
    isForumAllowed,
    getServerWhitelistDetails,

    // 法庭相关导出
    saveCourtSettings,
    getCourtSettings,
    getNextCourtId,
    saveCourtApplication,
    getCourtApplication,
    updateCourtApplication,
    getAllCourtApplications,
    saveCourtVote,
    getCourtVote,
    updateCourtVote,
    getAllCourtVotes,
    
    // 自助管理相关导出
    saveSelfModerationSettings,
    getSelfModerationSettings,
    saveSelfModerationVote,
    getSelfModerationVote,
    updateSelfModerationVote,
    getAllSelfModerationVotes,
    deleteSelfModerationVote,
    // 自助补档相关导出
    addAnonymousUploadLog,
    getAnonymousUploadByMessageId,
    // 匿名补档屏蔽列表
    readOptOutList,
    addUserToOptOutList,
    removeUserFromOptOutList,
    isUserOptedOut,

    // 冷却时间相关导出
    saveSelfModerationGlobalCooldown,
    getSelfModerationGlobalCooldown,
    updateUserLastUsage,
    getUserLastUsage,
    checkUserGlobalCooldown,
    // 消息时间限制相关导出
    saveMessageTimeLimit,
    getMessageTimeLimit,
    checkMessageTimeLimit,
    // 归档相关导出
    saveArchiveChannelSettings,
    getArchiveChannelSettings,
    saveArchiveViewRoleSettings,
    getArchiveViewRoleSettings,
    clearArchiveViewRoleSettings,
    // 自动清理相关
    getAutoCleanupSettings,
    saveAutoCleanupSettings,
    addBannedKeyword,
    removeBannedKeyword,
    getBannedKeywords,
    setCleanupRole,
    setCleanupChannels,
    saveCleanupTask,
    getCleanupTask,
    updateCleanupTask,
    deleteCleanupTask,
    getActiveCleanupTask,
    // 豁免频道相关
    addExemptChannel,
    removeExemptChannel,
    getExemptChannels,
    isChannelExempt,
    isForumThreadExempt,

    // Self Role
    getSelfRoleSettings,
    getAllSelfRoleSettings,
    saveSelfRoleSettings,
    getUserActivity,
    saveUserActivityBatch,
    saveDailyUserActivityBatch,
    getUserDailyActivity,
    getUserActiveDaysCount,
    getSelfRoleApplication,
    saveSelfRoleApplication,
    deleteSelfRoleApplication,
    // 根据申请人+身份组查询是否存在“待审核”申请，防止重复创建面板
    getPendingApplicationByApplicantRole,
    // 被拒绝后的冷却期管理
    setSelfRoleCooldown,
    getSelfRoleCooldown,
    clearSelfRoleCooldown,
    clearChannelActivity,
    countLegacyPendingSelfRoleApplications,
    countReservedPendingSelfRoleApplicationsV2,
    getActiveSelfRolePanels,
    deactivateSelfRolePanels,
    deactivateSelfRolePanel,
    registerSelfRolePanelMessage,
    touchSelfRolePanelRenderedAt,
    // SelfRole v2 applications
    getSelfRoleApplicationV2,
    getSelfRoleApplicationV2ByReviewMessageId,
    saveSelfRoleApplicationV2,
    getPendingSelfRoleApplicationV2ByApplicantRole,
    listPendingSelfRoleApplicationsV2ByApplicant,
    listLegacyPendingSelfRoleApplications,
    resolveSelfRoleApplicationV2,
    expirePendingSelfRoleApplicationsV2,

    // SelfRole grants
    getSelfRoleGrant,
    getActiveSelfRoleGrantByUserRole,
    endActiveSelfRoleGrantsForUserRole,
    createSelfRoleGrant,
    listSelfRoleGrantRoles,
    countActiveSelfRoleGrantHoldersByRole,
    listAllActiveSelfRoleGrants,
    listEndedSelfRoleGrantsSince,
    updateSelfRoleGrantSchedule,
    updateSelfRoleGrantInquiry,
    updateSelfRoleGrantLastDecision,
    endSelfRoleGrant,
    // renewal sessions
    getSelfRoleRenewalSession,
    getPendingSelfRoleRenewalSessionByGrant,
    createSelfRoleRenewalSession,
    updateSelfRoleRenewalSession,

    // SelfRole alerts / admin attention
    setSelfRoleGrantManualAttentionRequired,
    createSelfRoleSystemAlert,
    listActiveSelfRoleSystemAlerts,
    getSelfRoleSystemAlert,
    countActiveSelfRoleSystemAlertsByGrant,
    getActiveSelfRoleSystemAlertByGrantType,
    getActiveSelfRoleSystemAlertByApplicationType,
    resolveSelfRoleSystemAlert,

    // 自助管理黑名单相关导出
    getSelfModerationBlacklist,
    addUserToSelfModerationBlacklist,
    removeUserFromSelfModerationBlacklist,
    isUserInSelfModerationBlacklist,
    cleanupExpiredBlacklist,
};