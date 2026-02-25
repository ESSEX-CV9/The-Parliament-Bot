const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '../../../../data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const ROLE_SYNC_DB_FILE = path.join(DATA_DIR, 'roleSync.sqlite');
const roleSyncDb = new Database(ROLE_SYNC_DB_FILE);

let initialized = false;

function nowIso() {
    return new Date().toISOString();
}

function ensureColumnIfMissing(tableName, columnName, definitionSql) {
    const rows = roleSyncDb.prepare(`PRAGMA table_info(${tableName})`).all();
    const exists = rows.some((row) => row.name === columnName);
    if (exists) {
        return;
    }

    roleSyncDb.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definitionSql}`);
    console.log(`[RoleSync] 🔧 已为 ${tableName} 添加列 ${columnName}`);
}

function safeJsonParse(value, fallback = null) {
    try { return JSON.parse(value); } catch (_) { return fallback; }
}

function initializeRoleSyncDatabase() {
    if (initialized) {
        return;
    }

    roleSyncDb.pragma('journal_mode = WAL');
    roleSyncDb.pragma('synchronous = NORMAL');
    roleSyncDb.pragma('busy_timeout = 5000');
    roleSyncDb.pragma('foreign_keys = ON');

    roleSyncDb.exec(`
        CREATE TABLE IF NOT EXISTS guilds (
            guild_id TEXT PRIMARY KEY,
            guild_name TEXT,
            is_main INTEGER NOT NULL DEFAULT 0,
            is_enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sync_links (
            link_id TEXT PRIMARY KEY,
            source_guild_id TEXT NOT NULL,
            target_guild_id TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            default_conflict_policy TEXT NOT NULL DEFAULT 'source_of_truth_main',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (source_guild_id) REFERENCES guilds(guild_id),
            FOREIGN KEY (target_guild_id) REFERENCES guilds(guild_id)
        );

        CREATE INDEX IF NOT EXISTS idx_sync_links_source ON sync_links(source_guild_id);
        CREATE INDEX IF NOT EXISTS idx_sync_links_target ON sync_links(target_guild_id);

        CREATE TABLE IF NOT EXISTS role_sync_map (
            map_id INTEGER PRIMARY KEY AUTOINCREMENT,
            link_id TEXT NOT NULL,
            source_role_id TEXT NOT NULL,
            target_role_id TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            sync_mode TEXT NOT NULL DEFAULT 'source_to_target',
            conflict_policy TEXT,
            max_delay_seconds INTEGER NOT NULL DEFAULT 120,
            role_type TEXT,
            copy_visual INTEGER NOT NULL DEFAULT 1,
            copy_permissions_mode TEXT NOT NULL DEFAULT 'none',
            note TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(link_id, source_role_id, target_role_id),
            FOREIGN KEY (link_id) REFERENCES sync_links(link_id)
        );

        CREATE INDEX IF NOT EXISTS idx_role_sync_map_link ON role_sync_map(link_id);
        CREATE INDEX IF NOT EXISTS idx_role_sync_map_source_role ON role_sync_map(source_role_id);
        CREATE INDEX IF NOT EXISTS idx_role_sync_map_target_role ON role_sync_map(target_role_id);
        CREATE INDEX IF NOT EXISTS idx_role_sync_map_role_type ON role_sync_map(role_type);

        CREATE TABLE IF NOT EXISTS guild_members (
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1,
            joined_at TEXT,
            left_at TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (guild_id, user_id),
            FOREIGN KEY (guild_id) REFERENCES guilds(guild_id)
        );

        CREATE INDEX IF NOT EXISTS idx_guild_members_user ON guild_members(user_id);
        CREATE INDEX IF NOT EXISTS idx_guild_members_active ON guild_members(guild_id, is_active);

        CREATE TABLE IF NOT EXISTS sync_jobs (
            job_id INTEGER PRIMARY KEY AUTOINCREMENT,
            dedupe_key TEXT NOT NULL,
            link_id TEXT NOT NULL,
            operation_id TEXT,
            source_guild_id TEXT NOT NULL,
            target_guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            source_role_id TEXT NOT NULL,
            target_role_id TEXT NOT NULL,
            action TEXT NOT NULL,
            lane TEXT NOT NULL DEFAULT 'normal',
            priority INTEGER NOT NULL DEFAULT 10,
            status TEXT NOT NULL DEFAULT 'pending',
            attempt_count INTEGER NOT NULL DEFAULT 0,
            max_attempts INTEGER NOT NULL DEFAULT 3,
            not_before_ms INTEGER,
            conflict_policy TEXT,
            max_delay_seconds INTEGER,
            source_event TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (link_id) REFERENCES sync_links(link_id)
        );

        CREATE INDEX IF NOT EXISTS idx_sync_jobs_status_due ON sync_jobs(status, not_before_ms, priority);
        CREATE INDEX IF NOT EXISTS idx_sync_jobs_link ON sync_jobs(link_id);
        CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_jobs_dedupe_active
        ON sync_jobs(dedupe_key)
        WHERE status IN ('pending', 'processing');

        CREATE TABLE IF NOT EXISTS role_change_log (
            log_id INTEGER PRIMARY KEY AUTOINCREMENT,
            operation_id TEXT,
            job_id INTEGER,
            link_id TEXT,
            source_event TEXT,
            source_guild_id TEXT,
            target_guild_id TEXT,
            user_id TEXT,
            source_role_id TEXT,
            target_role_id TEXT,
            action TEXT,
            result TEXT NOT NULL,
            error_message TEXT,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_role_change_log_time ON role_change_log(created_at);
        CREATE INDEX IF NOT EXISTS idx_role_change_log_user ON role_change_log(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_role_change_log_role ON role_change_log(target_role_id, created_at);

        CREATE TABLE IF NOT EXISTS sync_operation_marks (
            mark_id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            role_id TEXT NOT NULL,
            action TEXT NOT NULL,
            expires_at_ms INTEGER NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_sync_operation_marks_lookup
        ON sync_operation_marks(guild_id, user_id, role_id, action, expires_at_ms);

        CREATE TABLE IF NOT EXISTS config_snapshots (
            snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
            link_id TEXT,
            snapshot_name TEXT,
            snapshot_json TEXT NOT NULL,
            created_by TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS config_import_jobs (
            job_id TEXT PRIMARY KEY,
            guild_id TEXT NOT NULL,
            file_name TEXT,
            status TEXT NOT NULL,
            parsed_json TEXT NOT NULL,
            total_rows INTEGER NOT NULL DEFAULT 0,
            valid_rows INTEGER NOT NULL DEFAULT 0,
            invalid_rows INTEGER NOT NULL DEFAULT 0,
            preview_json TEXT,
            apply_result_json TEXT,
            error_json TEXT,
            created_by TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            applied_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_config_import_jobs_created_at ON config_import_jobs(created_at DESC);
    `);

    ensureColumnIfMissing('sync_jobs', 'lane', "TEXT NOT NULL DEFAULT 'normal'");
    roleSyncDb.exec("CREATE INDEX IF NOT EXISTS idx_sync_jobs_lane_status_due ON sync_jobs(lane, status, not_before_ms, priority)");

    initialized = true;
    console.log('[RoleSync] ✅ roleSync.sqlite 初始化完成。');
}

function getRoleSyncDb() {
    initializeRoleSyncDatabase();
    return roleSyncDb;
}

function upsertGuild(guildId, guildName = null, isMain = 0) {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare(`
        INSERT INTO guilds (guild_id, guild_name, is_main, is_enabled, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET
            guild_name = COALESCE(excluded.guild_name, guilds.guild_name),
            is_main = CASE WHEN excluded.is_main = 1 THEN 1 ELSE guilds.is_main END,
            updated_at = excluded.updated_at
    `);

    const now = nowIso();
    stmt.run(guildId, guildName, isMain ? 1 : 0, now, now);
}

function upsertSyncLink({ linkId, sourceGuildId, targetGuildId, enabled = true, defaultConflictPolicy = 'source_of_truth_main' }) {
    initializeRoleSyncDatabase();
    const now = nowIso();

    upsertGuild(sourceGuildId, null, 1);
    upsertGuild(targetGuildId, null, 0);

    const stmt = roleSyncDb.prepare(`
        INSERT INTO sync_links (link_id, source_guild_id, target_guild_id, enabled, default_conflict_policy, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(link_id) DO UPDATE SET
            source_guild_id = excluded.source_guild_id,
            target_guild_id = excluded.target_guild_id,
            enabled = excluded.enabled,
            default_conflict_policy = excluded.default_conflict_policy,
            updated_at = excluded.updated_at
    `);

    stmt.run(linkId, sourceGuildId, targetGuildId, enabled ? 1 : 0, defaultConflictPolicy, now, now);
}

function getSyncLinkById(linkId) {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare('SELECT * FROM sync_links WHERE link_id = ? LIMIT 1');
    return stmt.get(linkId) || null;
}

function listSyncLinks() {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare(`
        SELECT l.*, sg.guild_name AS source_guild_name, tg.guild_name AS target_guild_name
        FROM sync_links l
        LEFT JOIN guilds sg ON sg.guild_id = l.source_guild_id
        LEFT JOIN guilds tg ON tg.guild_id = l.target_guild_id
        ORDER BY l.link_id ASC
    `);
    return stmt.all();
}

function updateSyncLinkEnabled(linkId, enabled) {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare(`
        UPDATE sync_links
        SET enabled = ?,
            updated_at = ?
        WHERE link_id = ?
    `);

    const result = stmt.run(enabled ? 1 : 0, nowIso(), linkId);
    return result.changes;
}

function upsertRoleSyncMap({
    linkId,
    sourceRoleId,
    targetRoleId,
    enabled = true,
    syncMode = 'source_to_target',
    conflictPolicy = null,
    maxDelaySeconds = 120,
    roleType = null,
    copyVisual = true,
    copyPermissionsMode = 'none',
    note = null,
}) {
    initializeRoleSyncDatabase();
    const now = nowIso();

    const stmt = roleSyncDb.prepare(`
        INSERT INTO role_sync_map (
            link_id, source_role_id, target_role_id, enabled, sync_mode, conflict_policy,
            max_delay_seconds, role_type, copy_visual, copy_permissions_mode, note, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(link_id, source_role_id, target_role_id) DO UPDATE SET
            enabled = excluded.enabled,
            sync_mode = excluded.sync_mode,
            conflict_policy = excluded.conflict_policy,
            max_delay_seconds = excluded.max_delay_seconds,
            role_type = excluded.role_type,
            copy_visual = excluded.copy_visual,
            copy_permissions_mode = excluded.copy_permissions_mode,
            note = excluded.note,
            updated_at = excluded.updated_at
    `);

    stmt.run(linkId, sourceRoleId, targetRoleId, enabled ? 1 : 0, syncMode, conflictPolicy, maxDelaySeconds, roleType, copyVisual ? 1 : 0, copyPermissionsMode, note, now, now);
}

function removeRoleSyncMap({ linkId, sourceRoleId, targetRoleId }) {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare(`
        DELETE FROM role_sync_map
        WHERE link_id = ?
          AND source_role_id = ?
          AND target_role_id = ?
    `);

    const result = stmt.run(linkId, sourceRoleId, targetRoleId);
    return result.changes;
}

function listRoleSyncMapByLink(linkId) {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare(`
        SELECT *
        FROM role_sync_map
        WHERE link_id = ?
        ORDER BY source_role_id ASC, target_role_id ASC
    `);
    return stmt.all(linkId);
}

function listRoleSyncMapByLinkIds(linkIds) {
    initializeRoleSyncDatabase();
    if (!Array.isArray(linkIds) || linkIds.length === 0) {
        return [];
    }

    const placeholders = linkIds.map(() => '?').join(',');
    const stmt = roleSyncDb.prepare(`
        SELECT *
        FROM role_sync_map
        WHERE link_id IN (${placeholders})
        ORDER BY link_id ASC, source_role_id ASC, target_role_id ASC
    `);

    return stmt.all(...linkIds);
}

function createConfigSnapshot({ linkId, snapshotName, snapshotJson, createdBy = null }) {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare(`
        INSERT INTO config_snapshots (link_id, snapshot_name, snapshot_json, created_by, created_at)
        VALUES (?, ?, ?, ?, ?)
    `);

    const result = stmt.run(linkId || null, snapshotName || null, snapshotJson, createdBy, nowIso());
    return result.lastInsertRowid;
}

function getConfigSnapshot(snapshotId) {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare(`
        SELECT *
        FROM config_snapshots
        WHERE snapshot_id = ?
        LIMIT 1
    `);
    const row = stmt.get(snapshotId);
    if (!row) {
        return null;
    }

    return {
        ...row,
        snapshotRows: safeJsonParse(row.snapshot_json, []),
    };
}

function listConfigSnapshots({ linkId = null, limit = 20 } = {}) {
    initializeRoleSyncDatabase();

    if (linkId) {
        const stmt = roleSyncDb.prepare(`
            SELECT snapshot_id, link_id, snapshot_name, created_by, created_at
            FROM config_snapshots
            WHERE link_id = ?
            ORDER BY snapshot_id DESC
            LIMIT ?
        `);
        return stmt.all(linkId, limit);
    }

    const stmt = roleSyncDb.prepare(`
        SELECT snapshot_id, link_id, snapshot_name, created_by, created_at
        FROM config_snapshots
        ORDER BY snapshot_id DESC
        LIMIT ?
    `);
    return stmt.all(limit);
}

function replaceRoleSyncMapForLink(linkId, rows) {
    initializeRoleSyncDatabase();

    const tx = roleSyncDb.transaction((targetLinkId, items) => {
        roleSyncDb.prepare('DELETE FROM role_sync_map WHERE link_id = ?').run(targetLinkId);

        const insertStmt = roleSyncDb.prepare(`
            INSERT INTO role_sync_map (
                link_id, source_role_id, target_role_id, enabled, sync_mode, conflict_policy,
                max_delay_seconds, role_type, copy_visual, copy_permissions_mode, note, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const row of items) {
            const now = nowIso();
            insertStmt.run(
                targetLinkId,
                row.source_role_id,
                row.target_role_id,
                row.enabled ? 1 : 0,
                row.sync_mode || 'source_to_target',
                row.conflict_policy || null,
                Number.isFinite(Number(row.max_delay_seconds)) ? Math.floor(Number(row.max_delay_seconds)) : 120,
                row.role_type || null,
                row.copy_visual ? 1 : 0,
                row.copy_permissions_mode || 'none',
                row.note || null,
                row.created_at || now,
                now,
            );
        }
    });

    tx(linkId, Array.isArray(rows) ? rows : []);
}

function parseSyncLinksFromEnv() {
    const raw = process.env.ROLE_SYNC_LINKS_JSON;
    if (!raw || !raw.trim()) {
        return [];
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        console.error('[RoleSync] ❌ ROLE_SYNC_LINKS_JSON 不是合法 JSON：', err.message);
        return [];
    }

    if (!Array.isArray(parsed)) {
        console.error('[RoleSync] ❌ ROLE_SYNC_LINKS_JSON 必须是数组。');
        return [];
    }

    return parsed
        .map((item, index) => ({
            linkId: String(item.linkId || '').trim(),
            sourceGuildId: String(item.sourceGuildId || '').trim(),
            targetGuildId: String(item.targetGuildId || '').trim(),
            enabled: item.enabled !== false,
            defaultConflictPolicy: String(item.defaultConflictPolicy || 'source_of_truth_main').trim(),
            index,
        }))
        .filter((item) => {
            const valid = item.linkId && /^\d{17,20}$/.test(item.sourceGuildId) && /^\d{17,20}$/.test(item.targetGuildId);
            if (!valid) {
                console.warn(`[RoleSync] ⚠️ 跳过无效链路配置 index=${item.index}:`, item);
            }
            return valid;
        });
}

function bootstrapSyncLinksFromEnv() {
    initializeRoleSyncDatabase();
    const links = parseSyncLinksFromEnv();
    if (links.length === 0) {
        console.log('[RoleSync] ℹ️ 未检测到 ROLE_SYNC_LINKS_JSON，角色同步链路暂未自动创建。');
        return { total: 0, applied: 0 };
    }

    const tx = roleSyncDb.transaction((items) => {
        for (const link of items) {
            upsertSyncLink(link);
        }
    });

    tx(links);
    console.log(`[RoleSync] ✅ 已根据环境变量写入 ${links.length} 条同步链路。`);
    return { total: links.length, applied: links.length };
}

function upsertGuildMemberPresence(guildId, userId, { isActive, joinedAt = null, leftAt = null }) {
    initializeRoleSyncDatabase();

    const now = nowIso();
    const stmt = roleSyncDb.prepare(`
        INSERT INTO guild_members (guild_id, user_id, is_active, joined_at, left_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET
            is_active = excluded.is_active,
            joined_at = COALESCE(guild_members.joined_at, excluded.joined_at),
            left_at = excluded.left_at,
            updated_at = excluded.updated_at
    `);

    stmt.run(guildId, userId, isActive ? 1 : 0, joinedAt, leftAt, now);
}

function upsertGuildMemberPresenceBatch(guildId, rows) {
    initializeRoleSyncDatabase();
    if (!Array.isArray(rows) || rows.length === 0) {
        return 0;
    }

    const stmt = roleSyncDb.prepare(`
        INSERT INTO guild_members (guild_id, user_id, is_active, joined_at, left_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET
            is_active = excluded.is_active,
            joined_at = COALESCE(guild_members.joined_at, excluded.joined_at),
            left_at = excluded.left_at,
            updated_at = excluded.updated_at
    `);

    const tx = roleSyncDb.transaction((items) => {
        const now = nowIso();
        let changed = 0;
        for (const item of items) {
            const userId = String(item.userId || '').trim();
            if (!userId) {
                continue;
            }
            const result = stmt.run(
                guildId,
                userId,
                item.isActive === false ? 0 : 1,
                item.joinedAt || null,
                item.leftAt || null,
                now,
            );
            changed += result.changes;
        }
        return changed;
    });

    return tx(rows);
}

function deactivateAllGuildMembers(guildId, leftAt = null) {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare(`
        UPDATE guild_members
        SET is_active = 0,
            left_at = ?,
            updated_at = ?
        WHERE guild_id = ?
          AND is_active = 1
    `);

    const result = stmt.run(leftAt || nowIso(), nowIso(), guildId);
    return result.changes;
}

function getGuildMemberPresence(guildId, userId) {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare(`
        SELECT guild_id, user_id, is_active, joined_at, left_at, updated_at
        FROM guild_members
        WHERE guild_id = ? AND user_id = ?
        LIMIT 1
    `);
    return stmt.get(guildId, userId) || null;
}

function listEligibleMemberIdsForLink(sourceGuildId, targetGuildId, limit = 100, offset = 0) {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare(`
        SELECT m1.user_id
        FROM guild_members m1
        JOIN guild_members m2 ON m1.user_id = m2.user_id
        WHERE m1.guild_id = ?
          AND m1.is_active = 1
          AND m2.guild_id = ?
          AND m2.is_active = 1
        ORDER BY m1.user_id ASC
        LIMIT ? OFFSET ?
    `);

    const rows = stmt.all(sourceGuildId, targetGuildId, Math.max(1, limit), Math.max(0, offset));
    return rows.map((row) => row.user_id);
}

function countEligibleMembersForLink(sourceGuildId, targetGuildId) {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare(`
        SELECT COUNT(1) AS count
        FROM guild_members m1
        JOIN guild_members m2 ON m1.user_id = m2.user_id
        WHERE m1.guild_id = ?
          AND m1.is_active = 1
          AND m2.guild_id = ?
          AND m2.is_active = 1
    `);

    const row = stmt.get(sourceGuildId, targetGuildId);
    return row?.count || 0;
}

function getApplicableRoleMappings(guildId, roleId) {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare(`
        SELECT
            m.map_id,
            m.link_id,
            m.source_role_id,
            m.target_role_id,
            m.enabled,
            m.sync_mode,
            COALESCE(m.conflict_policy, l.default_conflict_policy) AS conflict_policy,
            m.max_delay_seconds,
            m.role_type,
            l.source_guild_id,
            l.target_guild_id
        FROM role_sync_map m
        JOIN sync_links l ON l.link_id = m.link_id
        WHERE l.enabled = 1
          AND m.enabled = 1
          AND (
            (l.source_guild_id = ? AND m.source_role_id = ?)
            OR
            (l.target_guild_id = ? AND m.target_role_id = ?)
          )
    `);

    return stmt.all(guildId, roleId, guildId, roleId);
}

function cancelOppositePendingJobs({ linkId, targetGuildId, userId, targetRoleId, oppositeAction }) {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare(`
        UPDATE sync_jobs
        SET status = 'cancelled',
            updated_at = ?
        WHERE status = 'pending'
          AND link_id = ?
          AND target_guild_id = ?
          AND user_id = ?
          AND target_role_id = ?
          AND action = ?
    `);

    const result = stmt.run(nowIso(), linkId, targetGuildId, userId, targetRoleId, oppositeAction);
    return result.changes;
}

function enqueueSyncJob(job) {
    initializeRoleSyncDatabase();

    const dedupeKey = `${job.linkId}:${job.targetGuildId}:${job.userId}:${job.targetRoleId}:${job.action}`;
    const insertStmt = roleSyncDb.prepare(`
        INSERT INTO sync_jobs (
            dedupe_key,
            link_id,
            operation_id,
            source_guild_id,
            target_guild_id,
            user_id,
            source_role_id,
            target_role_id,
            action,
            lane,
            priority,
            status,
            attempt_count,
            max_attempts,
            not_before_ms,
            conflict_policy,
            max_delay_seconds,
            source_event,
            created_at,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?, ?)
    `);

    const oppositeAction = job.action === 'add' ? 'remove' : 'add';
    cancelOppositePendingJobs({
        linkId: job.linkId,
        targetGuildId: job.targetGuildId,
        userId: job.userId,
        targetRoleId: job.targetRoleId,
        oppositeAction,
    });

    const now = nowIso();

    const lane = job.lane || (Number.isInteger(job.maxDelaySeconds) && job.maxDelaySeconds <= 20 ? 'fast' : 'normal');

    try {
        const result = insertStmt.run(
            dedupeKey,
            job.linkId,
            job.operationId || null,
            job.sourceGuildId,
            job.targetGuildId,
            job.userId,
            job.sourceRoleId,
            job.targetRoleId,
            job.action,
            lane,
            Number.isInteger(job.priority) ? job.priority : 10,
            Number.isInteger(job.maxAttempts) ? job.maxAttempts : 3,
            Number.isInteger(job.notBeforeMs) ? job.notBeforeMs : null,
            job.conflictPolicy || null,
            Number.isInteger(job.maxDelaySeconds) ? job.maxDelaySeconds : 120,
            job.sourceEvent || 'guildMemberUpdate',
            now,
            now,
        );

        return {
            enqueued: true,
            jobId: result.lastInsertRowid,
            dedupeKey,
        };
    } catch (err) {
        if (String(err.message || '').includes('uq_sync_jobs_dedupe_active')) {
            return {
                enqueued: false,
                reason: 'duplicate_pending_or_processing',
                dedupeKey,
            };
        }
        throw err;
    }
}

function getDueSyncJobs(limit = 20) {
    initializeRoleSyncDatabase();
    const nowMs = Date.now();
    const stmt = roleSyncDb.prepare(`
        SELECT *
        FROM sync_jobs
        WHERE status = 'pending'
          AND (not_before_ms IS NULL OR not_before_ms <= ?)
        ORDER BY priority DESC, created_at ASC
        LIMIT ?
    `);
    return stmt.all(nowMs, limit);
}

function getDueSyncJobsByLane(lane, limit = 20) {
    initializeRoleSyncDatabase();
    const nowMs = Date.now();
    const stmt = roleSyncDb.prepare(`
        SELECT *
        FROM sync_jobs
        WHERE status = 'pending'
          AND lane = ?
          AND (not_before_ms IS NULL OR not_before_ms <= ?)
        ORDER BY priority DESC, created_at ASC
        LIMIT ?
    `);
    return stmt.all(lane, nowMs, limit);
}

function claimSyncJob(jobId) {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare(`
        UPDATE sync_jobs
        SET status = 'processing',
            attempt_count = attempt_count + 1,
            updated_at = ?
        WHERE job_id = ?
          AND status = 'pending'
    `);

    const result = stmt.run(nowIso(), jobId);
    return result.changes > 0;
}

function completeSyncJob(jobId, status = 'completed', lastError = null) {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare(`
        UPDATE sync_jobs
        SET status = ?,
            last_error = ?,
            updated_at = ?
        WHERE job_id = ?
    `);

    stmt.run(status, lastError, nowIso(), jobId);
}

function rescheduleSyncJob(jobId, lastError, delayMs) {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare(`
        UPDATE sync_jobs
        SET status = 'pending',
            last_error = ?,
            not_before_ms = ?,
            updated_at = ?
        WHERE job_id = ?
    `);

    stmt.run(lastError || null, Date.now() + Math.max(0, delayMs), nowIso(), jobId);
}

function addOperationMark({ guildId, userId, roleId, action, ttlMs = 30000 }) {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare(`
        INSERT INTO sync_operation_marks (guild_id, user_id, role_id, action, expires_at_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(guildId, userId, roleId, action, Date.now() + ttlMs, nowIso());
}

function consumeOperationMark({ guildId, userId, roleId, action }) {
    initializeRoleSyncDatabase();

    const selectStmt = roleSyncDb.prepare(`
        SELECT mark_id
        FROM sync_operation_marks
        WHERE guild_id = ?
          AND user_id = ?
          AND role_id = ?
          AND action = ?
          AND expires_at_ms > ?
        ORDER BY expires_at_ms ASC
        LIMIT 1
    `);

    const row = selectStmt.get(guildId, userId, roleId, action, Date.now());
    if (!row) {
        return false;
    }

    const deleteStmt = roleSyncDb.prepare('DELETE FROM sync_operation_marks WHERE mark_id = ?');
    deleteStmt.run(row.mark_id);
    return true;
}

function pruneExpiredOperationMarks() {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare('DELETE FROM sync_operation_marks WHERE expires_at_ms <= ?');
    const result = stmt.run(Date.now());
    return result.changes;
}

function logRoleChange(log) {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare(`
        INSERT INTO role_change_log (
            operation_id,
            job_id,
            link_id,
            source_event,
            source_guild_id,
            target_guild_id,
            user_id,
            source_role_id,
            target_role_id,
            action,
            result,
            error_message,
            created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
        log.operationId || null,
        log.jobId || null,
        log.linkId || null,
        log.sourceEvent || null,
        log.sourceGuildId || null,
        log.targetGuildId || null,
        log.userId || null,
        log.sourceRoleId || null,
        log.targetRoleId || null,
        log.action || null,
        log.result,
        log.errorMessage || null,
        nowIso(),
    );
}

function pruneOldChangeLogs(days = 90) {
    initializeRoleSyncDatabase();
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const cutoffIso = new Date(cutoff).toISOString();

    const stmt = roleSyncDb.prepare('DELETE FROM role_change_log WHERE created_at < ?');
    const result = stmt.run(cutoffIso);
    return result.changes;
}

function getSyncJobCountByStatus() {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare(`
        SELECT status, COUNT(1) AS count
        FROM sync_jobs
        GROUP BY status
    `);

    const rows = stmt.all();
    const stats = { pending: 0, processing: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const row of rows) {
        stats[row.status] = row.count;
    }
    return stats;
}

function createConfigImportJob({ jobId, guildId, fileName, parsedRows, validRows, invalidRows, errors, createdBy }) {
    initializeRoleSyncDatabase();
    const now = nowIso();
    const stmt = roleSyncDb.prepare(`
        INSERT INTO config_import_jobs (
            job_id, guild_id, file_name, status, parsed_json,
            total_rows, valid_rows, invalid_rows,
            error_json, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, 'imported', ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
        jobId,
        guildId,
        fileName || null,
        JSON.stringify(parsedRows || []),
        Array.isArray(parsedRows) ? parsedRows.length : 0,
        validRows || 0,
        invalidRows || 0,
        JSON.stringify(errors || []),
        createdBy || null,
        now,
        now,
    );
}

function getConfigImportJob(jobId) {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare('SELECT * FROM config_import_jobs WHERE job_id = ? LIMIT 1');
    const row = stmt.get(jobId);
    if (!row) {
        return null;
    }

    return {
        ...row,
        parsedRows: safeJsonParse(row.parsed_json, []),
        preview: safeJsonParse(row.preview_json, null),
        applyResult: safeJsonParse(row.apply_result_json, null),
        errors: safeJsonParse(row.error_json, []),
    };
}

function updateConfigImportJobPreview(jobId, preview) {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare(`
        UPDATE config_import_jobs
        SET status = 'previewed',
            preview_json = ?,
            updated_at = ?
        WHERE job_id = ?
    `);

    stmt.run(JSON.stringify(preview || {}), nowIso(), jobId);
}

function markConfigImportJobApplied(jobId, applyResult) {
    initializeRoleSyncDatabase();
    const now = nowIso();
    const stmt = roleSyncDb.prepare(`
        UPDATE config_import_jobs
        SET status = 'applied',
            apply_result_json = ?,
            applied_at = ?,
            updated_at = ?
        WHERE job_id = ?
    `);

    stmt.run(JSON.stringify(applyResult || {}), now, now, jobId);
}

function markConfigImportJobFailed(jobId, errorText) {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare(`
        UPDATE config_import_jobs
        SET status = 'failed',
            error_json = ?,
            updated_at = ?
        WHERE job_id = ?
    `);

    stmt.run(JSON.stringify([{ message: errorText, at: nowIso() }]), nowIso(), jobId);
}

function listRecentConfigImportJobs(limit = 10) {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare(`
        SELECT job_id, guild_id, file_name, status, total_rows, valid_rows, invalid_rows, created_by, created_at, updated_at, applied_at
        FROM config_import_jobs
        ORDER BY created_at DESC
        LIMIT ?
    `);

    return stmt.all(limit);
}

function getSyncJobCountByLane() {
    initializeRoleSyncDatabase();
    const stmt = roleSyncDb.prepare(`
        SELECT lane, status, COUNT(1) AS count
        FROM sync_jobs
        GROUP BY lane, status
    `);

    const rows = stmt.all();
    const result = {
        fast: { pending: 0, processing: 0, completed: 0, failed: 0, cancelled: 0 },
        normal: { pending: 0, processing: 0, completed: 0, failed: 0, cancelled: 0 },
    };

    for (const row of rows) {
        const lane = row.lane === 'fast' ? 'fast' : 'normal';
        if (result[lane][row.status] === undefined) {
            result[lane][row.status] = 0;
        }
        result[lane][row.status] = row.count;
    }

    return result;
}

module.exports = {
    getRoleSyncDb,
    initializeRoleSyncDatabase,
    bootstrapSyncLinksFromEnv,
    updateSyncLinkEnabled,
    upsertGuild,
    upsertSyncLink,
    getSyncLinkById,
    listSyncLinks,
    upsertRoleSyncMap,
    removeRoleSyncMap,
    replaceRoleSyncMapForLink,
    listRoleSyncMapByLink,
    listRoleSyncMapByLinkIds,
    createConfigSnapshot,
    getConfigSnapshot,
    listConfigSnapshots,
    upsertGuildMemberPresence,
    upsertGuildMemberPresenceBatch,
    deactivateAllGuildMembers,
    getGuildMemberPresence,
    listEligibleMemberIdsForLink,
    countEligibleMembersForLink,
    getApplicableRoleMappings,
    enqueueSyncJob,
    getDueSyncJobs,
    getDueSyncJobsByLane,
    claimSyncJob,
    completeSyncJob,
    rescheduleSyncJob,
    addOperationMark,
    consumeOperationMark,
    pruneExpiredOperationMarks,
    createConfigImportJob,
    getConfigImportJob,
    updateConfigImportJobPreview,
    markConfigImportJobApplied,
    markConfigImportJobFailed,
    listRecentConfigImportJobs,
    logRoleChange,
    pruneOldChangeLogs,
    getSyncJobCountByStatus,
    getSyncJobCountByLane,
};
