const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DATA_DIRECTORY = path.join(__dirname, '../../../data');

function exists(filename) {
    try { fs.statSync(filename); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function readDb(directory, filename, inspect) {
    const fullPath = path.join(directory, filename);
    if (!exists(fullPath)) return;
    // Never import the other module's DB initializer: that could migrate/write its data.
    const db = new Database(fullPath, { readonly: true, fileMustExist: true });
    try { db.transaction(() => inspect(db))(); }
    finally { db.close(); }
}

function readJson(filename) {
    if (!exists(filename)) return {};
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置格式异常');
    return value;
}

function checkCompatibility(guildId, roleId, { dataDirectory = DATA_DIRECTORY, notificationFile = path.join(__dirname, '../voting/data/notification_roles.json') } = {}) {
    try {
        readDb(dataDirectory, 'roleSync.sqlite', db => {
            const mapping = db.prepare(`SELECT 1 FROM role_sync_map m JOIN sync_links l ON m.link_id=l.link_id
                WHERE m.enabled=1 AND l.enabled=1 AND
                ((l.source_guild_id=? AND m.source_role_id=?) OR (l.target_guild_id=? AND m.target_role_id=?)) LIMIT 1`)
                .get(guildId, roleId, guildId, roleId);
            const pending = db.prepare(`SELECT 1 FROM sync_jobs WHERE status IN ('pending','running','processing') AND
                ((target_guild_id=? AND target_role_id=?) OR (source_guild_id=? AND source_role_id=?)) LIMIT 1`)
                .get(guildId, roleId, guildId, roleId);
            if (mapping || pending) throw new Error('该身份组参与有效跨服同步配置或未完成同步任务，无法隔离跨服影响，拒绝批量操作。');
        });
        readDb(dataDirectory, 'selfRole.sqlite', db => {
            const row = db.prepare('SELECT roles FROM role_settings WHERE guild_id=?').get(guildId);
            const configs = row ? JSON.parse(row.roles) : [];
            if (!Array.isArray(configs) || configs.some(r => !r || typeof r.roleId !== 'string' || (r.bundleRoleIds != null && !Array.isArray(r.bundleRoleIds)))) throw new Error('自助身份组配置格式异常');
            const configured = configs.some(r => r.roleId === roleId || (r.bundleRoleIds || []).includes(roleId));
            const granted = db.prepare(`SELECT 1 FROM sr_grants g LEFT JOIN sr_grant_roles r ON r.grant_id=g.grant_id
                WHERE g.guild_id=? AND g.status='active' AND (g.primary_role_id=? OR r.role_id=?) LIMIT 1`).get(guildId, roleId, roleId);
            if (configured || granted) throw new Error('该身份组由自助身份组或生命周期机制管理，拒绝批量操作。');
        });
        readDb(dataDirectory, 'punishment.sqlite', db => {
            const warn = db.prepare('SELECT role_id FROM punishment_warn_role_config WHERE guild_id=?').get(guildId);
            if (warn?.role_id === roleId) throw new Error('该身份组是处罚警告身份组，拒绝批量操作。');
        });
        const archive = readJson(path.join(dataDirectory, 'archiveSettings.json'));
        const review = readJson(path.join(dataDirectory, 'reviewSettings.json'));
        const contests = readJson(path.join(dataDirectory, 'contestChannels.json'));
        const notification = readJson(notificationFile);
        const notificationRoles = notification[guildId]?.roles || [];
        if (!Array.isArray(notificationRoles)) throw new Error('通知身份组配置格式异常');
        if (archive[guildId]?.viewRoleId === roleId || review[guildId]?.rewardRoleId === roleId || notificationRoles.some(r => (typeof r === 'string' ? r : r.roleId) === roleId)) {
            throw new Error('该身份组参与自助发放，拒绝批量操作。');
        }
        if (Object.values(contests).some(c => c?.guildId === guildId && c.autoGrantRole && c.participantRoleId === roleId)) throw new Error('该身份组参与赛事自动发放，拒绝批量操作。');
    } catch (error) {
        if (/拒绝批量操作/.test(error.message)) throw error;
        // Avoid exposing DB paths or contents to Discord users.
        throw new Error('无法可靠读取身份组自动化兼容性配置，已拒绝操作；请检查本地配置和数据库。');
    }
}

module.exports = { checkCompatibility };
