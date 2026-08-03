const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../../../data');
const DATABASE_FILE = process.env.SAFETY_SETUP_DATABASE_FILE ||
    path.join(DATA_DIR, 'safetySetup.sqlite');

let database = null;
let statements = null;

function initializeSafetyDatabase() {
    if (database) return database;

    fs.mkdirSync(DATA_DIR, { recursive: true });
    const Database = require('better-sqlite3');
    database = new Database(DATABASE_FILE);
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = NORMAL');
    database.pragma('busy_timeout = 5000');
    database.exec(`
        CREATE TABLE IF NOT EXISTS safety_invite_management (
            guild_id TEXT PRIMARY KEY,
            resume_at TEXT,
            enabled_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1
        )
    `);

    const columns = database.pragma('table_info(safety_invite_management)');
    if (!columns.some((column) => column.name === 'revision')) {
        database.exec(`
            ALTER TABLE safety_invite_management
            ADD COLUMN revision INTEGER NOT NULL DEFAULT 1
        `);
    }

    statements = {
        upsert: database.prepare(`
            INSERT INTO safety_invite_management (
                guild_id, resume_at, enabled_by, created_at, updated_at, revision
            ) VALUES (
                @guild_id, @resume_at, @enabled_by, @created_at, @updated_at, 1
            )
            ON CONFLICT(guild_id) DO UPDATE SET
                resume_at = excluded.resume_at,
                enabled_by = excluded.enabled_by,
                updated_at = excluded.updated_at,
                revision = safety_invite_management.revision + 1
        `),
        remove: database.prepare('DELETE FROM safety_invite_management WHERE guild_id = ?'),
        removeIfRevision: database.prepare(`
            DELETE FROM safety_invite_management
            WHERE guild_id = ? AND revision = ?
        `),
        get: database.prepare(`
            SELECT guild_id, resume_at, enabled_by, created_at, updated_at, revision
            FROM safety_invite_management
            WHERE guild_id = ?
        `),
        listAll: database.prepare(`
            SELECT guild_id, resume_at, enabled_by, created_at, updated_at, revision
            FROM safety_invite_management
            ORDER BY guild_id
        `),
        listDue: database.prepare(`
            SELECT guild_id, resume_at, enabled_by, created_at, updated_at, revision
            FROM safety_invite_management
            WHERE resume_at IS NOT NULL AND resume_at <= ?
            ORDER BY resume_at
        `),
    };

    return database;
}

function ensureInitialized() {
    if (!database) initializeSafetyDatabase();
}

function upsertManagedGuild({ guildId, resumeAt, enabledBy, nowIso = new Date().toISOString() }) {
    ensureInitialized();
    statements.upsert.run({
        guild_id: guildId,
        resume_at: resumeAt,
        enabled_by: enabledBy,
        created_at: nowIso,
        updated_at: nowIso,
    });
    return statements.get.get(guildId);
}

function getManagedGuild(guildId) {
    ensureInitialized();
    return statements.get.get(guildId) || null;
}

function removeManagedGuild(guildId) {
    ensureInitialized();
    return statements.remove.run(guildId).changes > 0;
}

function removeManagedGuildIfRevision(guildId, revision) {
    ensureInitialized();
    return statements.removeIfRevision.run(guildId, revision).changes > 0;
}

function listManagedGuilds() {
    ensureInitialized();
    return statements.listAll.all();
}

function listDueManagedGuilds(nowIso = new Date().toISOString()) {
    ensureInitialized();
    return statements.listDue.all(nowIso);
}

function closeSafetyDatabase() {
    if (database) database.close();
    database = null;
    statements = null;
}

module.exports = {
    DATABASE_FILE,
    initializeSafetyDatabase,
    upsertManagedGuild,
    getManagedGuild,
    removeManagedGuild,
    removeManagedGuildIfRevision,
    listManagedGuilds,
    listDueManagedGuilds,
    closeSafetyDatabase,
};
