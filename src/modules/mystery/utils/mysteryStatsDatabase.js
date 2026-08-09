const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

// 神秘指令游戏数据库。目前只有加压轮盘一张表，
// 但库文件与初始化流程是按「以后还会加运气轮盘 / 传炸弹 / 死斗」设计的：
// 新游戏各自建一张 <game>_player_stats 表，共用这里的连接与 pragma。
const DATA_DIR = path.join(__dirname, '../../../../data', 'mystery');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const STATS_DB_FILE = path.join(DATA_DIR, 'mysteryStats.sqlite');
const statsDb = new Database(STATS_DB_FILE);

let initialized = false;

// 一场游戏结束后要累加的计数列。max_ / first_ / last_ 这类非累加列单独处理。
const ADDITIVE_COLUMNS = Object.freeze([
    'games_played',
    'wins',
    'survived',
    'shots_fired',
    'hits_taken',
    'blanks',
    'loads',
    'bullets_loaded',
    'again_count',
    'pass_count',
    'quits',
    'timeout_minutes',
    'coward_minutes',
    'expected_hits',
]);

const MAX_COLUMNS = Object.freeze([
    'max_charge',
    'max_bullets_faced',
]);

function initializeMysteryStatsDatabase() {
    if (initialized) return;

    statsDb.pragma('journal_mode = WAL');
    statsDb.pragma('synchronous = NORMAL');
    statsDb.pragma('busy_timeout = 5000');

    statsDb.exec(`
        CREATE TABLE IF NOT EXISTS pressure_player_stats (
            guild_id          TEXT NOT NULL,
            user_id           TEXT NOT NULL,
            games_played      INTEGER NOT NULL DEFAULT 0,
            wins              INTEGER NOT NULL DEFAULT 0,
            survived          INTEGER NOT NULL DEFAULT 0,
            shots_fired       INTEGER NOT NULL DEFAULT 0,
            hits_taken        INTEGER NOT NULL DEFAULT 0,
            blanks            INTEGER NOT NULL DEFAULT 0,
            loads             INTEGER NOT NULL DEFAULT 0,
            bullets_loaded    INTEGER NOT NULL DEFAULT 0,
            again_count       INTEGER NOT NULL DEFAULT 0,
            pass_count        INTEGER NOT NULL DEFAULT 0,
            quits             INTEGER NOT NULL DEFAULT 0,
            max_charge        INTEGER NOT NULL DEFAULT 0,
            max_bullets_faced INTEGER NOT NULL DEFAULT 0,
            timeout_minutes   INTEGER NOT NULL DEFAULT 0,
            coward_minutes    INTEGER NOT NULL DEFAULT 0,
            expected_hits     REAL NOT NULL DEFAULT 0,
            first_played_at   INTEGER NOT NULL,
            last_played_at    INTEGER NOT NULL,
            PRIMARY KEY (guild_id, user_id)
        );

        CREATE INDEX IF NOT EXISTS idx_pressure_stats_guild
            ON pressure_player_stats (guild_id);
    `);

    initialized = true;
    console.log('[MysteryStats] ✅ 神秘指令游戏数据库初始化完成。');
}

initializeMysteryStatsDatabase();

const upsertStatement = statsDb.prepare(`
    INSERT INTO pressure_player_stats (
        guild_id, user_id,
        ${ADDITIVE_COLUMNS.join(', ')},
        ${MAX_COLUMNS.join(', ')},
        first_played_at, last_played_at
    ) VALUES (
        @guild_id, @user_id,
        ${ADDITIVE_COLUMNS.map(column => `@${column}`).join(', ')},
        ${MAX_COLUMNS.map(column => `@${column}`).join(', ')},
        @played_at, @played_at
    )
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
        ${ADDITIVE_COLUMNS.map(c => `${c} = ${c} + excluded.${c}`).join(',\n        ')},
        ${MAX_COLUMNS.map(c => `${c} = MAX(${c}, excluded.${c})`).join(',\n        ')},
        last_played_at = excluded.last_played_at
`);

const recordTransaction = statsDb.transaction((guildId, rows, playedAt) => {
    for (const row of rows) {
        const params = { guild_id: guildId, user_id: row.userId, played_at: playedAt };
        for (const column of ADDITIVE_COLUMNS) {
            params[column] = Number(row[column]) || 0;
        }
        for (const column of MAX_COLUMNS) {
            params[column] = Number(row[column]) || 0;
        }
        upsertStatement.run(params);
    }
});

/**
 * 把一整场加压轮盘的结果写进数据库（单事务）。
 * @param {string} guildId
 * @param {Array<object>} rows 每个玩家一行，字段名与表列名一致（外加 userId）
 * @param {number} playedAt
 * @returns {number} 实际写入的玩家数
 */
function recordPressureGame(guildId, rows, playedAt = Date.now()) {
    if (!guildId || !Array.isArray(rows) || rows.length === 0) return 0;
    const valid = rows.filter(row => typeof row?.userId === 'string' && row.userId.length > 0);
    if (valid.length === 0) return 0;
    recordTransaction(guildId, valid, playedAt);
    return valid.length;
}

function getPressurePlayerStats(guildId, userId) {
    return statsDb
        .prepare('SELECT * FROM pressure_player_stats WHERE guild_id = ? AND user_id = ?')
        .get(guildId, userId) || null;
}

/**
 * 取出整个服务器的数据。称号计算需要横向比较全服玩家，
 * 单服玩家量级很小（几十到几百行），直接全量读出来在 JS 里算最简单也最好改。
 */
function listPressureStats(guildId) {
    return statsDb
        .prepare('SELECT * FROM pressure_player_stats WHERE guild_id = ?')
        .all(guildId);
}

function getPressureGuildSummary(guildId) {
    const row = statsDb.prepare(`
        SELECT
            COUNT(*)                        AS players,
            COALESCE(SUM(games_played), 0)  AS game_entries,
            COALESCE(SUM(shots_fired), 0)   AS shots_fired,
            COALESCE(SUM(hits_taken), 0)    AS hits_taken,
            COALESCE(SUM(bullets_loaded), 0) AS bullets_loaded,
            COALESCE(SUM(quits), 0)         AS quits,
            COALESCE(SUM(timeout_minutes), 0) AS timeout_minutes
        FROM pressure_player_stats
        WHERE guild_id = ?
    `).get(guildId);
    return row || {
        players: 0,
        game_entries: 0,
        shots_fired: 0,
        hits_taken: 0,
        bullets_loaded: 0,
        quits: 0,
        timeout_minutes: 0,
    };
}

function resetPressureUser(guildId, userId) {
    const info = statsDb
        .prepare('DELETE FROM pressure_player_stats WHERE guild_id = ? AND user_id = ?')
        .run(guildId, userId);
    return (info?.changes || 0) > 0;
}

function resetPressureGuild(guildId) {
    const info = statsDb
        .prepare('DELETE FROM pressure_player_stats WHERE guild_id = ?')
        .run(guildId);
    return info?.changes || 0;
}

module.exports = {
    STATS_DB_FILE,
    initializeMysteryStatsDatabase,
    recordPressureGame,
    getPressurePlayerStats,
    listPressureStats,
    getPressureGuildSummary,
    resetPressureUser,
    resetPressureGuild,
};
