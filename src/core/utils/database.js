// src\core\utils\database.js
const fs = require('fs');
const path = require('path');
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

// --- Self Role SQLite Database Initialization ---
const selfRoleDb = new Database(SELF_ROLE_DB_FILE);

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
    } catch (migErr) {
        console.error('[SelfRole] ❌ 检查/添加 reason 列时出错：', migErr);
    }

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
    return {
        roles: JSON.parse(row.roles),
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
    const stmt = selfRoleDb.prepare(`
        INSERT INTO role_settings (guild_id, roles, last_successful_save)
        VALUES (?, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET
            roles = excluded.roles,
            last_successful_save = excluded.last_successful_save
    `);
    stmt.run(guildId, JSON.stringify(data.roles || []), data.lastSuccessfulSave || null);
    return data;
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
        settings[row.guild_id] = {
            roles: JSON.parse(row.roles),
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
        INSERT INTO role_applications (message_id, applicant_id, role_id, status, approvers, rejecters, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET
            applicant_id = excluded.applicant_id,
            role_id = excluded.role_id,
            status = excluded.status,
            approvers = excluded.approvers,
            rejecters = excluded.rejecters,
            reason = excluded.reason
    `);
    stmt.run(
        messageId,
        data.applicantId,
        data.roleId,
        data.status,
        JSON.stringify(data.approvers || []),
        JSON.stringify(data.rejecters || []),
        data.reason || null
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
        SELECT message_id, applicant_id, role_id, status, approvers, rejecters, reason
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
    const stmt = selfRoleDb.prepare('DELETE FROM user_activity WHERE guild_id = ? AND channel_id = ?');
    stmt.run(guildId, channelId);
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
};