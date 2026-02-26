const { getRoleSyncDb } = require('../utils/roleSyncDatabase');

const DEFAULT_PAGE_SIZE = 50;

function queryMembers({ guildId, isActive, userId, page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
    const db = getRoleSyncDb();
    const conditions = [];
    const params = {};

    if (guildId) {
        conditions.push('gm.guild_id = :guildId');
        params.guildId = guildId;
    }
    if (isActive !== undefined && isActive !== null && isActive !== '') {
        conditions.push('gm.is_active = :isActive');
        params.isActive = parseInt(isActive);
    }
    if (userId) {
        conditions.push('gm.user_id LIKE :userId');
        params.userId = `%${userId}%`;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    const countRow = db.prepare(`SELECT COUNT(1) AS total FROM guild_members gm ${where}`).get(params);
    // First paginate, then LEFT JOIN aggregated stats — avoids N*3 correlated subqueries
    const rows = db.prepare(`
        WITH page AS (
            SELECT gm.*, g.guild_name
            FROM guild_members gm
            LEFT JOIN guilds g ON gm.guild_id = g.guild_id
            ${where}
            ORDER BY gm.guild_id, gm.user_id
            LIMIT :limit OFFSET :offset
        ),
        stats AS (
            SELECT rcl.user_id,
                SUM(CASE WHEN rcl.result = 'success' THEN 1 ELSE 0 END) AS sync_success_count,
                SUM(CASE WHEN rcl.result = 'failed' THEN 1 ELSE 0 END) AS sync_fail_count,
                MAX(rcl.created_at) AS last_sync_at
            FROM role_change_log rcl
            WHERE rcl.user_id IN (SELECT DISTINCT user_id FROM page)
            GROUP BY rcl.user_id
        )
        SELECT page.*, COALESCE(stats.sync_success_count, 0) AS sync_success_count,
            COALESCE(stats.sync_fail_count, 0) AS sync_fail_count,
            stats.last_sync_at
        FROM page
        LEFT JOIN stats ON page.user_id = stats.user_id
        ORDER BY page.guild_id, page.user_id
    `).all({ ...params, limit: pageSize, offset: offset });

    return { rows, total: countRow.total, page, pageSize };
}

function getOverviewStats() {
    const db = getRoleSyncDb();

    const guildStats = db.prepare(`
        SELECT g.guild_id, g.guild_name,
            COUNT(gm.user_id) AS total_members,
            SUM(CASE WHEN gm.is_active = 1 THEN 1 ELSE 0 END) AS active_members,
            SUM(CASE WHEN gm.is_active = 0 THEN 1 ELSE 0 END) AS inactive_members
        FROM guilds g
        LEFT JOIN guild_members gm ON g.guild_id = gm.guild_id
        GROUP BY g.guild_id
    `).all();

    const links = db.prepare(`
        SELECT sl.*, sg.guild_name AS source_guild_name, tg.guild_name AS target_guild_name
        FROM sync_links sl
        LEFT JOIN guilds sg ON sl.source_guild_id = sg.guild_id
        LEFT JOIN guilds tg ON sl.target_guild_id = tg.guild_id
    `).all();

    // Intersection counts per link
    const intersectionCounts = [];
    for (const link of links) {
        const row = db.prepare(`
            SELECT COUNT(1) AS intersection_count
            FROM guild_members m1
            JOIN guild_members m2 ON m1.user_id = m2.user_id
            WHERE m1.guild_id = ? AND m1.is_active = 1
              AND m2.guild_id = ? AND m2.is_active = 1
        `).get(link.source_guild_id, link.target_guild_id);
        intersectionCounts.push({
            link_id: link.link_id,
            source_guild_name: link.source_guild_name,
            target_guild_name: link.target_guild_name,
            count: row.intersection_count,
        });
    }

    // Job queue stats
    const jobStats = db.prepare(`
        SELECT status, COUNT(1) AS count FROM sync_jobs GROUP BY status
    `).all();

    const laneStats = db.prepare(`
        SELECT lane, status, COUNT(1) AS count FROM sync_jobs WHERE status IN ('pending', 'processing') GROUP BY lane, status
    `).all();

    return { guildStats, links, intersectionCounts, jobStats, laneStats };
}

function queryJobs({ status, lane, linkId, userId, page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
    const db = getRoleSyncDb();
    const conditions = [];
    const params = {};

    if (status) {
        conditions.push('sj.status = :status');
        params.status = status;
    }
    if (lane) {
        conditions.push('sj.lane = :lane');
        params.lane = lane;
    }
    if (linkId) {
        conditions.push('sj.link_id = :linkId');
        params.linkId = linkId;
    }
    if (userId) {
        conditions.push('sj.user_id LIKE :userId');
        params.userId = `%${userId}%`;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    const countRow = db.prepare(`SELECT COUNT(1) AS total FROM sync_jobs sj ${where}`).get(params);
    const rows = db.prepare(`SELECT sj.* FROM sync_jobs sj ${where} ORDER BY sj.created_at DESC LIMIT :limit OFFSET :offset`).all({ ...params, limit: pageSize, offset: offset });

    return { rows, total: countRow.total, page, pageSize };
}

function queryChangeLogs({ userId, linkId, result, action, timeFrom, timeTo, page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
    const db = getRoleSyncDb();
    const conditions = [];
    const params = {};

    if (userId) {
        conditions.push('rcl.user_id LIKE :userId');
        params.userId = `%${userId}%`;
    }
    if (linkId) {
        conditions.push('rcl.link_id = :linkId');
        params.linkId = linkId;
    }
    if (result) {
        conditions.push('rcl.result = :result');
        params.result = result;
    }
    if (action) {
        conditions.push('rcl.action = :action');
        params.action = action;
    }
    if (timeFrom) {
        conditions.push('rcl.created_at >= :timeFrom');
        params.timeFrom = timeFrom;
    }
    if (timeTo) {
        conditions.push('rcl.created_at <= :timeTo');
        params.timeTo = timeTo;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    const countRow = db.prepare(`SELECT COUNT(1) AS total FROM role_change_log rcl ${where}`).get(params);
    const rows = db.prepare(`SELECT rcl.* FROM role_change_log rcl ${where} ORDER BY rcl.created_at DESC LIMIT :limit OFFSET :offset`).all({ ...params, limit: pageSize, offset: offset });

    return { rows, total: countRow.total, page, pageSize };
}

function queryConfig() {
    const db = getRoleSyncDb();

    const links = db.prepare(`
        SELECT sl.*, sg.guild_name AS source_guild_name, tg.guild_name AS target_guild_name
        FROM sync_links sl
        LEFT JOIN guilds sg ON sl.source_guild_id = sg.guild_id
        LEFT JOIN guilds tg ON sl.target_guild_id = tg.guild_id
    `).all();

    const roleMaps = db.prepare(`SELECT * FROM role_sync_map ORDER BY link_id, map_id`).all();

    return { links, roleMaps };
}

function getGuildList() {
    const db = getRoleSyncDb();
    return db.prepare(`
        SELECT DISTINCT g.guild_id, g.guild_name
        FROM guilds g
        WHERE g.guild_id IN (
            SELECT source_guild_id FROM sync_links
            UNION
            SELECT target_guild_id FROM sync_links
        )
        ORDER BY g.guild_name
    `).all();
}

function getLinkList() {
    const db = getRoleSyncDb();
    return db.prepare(`
        SELECT sl.link_id, sg.guild_name AS source_guild_name, tg.guild_name AS target_guild_name
        FROM sync_links sl
        LEFT JOIN guilds sg ON sl.source_guild_id = sg.guild_id
        LEFT JOIN guilds tg ON sl.target_guild_id = tg.guild_id
    `).all();
}

function* iterateMembers({ guildId, isActive } = {}) {
    const db = getRoleSyncDb();
    const conditions = [];
    const params = {};

    if (guildId) {
        conditions.push('gm.guild_id = :guildId');
        params.guildId = guildId;
    }
    if (isActive !== undefined && isActive !== null && isActive !== '') {
        conditions.push('gm.is_active = :isActive');
        params.isActive = parseInt(isActive);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const stmt = db.prepare(`SELECT gm.*, g.guild_name FROM guild_members gm LEFT JOIN guilds g ON gm.guild_id = g.guild_id ${where} ORDER BY gm.guild_id, gm.user_id`);

    for (const row of stmt.iterate(params)) {
        yield row;
    }
}

function getMemberPresenceAll(userId) {
    const db = getRoleSyncDb();
    return db.prepare(`
        SELECT gm.*, g.guild_name
        FROM guild_members gm
        LEFT JOIN guilds g ON gm.guild_id = g.guild_id
        WHERE gm.user_id = ?
    `).all(userId);
}

function getMemberSyncHistory(userId, page = 1, pageSize = DEFAULT_PAGE_SIZE) {
    const db = getRoleSyncDb();
    const offset = (page - 1) * pageSize;
    const countRow = db.prepare(`SELECT COUNT(1) AS total FROM role_change_log WHERE user_id = ?`).get(userId);
    const rows = db.prepare(`
        SELECT rcl.*,
            sg.guild_name AS source_guild_name,
            tg.guild_name AS target_guild_name
        FROM role_change_log rcl
        LEFT JOIN sync_links sl ON rcl.link_id = sl.link_id
        LEFT JOIN guilds sg ON sl.source_guild_id = sg.guild_id
        LEFT JOIN guilds tg ON sl.target_guild_id = tg.guild_id
        WHERE rcl.user_id = ?
        ORDER BY rcl.created_at DESC
        LIMIT ? OFFSET ?
    `).all(userId, pageSize, offset);
    return { rows, total: countRow.total, page, pageSize };
}

function getMemberRoleMappings(userId) {
    const db = getRoleSyncDb();
    return db.prepare(`
        SELECT DISTINCT
            rsm.map_id,
            rsm.source_role_id,
            rsm.target_role_id,
            rsm.sync_mode,
            rsm.enabled,
            COALESCE(rsm.conflict_policy, sl.default_conflict_policy) AS conflict_policy,
            rsm.max_delay_seconds,
            rsm.role_type,
            sl.source_guild_id,
            sl.target_guild_id,
            sg.guild_name AS source_guild_name,
            tg.guild_name AS target_guild_name
        FROM guild_members gm1
        JOIN guild_members gm2 ON gm1.user_id = gm2.user_id
        JOIN sync_links sl ON (
            (sl.source_guild_id = gm1.guild_id AND sl.target_guild_id = gm2.guild_id)
            OR
            (sl.source_guild_id = gm2.guild_id AND sl.target_guild_id = gm1.guild_id)
        )
        JOIN role_sync_map rsm ON rsm.link_id = sl.link_id AND rsm.enabled = 1
        LEFT JOIN guilds sg ON sl.source_guild_id = sg.guild_id
        LEFT JOIN guilds tg ON sl.target_guild_id = tg.guild_id
        WHERE gm1.user_id = ?
          AND gm1.guild_id != gm2.guild_id
          AND sl.enabled = 1
        ORDER BY rsm.map_id
    `).all(userId);
}

function getRoleSyncMapById(mapId) {
    const db = getRoleSyncDb();
    return db.prepare(`SELECT * FROM role_sync_map WHERE map_id = ?`).get(mapId) || null;
}

module.exports = {
    queryMembers,
    getOverviewStats,
    queryJobs,
    queryChangeLogs,
    queryConfig,
    getGuildList,
    getLinkList,
    iterateMembers,
    getMemberPresenceAll,
    getMemberSyncHistory,
    getMemberRoleMappings,
    getRoleSyncMapById,
};
