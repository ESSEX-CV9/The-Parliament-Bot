const { Router } = require('express');
const { queryMembers, getGuildList, iterateMembers, getMemberPresenceAll, getMemberSyncHistory, getMemberRoleMappings } = require('../queries');
const { layout, pagination, escapeHtml, statusBadge } = require('../views/layout');
const { t, getLang } = require('../views/i18n');
const { updateGuildMemberRoles } = require('../../utils/roleSyncDatabase');

// Username cache: userId -> { username, fetchedAt }
const usernameCache = new Map();
const USERNAME_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function resolveUsername(client, userId) {
    const cached = usernameCache.get(userId);
    if (cached && Date.now() - cached.fetchedAt < USERNAME_CACHE_TTL) {
        return cached.username;
    }
    try {
        const user = await client.users.fetch(userId, { force: false });
        const username = user.globalName || user.username;
        usernameCache.set(userId, { username, fetchedAt: Date.now() });
        return username;
    } catch {
        return null;
    }
}

// Role name cache: "guildId:roleId" -> { name, fetchedAt }
const roleNameCache = new Map();
const ROLE_NAME_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function resolveRoleName(client, guildId, roleId) {
    const key = `${guildId}:${roleId}`;
    const cached = roleNameCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < ROLE_NAME_CACHE_TTL) {
        return cached.name;
    }
    try {
        const guild = await client.guilds.fetch(guildId);
        const role = await guild.roles.fetch(roleId);
        const name = role ? role.name : null;
        roleNameCache.set(key, { name, fetchedAt: Date.now() });
        return name;
    } catch {
        return null;
    }
}

// Member roles cache: "guildId:userId" -> { roles, fetchedAt }
const memberRolesCache = new Map();
const MEMBER_ROLES_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchMemberGuildRoles(client, guildId, userId) {
    const key = `${guildId}:${userId}`;
    const cached = memberRolesCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < MEMBER_ROLES_CACHE_TTL) {
        return cached.roles;
    }
    try {
        const guild = await client.guilds.fetch(guildId);
        const member = await guild.members.fetch(userId);
        const roles = member.roles.cache
            .filter(r => r.id !== guildId) // exclude @everyone
            .sort((a, b) => b.position - a.position) // highest position first
            .map(r => ({
                id: r.id,
                name: r.name,
                color: r.hexColor !== '#000000' ? r.hexColor : null,
            }));
        memberRolesCache.set(key, { roles, fetchedAt: Date.now() });
        return roles;
    } catch {
        return null;
    }
}

// Role info cache: "guildId:roleId" -> { name, color, fetchedAt }
const roleInfoCache = new Map();
const ROLE_INFO_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function resolveRoleInfo(client, guildId, roleId) {
    const key = `${guildId}:${roleId}`;
    const cached = roleInfoCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < ROLE_INFO_CACHE_TTL) {
        return cached;
    }
    try {
        const guild = await client.guilds.fetch(guildId);
        const role = await guild.roles.fetch(roleId);
        const info = {
            name: role ? role.name : null,
            color: role && role.hexColor !== '#000000' ? role.hexColor : null,
            fetchedAt: Date.now(),
        };
        roleInfoCache.set(key, info);
        // Also populate roleNameCache for backward compatibility
        if (role) {
            roleNameCache.set(key, { name: role.name, fetchedAt: Date.now() });
        }
        return info;
    } catch {
        return { name: null, color: null, fetchedAt: Date.now() };
    }
}

async function resolveRolesFromJson(client, guildId, rolesJsonStr) {
    if (!rolesJsonStr) return null;
    let roleIds;
    try { roleIds = JSON.parse(rolesJsonStr); } catch { return null; }
    if (!Array.isArray(roleIds) || roleIds.length === 0) return [];

    const results = await Promise.all(
        roleIds.map(async (roleId) => {
            const info = await resolveRoleInfo(client, guildId, roleId);
            return { id: roleId, name: info.name || roleId, color: info.color };
        })
    );
    return results;
}

// Batch resolve role names, returns Map<"guildId:roleId", string>
async function batchResolveRoleNames(client, pairs) {
    const roleNameMap = new Map();
    await Promise.all(
        pairs.map(async ({ guildId, roleId }) => {
            const name = await resolveRoleName(client, guildId, roleId);
            if (name) roleNameMap.set(`${guildId}:${roleId}`, name);
        })
    );
    return roleNameMap;
}

// Format role display: name with ID below, or just ID
function formatRole(roleNameMap, guildId, roleId) {
    if (!roleId) return '-';
    const name = roleNameMap.get(`${guildId}:${roleId}`);
    if (name) {
        return `<span class="username">${escapeHtml(name)}</span><span class="user-id">${escapeHtml(roleId)}</span>`;
    }
    return `<span class="mono"><small>${escapeHtml(roleId)}</small></span>`;
}

module.exports = function createMembersRouter(client) {
    const router = Router();

    router.get('/members', async (req, res) => {
        const lang = getLang(req);
        const page = parseInt(req.query.page) || 1;
        const guildId = req.query.guild || null;
        const isActive = req.query.active !== undefined && req.query.active !== '' ? req.query.active : null;
        const userId = req.query.search || null;

        const result = queryMembers({ guildId, isActive, userId, page });
        const guilds = getGuildList();

        // Batch-resolve usernames for this page's users
        const uniqueUserIds = [...new Set(result.rows.map(r => r.user_id))];
        const usernameMap = new Map();
        await Promise.all(
            uniqueUserIds.map(async (uid) => {
                const name = await resolveUsername(client, uid);
                if (name) usernameMap.set(uid, name);
            })
        );

        let html = `<h2>${t(lang, 'members_title')}</h2>`;

        // Filters
        html += `<form class="filters" method="get" action="/members">
            <input type="hidden" name="lang" value="${escapeHtml(lang)}">
            <label>${t(lang, 'filter_guild')}:
                <select name="guild">
                    <option value="">${t(lang, 'filter_all')}</option>
                    ${guilds.map(g => `<option value="${escapeHtml(g.guild_id)}" ${g.guild_id === guildId ? 'selected' : ''}>${escapeHtml(g.guild_name || g.guild_id)}</option>`).join('')}
                </select>
            </label>
            <label>${t(lang, 'filter_status')}:
                <select name="active">
                    <option value="">${t(lang, 'filter_all')}</option>
                    <option value="1" ${isActive === '1' ? 'selected' : ''}>${t(lang, 'filter_active')}</option>
                    <option value="0" ${isActive === '0' ? 'selected' : ''}>${t(lang, 'filter_left')}</option>
                </select>
            </label>
            <label>${t(lang, 'filter_user_id')}:
                <input type="text" name="search" value="${escapeHtml(userId || '')}" placeholder="${t(lang, 'search_placeholder')}">
            </label>
            <button type="submit">${t(lang, 'btn_filter')}</button>
            <a href="/members?lang=${lang}" role="button" class="outline">${t(lang, 'btn_clear')}</a>
            <a href="/members/export?guild=${encodeURIComponent(guildId || '')}&active=${encodeURIComponent(isActive || '')}&search=${encodeURIComponent(userId || '')}" class="export-link" role="button" class="outline secondary">${t(lang, 'export_csv')}</a>
        </form>`;

        html += `<p><small>${t(lang, 'total_records', result.total)}</small></p>`;

        // Table
        html += `<table>
            <thead><tr>
                <th style="width:2.5rem"></th>
                <th>${t(lang, 'col_guild')}</th>
                <th>${t(lang, 'col_user')}</th>
                <th>${t(lang, 'col_active')}</th>
                <th>${t(lang, 'col_sync_stats')}</th>
                <th>${t(lang, 'col_actions')}</th>
            </tr></thead><tbody>`;

        for (const row of result.rows) {
            const syncStats = [];
            if (row.sync_success_count > 0) syncStats.push(`<span class="badge badge-success">${t(lang, 'sync_ok')}: ${row.sync_success_count}</span>`);
            if (row.sync_fail_count > 0) syncStats.push(`<span class="badge badge-danger">${t(lang, 'sync_fail')}: ${row.sync_fail_count}</span>`);
            if (row.last_sync_at) syncStats.push(`<small>${t(lang, 'sync_last')}: ${escapeHtml(row.last_sync_at)}</small>`);
            const syncHtml = syncStats.length > 0 ? syncStats.join(' ') : '-';

            const username = usernameMap.get(row.user_id);
            const userDisplay = username
                ? `<span class="username">${escapeHtml(username)}</span><span class="user-id">${escapeHtml(row.user_id)}</span>`
                : `<span class="user-id">${escapeHtml(row.user_id)}</span>`;

            let statusHtml;
            if (row.is_active) {
                statusHtml = `<span class="badge badge-success">${t(lang, 'badge_active')}</span>`;
            } else {
                statusHtml = `<span class="badge badge-secondary">${t(lang, 'badge_left')}</span>`;
                if (row.left_at) {
                    statusHtml += `<span class="left-date">${escapeHtml(row.left_at)}</span>`;
                }
            }

            html += `<tr>
                <td><button class="expand-toggle" onclick="toggleDetail(this, '${escapeHtml(row.user_id)}', '${escapeHtml(lang)}')" title="${t(lang, 'btn_expand')}">+</button></td>
                <td>${escapeHtml(row.guild_name || row.guild_id)}</td>
                <td class="user-cell">${userDisplay}</td>
                <td class="status-cell">${statusHtml}</td>
                <td>${syncHtml}</td>
                <td><a href="/members/${encodeURIComponent(row.user_id)}?lang=${lang}" class="btn-small">${t(lang, 'btn_details')}</a></td>
            </tr>`;
        }

        html += '</tbody></table>';
        html += pagination(page, result.total, result.pageSize, req.originalUrl, lang);

        res.send(layout(t(lang, 'members_title'), html, req.session.user, lang, req.originalUrl));
    });

    router.get('/members/export', (req, res) => {
        const guildId = req.query.guild || null;
        const isActive = req.query.active !== undefined && req.query.active !== '' ? req.query.active : null;

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="members_export_${Date.now()}.csv"`);

        // Write BOM for Excel compatibility
        res.write('\ufeff');
        res.write('guild_id,guild_name,user_id,is_active,joined_at,left_at,updated_at\n');

        for (const row of iterateMembers({ guildId, isActive })) {
            const line = [
                row.guild_id,
                `"${(row.guild_name || '').replace(/"/g, '""')}"`,
                row.user_id,
                row.is_active,
                row.joined_at || '',
                row.left_at || '',
                row.updated_at || '',
            ].join(',');
            res.write(line + '\n');
        }

        res.end();
    });

    // Member detail page
    router.get('/members/:userId', async (req, res) => {
        const lang = getLang(req);
        const userId = req.params.userId;
        const page = parseInt(req.query.page) || 1;

        // Resolve username (async, cached)
        const username = await resolveUsername(client, userId);

        // Get all guild presences for this user
        const presences = getMemberPresenceAll(userId);

        // Get full sync history (paginated)
        const history = getMemberSyncHistory(userId, page);

        // Batch resolve role names for this page's history
        const rolePairs = [];
        for (const row of history.rows) {
            if (row.source_role_id && row.source_guild_id) rolePairs.push({ guildId: row.source_guild_id, roleId: row.source_role_id });
            if (row.target_role_id && row.target_guild_id) rolePairs.push({ guildId: row.target_guild_id, roleId: row.target_role_id });
        }
        const roleNameMap = await batchResolveRoleNames(client, rolePairs);

        let html = `<h2>${t(lang, 'member_detail_title')}: <span class="mono">${escapeHtml(userId)}</span></h2>`;
        if (username) {
            html += `<p>${t(lang, 'discord_username')}: <strong>${escapeHtml(username)}</strong></p>`;
        }

        // Guild presence table
        html += `<h3>${t(lang, 'guild_presence_section')}</h3>`;
        if (presences.length > 0) {
            html += `<table>
                <thead><tr>
                    <th>${t(lang, 'col_guild')}</th><th>${t(lang, 'col_active')}</th>
                    <th>${t(lang, 'col_joined_at')}</th><th>${t(lang, 'col_left_at')}</th><th>${t(lang, 'col_updated_at')}</th>
                </tr></thead><tbody>`;
            for (const p of presences) {
                html += `<tr>
                    <td>${escapeHtml(p.guild_name || p.guild_id)}</td>
                    <td>${p.is_active ? `<span class="badge badge-success">${t(lang, 'badge_active')}</span>` : `<span class="badge badge-secondary">${t(lang, 'badge_left')}</span>`}</td>
                    <td><small>${escapeHtml(p.joined_at || '-')}</small></td>
                    <td><small>${escapeHtml(p.left_at || '-')}</small></td>
                    <td><small>${escapeHtml(p.updated_at || '-')}</small></td>
                </tr>`;
            }
            html += '</tbody></table>';
        } else {
            html += `<p><small>-</small></p>`;
        }

        // Sync history table
        html += `<h3>${t(lang, 'sync_history_section')}</h3>`;
        if (history.rows.length > 0) {
            html += `<p><small>${t(lang, 'total_records', history.total)}</small></p>`;
            html += `<table>
                <thead><tr>
                    <th>${t(lang, 'col_id')}</th><th>${t(lang, 'col_action')}</th><th>${t(lang, 'col_result')}</th>
                    <th>${t(lang, 'col_source_role')}</th><th>${t(lang, 'col_target_role')}</th>
                    <th>${t(lang, 'col_source_guild')}</th><th>${t(lang, 'col_target_guild')}</th>
                    <th>${t(lang, 'col_event')}</th><th>${t(lang, 'col_error')}</th><th>${t(lang, 'col_time')}</th>
                </tr></thead><tbody>`;
            for (const row of history.rows) {
                html += `<tr>
                    <td>${row.log_id}</td>
                    <td>${escapeHtml(row.action)}</td>
                    <td>${statusBadge(row.result, lang)}</td>
                    <td class="user-cell">${formatRole(roleNameMap, row.source_guild_id, row.source_role_id)}</td>
                    <td class="user-cell">${formatRole(roleNameMap, row.target_guild_id, row.target_role_id)}</td>
                    <td><small>${escapeHtml(row.source_guild_name || '-')}</small></td>
                    <td><small>${escapeHtml(row.target_guild_name || '-')}</small></td>
                    <td><small>${escapeHtml(row.source_event || '-')}</small></td>
                    <td><small>${escapeHtml(row.error_message || '-')}</small></td>
                    <td><small>${escapeHtml(row.created_at)}</small></td>
                </tr>`;
            }
            html += '</tbody></table>';
            html += pagination(page, history.total, history.pageSize, req.originalUrl, lang);
        } else {
            html += `<p><small>${t(lang, 'no_sync_history')}</small></p>`;
        }

        html += `<p><a href="/members?lang=${lang}">&larr; ${t(lang, 'back_to_members')}</a></p>`;

        res.send(layout(t(lang, 'member_detail_title'), html, req.session.user, lang, req.originalUrl));
    });

    // Inline detail fragment for expandable rows (AJAX endpoint)
    router.get('/members/:userId/inline', async (req, res) => {
        const lang = getLang(req);
        const userId = req.params.userId;
        const forceRefresh = req.query.refresh === '1';

        try {
            const presences = getMemberPresenceAll(userId);
            const history = getMemberSyncHistory(userId, 1, 5);
            const roleMappings = getMemberRoleMappings(userId);

            const activeGuilds = presences.filter(p => p.is_active);
            const guildRolesMap = new Map();

            if (forceRefresh) {
                // Refresh: fetch from Discord API, update DB
                await Promise.all(
                    activeGuilds.map(async (p) => {
                        const roles = await fetchMemberGuildRoles(client, p.guild_id, userId);
                        if (roles) {
                            guildRolesMap.set(p.guild_id, roles);
                            const rolesJson = JSON.stringify(roles.map(r => r.id).sort());
                            updateGuildMemberRoles(p.guild_id, userId, rolesJson);
                        }
                    })
                );
            } else {
                // Default: read from DB first, fallback to API
                await Promise.all(
                    activeGuilds.map(async (p) => {
                        if (p.roles_json) {
                            const roles = await resolveRolesFromJson(client, p.guild_id, p.roles_json);
                            if (roles) {
                                guildRolesMap.set(p.guild_id, roles);
                                return;
                            }
                        }
                        // Fallback: DB has no roles_json, fetch from API and save
                        const roles = await fetchMemberGuildRoles(client, p.guild_id, userId);
                        if (roles) {
                            guildRolesMap.set(p.guild_id, roles);
                            const rolesJson = JSON.stringify(roles.map(r => r.id).sort());
                            updateGuildMemberRoles(p.guild_id, userId, rolesJson);
                        }
                    })
                );
            }

            // Build sync index: "guildId:roleId" -> [syncInfo, ...]
            const syncIndex = new Map();
            for (const rm of roleMappings) {
                const srcKey = `${rm.source_guild_id}:${rm.source_role_id}`;
                if (!syncIndex.has(srcKey)) syncIndex.set(srcKey, []);
                syncIndex.get(srcKey).push({
                    direction: 'source',
                    counterpartGuildId: rm.target_guild_id,
                    counterpartGuildName: rm.target_guild_name || rm.target_guild_id,
                    counterpartRoleId: rm.target_role_id,
                    syncMode: rm.sync_mode,
                    conflictPolicy: rm.conflict_policy,
                    maxDelaySeconds: rm.max_delay_seconds,
                    roleType: rm.role_type,
                });
                const tgtKey = `${rm.target_guild_id}:${rm.target_role_id}`;
                if (!syncIndex.has(tgtKey)) syncIndex.set(tgtKey, []);
                syncIndex.get(tgtKey).push({
                    direction: 'target',
                    counterpartGuildId: rm.source_guild_id,
                    counterpartGuildName: rm.source_guild_name || rm.source_guild_id,
                    counterpartRoleId: rm.source_role_id,
                    syncMode: rm.sync_mode,
                    conflictPolicy: rm.conflict_policy,
                    maxDelaySeconds: rm.max_delay_seconds,
                    roleType: rm.role_type,
                });
            }

            // Batch-resolve counterpart role names for sync details & history
            const rolePairs = [];
            for (const rm of roleMappings) {
                rolePairs.push({ guildId: rm.source_guild_id, roleId: rm.source_role_id });
                rolePairs.push({ guildId: rm.target_guild_id, roleId: rm.target_role_id });
            }
            for (const h of history.rows) {
                if (h.source_role_id && h.source_guild_id) rolePairs.push({ guildId: h.source_guild_id, roleId: h.source_role_id });
                if (h.target_role_id && h.target_guild_id) rolePairs.push({ guildId: h.target_guild_id, roleId: h.target_role_id });
            }
            const roleNameMap = await batchResolveRoleNames(client, rolePairs);

            let html = '';

            // Section 1: Guild Presences
            html += `<h4>${t(lang, 'guild_presence_section')}</h4>`;
            if (presences.length > 0) {
                html += `<table><thead><tr>
                    <th>${t(lang, 'col_guild')}</th><th>${t(lang, 'col_active')}</th>
                    <th>${t(lang, 'col_joined_at')}</th><th>${t(lang, 'col_left_at')}</th><th>${t(lang, 'col_updated_at')}</th>
                </tr></thead><tbody>`;
                for (const p of presences) {
                    const pStatus = p.is_active
                        ? `<span class="badge badge-success">${t(lang, 'badge_active')}</span>`
                        : `<span class="badge badge-secondary">${t(lang, 'badge_left')}</span>`;
                    html += `<tr>
                        <td>${escapeHtml(p.guild_name || p.guild_id)}</td>
                        <td>${pStatus}</td>
                        <td><small>${escapeHtml(p.joined_at || '-')}</small></td>
                        <td><small>${escapeHtml(p.left_at || '-')}</small></td>
                        <td><small>${escapeHtml(p.updated_at || '-')}</small></td>
                    </tr>`;
                }
                html += '</tbody></table>';
            } else {
                html += `<p><small>-</small></p>`;
            }

            // Section 2: Member Roles Per Guild (card-based layout)
            html += `<h4>${t(lang, 'member_roles_section')} <button class="btn-small outline" onclick="refreshRoles(this, '${escapeHtml(userId)}', '${escapeHtml(lang)}')">${t(lang, 'btn_refresh_roles')}</button></h4>`;

            if (guildRolesMap.size > 0) {
                for (const [guildId, roles] of guildRolesMap) {
                    const presence = presences.find(p => p.guild_id === guildId);
                    const guildName = escapeHtml(presence?.guild_name || guildId);

                    // Annotate each role with sync info
                    const annotatedRoles = roles.map(role => {
                        const key = `${guildId}:${role.id}`;
                        const syncInfoList = syncIndex.get(key) || [];
                        return { ...role, syncInfoList };
                    });
                    const syncedCount = annotatedRoles.filter(r => r.syncInfoList.length > 0).length;

                    html += `<div class="guild-roles-card">`;
                    html += `<div class="guild-roles-header">`;
                    html += `<strong>${guildName}</strong> `;
                    html += `<span class="badge badge-secondary">${roles.length} ${t(lang, 'roles_count_label')}</span>`;
                    if (syncedCount > 0) {
                        html += ` <span class="badge badge-info">${syncedCount} ${t(lang, 'synced_roles_label')}</span>`;
                    }
                    html += `</div>`;

                    // Role tags
                    if (roles.length > 0) {
                        html += `<div class="role-tags">`;
                        for (const role of annotatedRoles) {
                            const colorStyle = role.color ? `border-left-color: ${escapeHtml(role.color)};` : '';
                            if (role.syncInfoList.length > 0) {
                                html += `<span class="role-tag role-tag-synced" style="${colorStyle}">${escapeHtml(role.name)} &#x21C4;</span>`;
                            } else {
                                html += `<span class="role-tag" style="${colorStyle}">${escapeHtml(role.name)}</span>`;
                            }
                        }
                        html += `</div>`;
                    } else {
                        html += `<div class="role-tags"><small class="text-muted">${t(lang, 'no_roles')}</small></div>`;
                    }

                    // Sync detail lines
                    const syncedRoles = annotatedRoles.filter(r => r.syncInfoList.length > 0);
                    if (syncedRoles.length > 0) {
                        html += `<div class="role-sync-details">`;
                        for (const role of syncedRoles) {
                            for (const info of role.syncInfoList) {
                                const counterpartRoleName = roleNameMap.get(`${info.counterpartGuildId}:${info.counterpartRoleId}`) || info.counterpartRoleId;
                                let arrow;
                                if (info.syncMode === 'bidirectional') {
                                    arrow = '&#x21C4;';
                                } else if (info.direction === 'source') {
                                    arrow = '&rarr;';
                                } else {
                                    arrow = '&larr;';
                                }
                                const colorStyle = role.color ? `border-left-color: ${escapeHtml(role.color)};` : '';
                                html += `<div class="sync-detail-item">`;
                                html += `<span class="role-tag role-tag-synced role-tag-sm" style="${colorStyle}">${escapeHtml(role.name)}</span>`;
                                html += `<span class="sync-arrow">${arrow}</span>`;
                                html += `<span class="sync-target">${escapeHtml(info.counterpartGuildName)} / <strong>${escapeHtml(counterpartRoleName)}</strong></span>`;
                                html += ` <span class="badge badge-info">${escapeHtml(info.syncMode)}</span>`;
                                if (info.maxDelaySeconds) {
                                    html += ` <span class="badge badge-secondary">${info.maxDelaySeconds}s</span>`;
                                }
                                if (info.roleType) {
                                    html += ` <span class="badge badge-warning">${escapeHtml(info.roleType)}</span>`;
                                }
                                html += `</div>`;
                            }
                        }
                        html += `</div>`;
                    }

                    html += `</div>`;
                }

                // Show failed guilds (active but API fetch failed)
                for (const p of activeGuilds) {
                    if (!guildRolesMap.has(p.guild_id)) {
                        html += `<div class="guild-roles-card guild-roles-error">`;
                        html += `<strong>${escapeHtml(p.guild_name || p.guild_id)}</strong> `;
                        html += `<span class="badge badge-warning">${t(lang, 'roles_fetch_failed')}</span>`;
                        html += `</div>`;
                    }
                }
            } else if (activeGuilds.length > 0) {
                html += `<p><small class="text-muted">${t(lang, 'roles_unavailable')}</small></p>`;
            } else {
                html += `<p><small class="text-muted">${t(lang, 'roles_no_active_guild')}</small></p>`;
            }

            // Section 3: Recent Sync History (last 5)
            html += `<h4>${t(lang, 'sync_history_section')}</h4>`;
            if (history.rows.length > 0) {
                html += `<table><thead><tr>
                    <th>${t(lang, 'col_action')}</th><th>${t(lang, 'col_result')}</th>
                    <th>${t(lang, 'col_source_role')}</th><th>${t(lang, 'col_target_role')}</th>
                    <th>${t(lang, 'col_time')}</th>
                </tr></thead><tbody>`;
                for (const h of history.rows) {
                    html += `<tr>
                        <td>${escapeHtml(h.action)}</td>
                        <td>${statusBadge(h.result, lang)}</td>
                        <td class="user-cell">${formatRole(roleNameMap, h.source_guild_id, h.source_role_id)}</td>
                        <td class="user-cell">${formatRole(roleNameMap, h.target_guild_id, h.target_role_id)}</td>
                        <td><small>${escapeHtml(h.created_at)}</small></td>
                    </tr>`;
                }
                html += '</tbody></table>';
                if (history.total > 5) {
                    html += `<p><a href="/members/${encodeURIComponent(userId)}?lang=${lang}" class="btn-small">${t(lang, 'btn_view_all_history', history.total)}</a></p>`;
                }
            } else {
                html += `<p><small>${t(lang, 'no_sync_history')}</small></p>`;
            }

            res.send(html);
        } catch (err) {
            console.error('[RoleSync Dashboard] Inline detail error:', err);
            res.status(500).send('<span class="badge badge-danger">Error loading details</span>');
        }
    });

    return router;
};
