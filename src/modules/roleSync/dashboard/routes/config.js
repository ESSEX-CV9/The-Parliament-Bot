const { Router } = require('express');
const { queryConfig, getLinkList, getRoleSyncMapById, getDistinctRoleTypes } = require('../queries');
const {
    upsertRoleSyncMap,
    removeRoleSyncMap,
    updateSyncLinkEnabled,
    getRoleSnapshot,
    getRoleSyncMapById: getRoleSyncMapByIdFull,
    enableRoleSyncMapById,
    updateRoleSyncMapRoleId,
    getMembersWithRole,
    enqueueSyncJob,
    purgeOrphanMappingData,
} = require('../../utils/roleSyncDatabase');
const { layout, escapeHtml } = require('../views/layout');
const { t, getLang } = require('../views/i18n');

// --- Validation ---

const VALID_SYNC_MODES = new Set(['bidirectional', 'source_to_target', 'target_to_source', 'disabled']);
const VALID_COPY_PERM_MODES = new Set(['none', 'safe', 'strict']);
const ROLE_ID_RE = /^\d{17,20}$/;

function validateRoleMapInput({ linkId, sourceRoleId, targetRoleId, targetMode, targetRoleNameIfCreate, syncMode, copyPermissionsMode, maxDelaySeconds }, lang) {
    const errors = [];
    if (!linkId) errors.push(lang === 'zh' ? 'link_id 不能为空' : 'link_id is required');
    if (!ROLE_ID_RE.test(sourceRoleId)) errors.push(lang === 'zh' ? 'source_role_id 必须是 17-20 位数字' : 'source_role_id must be 17-20 digits');
    if (targetMode === 'create') {
        if (targetRoleNameIfCreate && targetRoleNameIfCreate.length > 100) {
            errors.push(lang === 'zh' ? '新身份组名称不能超过 100 个字符' : 'New role name must be 100 characters or less');
        }
    } else {
        if (!ROLE_ID_RE.test(targetRoleId)) errors.push(lang === 'zh' ? 'target_role_id 必须是 17-20 位数字' : 'target_role_id must be 17-20 digits');
    }
    if (!VALID_SYNC_MODES.has(syncMode)) errors.push(lang === 'zh' ? 'sync_mode 无效' : 'sync_mode is invalid');
    if (!VALID_COPY_PERM_MODES.has(copyPermissionsMode)) errors.push(lang === 'zh' ? 'copy_permissions_mode 无效' : 'copy_permissions_mode is invalid');
    const delay = parseInt(maxDelaySeconds);
    if (!Number.isFinite(delay) || delay <= 0 || delay > 3600) errors.push(lang === 'zh' ? 'max_delay_seconds 必须在 1-3600 之间' : 'max_delay_seconds must be 1-3600');
    return errors;
}

// --- CSS for enhanced form ---

function renderFormStyles() {
    return `<style>
.role-selector { position: relative; }
.role-dropdown {
    position: absolute; z-index: 10; width: 100%;
    max-height: 250px; overflow-y: auto;
    background: var(--pico-card-background-color);
    border: 1px solid var(--pico-muted-border-color);
    border-radius: 4px; margin-top: 2px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
}
.role-option {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.4rem 0.6rem; cursor: pointer; font-size: 0.85rem;
}
.role-option:hover { background: var(--pico-primary-background); color: var(--pico-primary-inverse); }
.role-option.selected { background: var(--pico-primary-focus); }
.role-color-dot {
    width: 12px; height: 12px; border-radius: 50%;
    display: inline-block; flex-shrink: 0; border: 1px solid rgba(255,255,255,0.2);
}
.role-selected {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.5rem 0.6rem; background: var(--pico-card-background-color);
    border: 1px solid var(--pico-muted-border-color); border-radius: 4px;
}
.role-selected .role-name { flex: 1; }
.role-clear {
    background: none; border: none; color: var(--pico-muted-color);
    cursor: pointer; font-size: 1.2rem; padding: 0 0.3rem; line-height: 1;
}
.role-clear:hover { color: var(--pico-del-color); }
.role-search-input { margin-bottom: 0 !important; }
.role-option-id { font-family: monospace; font-size: 0.7rem; color: var(--pico-muted-color); margin-left: auto; }
.target-mode-group { display: flex; gap: 1rem; margin-bottom: 0.5rem; }
.target-mode-group label { display: flex; align-items: center; gap: 0.3rem; cursor: pointer; margin-bottom: 0; }
.target-mode-group input[type="radio"] { margin: 0; }
.role-loading-msg { padding: 0.5rem; color: var(--pico-muted-color); font-size: 0.85rem; font-style: italic; }
.autocomplete-dropdown {
    position: absolute; z-index: 10; width: 100%;
    max-height: 180px; overflow-y: auto;
    background: var(--pico-card-background-color);
    border: 1px solid var(--pico-muted-border-color);
    border-radius: 4px; margin-top: 2px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
}
.autocomplete-option {
    padding: 0.4rem 0.6rem; cursor: pointer; font-size: 0.85rem;
}
.autocomplete-option:hover { background: var(--pico-primary-background); color: var(--pico-primary-inverse); }
.role-name-cell { display: flex; align-items: center; gap: 0.4rem; }
.role-name-cell .role-color-dot { width: 10px; height: 10px; }
</style>`;
}

// --- Form rendering helper ---

function renderRoleMapForm({ lang, row, links, action, csrfToken, errors = [], roleTypes = [] }) {
    const syncModes = ['bidirectional', 'source_to_target', 'target_to_source', 'disabled'];
    const copyPermModes = ['none', 'safe', 'strict'];
    const isEdit = action.includes('/edit');
    const targetMode = row.targetMode || 'existing';

    const errorHtml = errors.length > 0
        ? `<div class="error-box"><strong>${t(lang, 'validation_error')}:</strong><ul>${errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div>`
        : '';

    const roleTypesJson = JSON.stringify(roleTypes.map(rt => escapeHtml(rt)));

    return `
        ${renderFormStyles()}
        <h2>${t(lang, isEdit ? 'form_edit_title' : 'form_add_title')}</h2>
        ${errorHtml}
        <form method="POST" action="${escapeHtml(action)}" id="roleMapForm">
            <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
            <input type="hidden" name="lang" value="${escapeHtml(lang)}">

            <label>${t(lang, 'filter_link')}:
                <select name="linkId" id="linkSelect" ${isEdit ? 'disabled' : ''}>
                    ${links.map(l => `<option value="${escapeHtml(l.link_id)}"
                        data-source-guild="${escapeHtml(l.source_guild_id)}"
                        data-target-guild="${escapeHtml(l.target_guild_id)}"
                        ${l.link_id === (row.link_id || row.linkId) ? 'selected' : ''}>${escapeHtml(l.source_guild_name)} &rarr; ${escapeHtml(l.target_guild_name)}</option>`).join('')}
                </select>
                ${isEdit ? `<input type="hidden" name="linkId" value="${escapeHtml(row.link_id || row.linkId || '')}">` : ''}
            </label>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;">
                <div>
                    <label>${t(lang, 'col_source_role')}:</label>
                    <div class="role-selector" id="sourceRoleSelector">
                        <input type="hidden" name="sourceRoleId" value="${escapeHtml(row.source_role_id || row.sourceRoleId || '')}">
                        <div class="role-selected" style="display:none;">
                            <span class="role-color-dot"></span>
                            <span class="role-name"></span>
                            <button type="button" class="role-clear">&times;</button>
                        </div>
                        <input type="text" class="role-search-input" placeholder="${t(lang, 'role_search_placeholder')}" autocomplete="off">
                        <div class="role-dropdown" style="display:none;"></div>
                    </div>
                </div>
                <div>
                    <label>${t(lang, 'target_mode_label')}:</label>
                    <div class="target-mode-group">
                        <label>
                            <input type="radio" name="targetMode" value="existing" ${targetMode !== 'create' ? 'checked' : ''}>
                            ${t(lang, 'target_mode_existing')}
                        </label>
                        <label>
                            <input type="radio" name="targetMode" value="create" ${targetMode === 'create' ? 'checked' : ''}>
                            ${t(lang, 'target_mode_create')}
                        </label>
                    </div>
                    <div id="targetExistingContainer" style="${targetMode === 'create' ? 'display:none;' : ''}">
                        <div class="role-selector" id="targetRoleSelector">
                            <input type="hidden" name="targetRoleId" value="${escapeHtml(row.target_role_id || row.targetRoleId || '')}">
                            <div class="role-selected" style="display:none;">
                                <span class="role-color-dot"></span>
                                <span class="role-name"></span>
                                <button type="button" class="role-clear">&times;</button>
                            </div>
                            <input type="text" class="role-search-input" placeholder="${t(lang, 'role_search_placeholder')}" autocomplete="off">
                            <div class="role-dropdown" style="display:none;"></div>
                        </div>
                    </div>
                    <div id="targetCreateContainer" style="${targetMode !== 'create' ? 'display:none;' : ''}">
                        <input type="text" name="targetRoleNameIfCreate" value="${escapeHtml(row.targetRoleNameIfCreate || '')}" placeholder="${t(lang, 'target_role_name_placeholder')}">
                    </div>
                </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;">
                <label>${t(lang, 'col_sync_mode')}:
                    <select name="syncMode">
                        ${syncModes.map(m => `<option value="${m}" ${m === (row.sync_mode || row.syncMode) ? 'selected' : ''}>${m}</option>`).join('')}
                    </select>
                </label>
                <label>${t(lang, 'col_max_delay')}:
                    <input type="number" name="maxDelaySeconds" value="${escapeHtml(String(row.max_delay_seconds || row.maxDelaySeconds || 120))}" min="1" max="3600" required>
                </label>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;">
                <label>${t(lang, 'col_copy_perms')}:
                    <select name="copyPermissionsMode">
                        ${copyPermModes.map(m => `<option value="${m}" ${m === (row.copy_permissions_mode || row.copyPermissionsMode) ? 'selected' : ''}>${m}</option>`).join('')}
                    </select>
                </label>
                <div style="position:relative;">
                    <label>${t(lang, 'col_type')}:
                        <input type="text" name="roleType" id="roleTypeInput" value="${escapeHtml(row.role_type || row.roleType || '')}" placeholder="${t(lang, 'role_type_placeholder')}" autocomplete="off">
                    </label>
                    <div class="autocomplete-dropdown" id="roleTypeDropdown" style="display:none;"></div>
                </div>
            </div>

            <fieldset>
                <label>
                    <input type="checkbox" name="enabled" value="1" ${(row.enabled === 1 || row.enabled === true || row.enabled === '1' || row.enabled === 'on') ? 'checked' : ''}>
                    ${t(lang, 'col_enabled')}
                </label>
                <label>
                    <input type="checkbox" name="copyVisual" value="1" ${(row.copy_visual === 1 || row.copy_visual === true || row.copyVisual === '1' || row.copyVisual === 'on') ? 'checked' : ''}>
                    ${t(lang, 'col_copy_visual')}
                </label>
            </fieldset>

            <label>${t(lang, 'col_note')}:
                <input type="text" name="note" value="${escapeHtml(row.note || '')}">
            </label>

            <div style="display:flex;gap:0.5rem;">
                <button type="submit">${t(lang, 'btn_save')}</button>
                <a href="/config?lang=${escapeHtml(lang)}" role="button" class="outline secondary">${t(lang, 'btn_cancel')}</a>
            </div>
        </form>

        ${renderFormScript(lang, roleTypesJson)}
    `;
}

// --- Inline JS for searchable dropdowns ---

function renderFormScript(lang, roleTypesJson) {
    return `<script>
(function() {
    var rolesCache = {};
    var roleTypes = ${roleTypesJson};
    var lang = '${lang}';

    var linkSelect = document.getElementById('linkSelect');
    var sourceSelector = document.getElementById('sourceRoleSelector');
    var targetSelector = document.getElementById('targetRoleSelector');

    // --- Role selector logic ---
    function initSelector(container, guildType) {
        var hiddenInput = container.querySelector('input[type="hidden"]');
        var searchInput = container.querySelector('.role-search-input');
        var dropdown = container.querySelector('.role-dropdown');
        var selectedDiv = container.querySelector('.role-selected');
        var clearBtn = container.querySelector('.role-clear');
        var allRoles = [];

        function getGuildId() {
            var opt = linkSelect.options[linkSelect.selectedIndex];
            return opt ? opt.getAttribute('data-' + guildType + '-guild') : null;
        }

        function fetchRoles() {
            var guildId = getGuildId();
            if (!guildId) return;
            if (rolesCache[guildId]) {
                allRoles = rolesCache[guildId];
                resolveCurrentValue();
                return;
            }
            dropdown.innerHTML = '<div class="role-loading-msg">${t(lang, 'role_loading')}</div>';
            dropdown.style.display = 'block';
            fetch('/config/api/roles/' + encodeURIComponent(guildId))
                .then(function(r) { if (!r.ok) throw new Error(r.statusText); return r.json(); })
                .then(function(roles) {
                    rolesCache[guildId] = roles;
                    allRoles = roles;
                    dropdown.style.display = 'none';
                    resolveCurrentValue();
                })
                .catch(function() {
                    dropdown.innerHTML = '<div class="role-loading-msg">${t(lang, 'role_fetch_error')}</div>';
                });
        }

        function resolveCurrentValue() {
            var val = hiddenInput.value;
            if (!val) return;
            var found = allRoles.find(function(r) { return r.id === val; });
            if (found) showSelected(found);
        }

        function showSelected(role) {
            selectedDiv.querySelector('.role-color-dot').style.background = role.color || '#99aab5';
            selectedDiv.querySelector('.role-name').textContent = role.name + ' (' + role.id + ')';
            selectedDiv.style.display = 'flex';
            searchInput.style.display = 'none';
            dropdown.style.display = 'none';
            hiddenInput.value = role.id;
        }

        function clearSelection() {
            hiddenInput.value = '';
            selectedDiv.style.display = 'none';
            searchInput.style.display = '';
            searchInput.value = '';
            searchInput.focus();
        }

        function renderDropdown(filter) {
            var filtered = allRoles;
            if (filter) {
                var lf = filter.toLowerCase();
                filtered = allRoles.filter(function(r) {
                    return r.name.toLowerCase().indexOf(lf) !== -1 || r.id.indexOf(filter) !== -1;
                });
            }
            if (filtered.length === 0) {
                dropdown.innerHTML = '<div class="role-loading-msg">${t(lang, 'role_no_results')}</div>';
                dropdown.style.display = 'block';
                return;
            }
            var html = filtered.slice(0, 50).map(function(r) {
                return '<div class="role-option" data-id="' + r.id + '">' +
                    '<span class="role-color-dot" style="background:' + (r.color || '#99aab5') + '"></span>' +
                    '<span>' + escapeH(r.name) + '</span>' +
                    '<span class="role-option-id">' + r.id + '</span>' +
                    '</div>';
            }).join('');
            dropdown.innerHTML = html;
            dropdown.style.display = 'block';
        }

        searchInput.addEventListener('focus', function() {
            if (allRoles.length === 0) fetchRoles();
            else renderDropdown(searchInput.value);
        });

        searchInput.addEventListener('input', function() {
            if (allRoles.length === 0) fetchRoles();
            else renderDropdown(searchInput.value);
        });

        dropdown.addEventListener('click', function(e) {
            var opt = e.target.closest('.role-option');
            if (!opt) return;
            var id = opt.getAttribute('data-id');
            var role = allRoles.find(function(r) { return r.id === id; });
            if (role) showSelected(role);
        });

        clearBtn.addEventListener('click', clearSelection);

        // Close dropdown on outside click
        document.addEventListener('click', function(e) {
            if (!container.contains(e.target)) {
                dropdown.style.display = 'none';
            }
        });

        return { fetchRoles: fetchRoles, clear: clearSelection, resolveCurrentValue: resolveCurrentValue };
    }

    var sourceCtrl = initSelector(sourceSelector, 'source');
    var targetCtrl = initSelector(targetSelector, 'target');

    // On link change, re-fetch roles
    linkSelect.addEventListener('change', function() {
        rolesCache = {};
        sourceCtrl.clear();
        targetCtrl.clear();
    });

    // Initial load: fetch roles for current link
    sourceCtrl.fetchRoles();
    targetCtrl.fetchRoles();

    // --- Target mode toggle ---
    var targetModeRadios = document.querySelectorAll('input[name="targetMode"]');
    var existingContainer = document.getElementById('targetExistingContainer');
    var createContainer = document.getElementById('targetCreateContainer');
    targetModeRadios.forEach(function(radio) {
        radio.addEventListener('change', function() {
            if (this.value === 'create') {
                existingContainer.style.display = 'none';
                createContainer.style.display = '';
            } else {
                existingContainer.style.display = '';
                createContainer.style.display = 'none';
            }
        });
    });

    // --- roleType autocomplete ---
    var roleTypeInput = document.getElementById('roleTypeInput');
    var roleTypeDropdown = document.getElementById('roleTypeDropdown');

    roleTypeInput.addEventListener('focus', function() {
        showRoleTypeSuggestions(roleTypeInput.value);
    });

    roleTypeInput.addEventListener('input', function() {
        showRoleTypeSuggestions(roleTypeInput.value);
    });

    function showRoleTypeSuggestions(filter) {
        if (roleTypes.length === 0) { roleTypeDropdown.style.display = 'none'; return; }
        var filtered = roleTypes;
        if (filter) {
            var lf = filter.toLowerCase();
            filtered = roleTypes.filter(function(rt) { return rt.toLowerCase().indexOf(lf) !== -1; });
        }
        if (filtered.length === 0) { roleTypeDropdown.style.display = 'none'; return; }
        roleTypeDropdown.innerHTML = filtered.map(function(rt) {
            return '<div class="autocomplete-option">' + escapeH(rt) + '</div>';
        }).join('');
        roleTypeDropdown.style.display = 'block';
    }

    roleTypeDropdown.addEventListener('click', function(e) {
        var opt = e.target.closest('.autocomplete-option');
        if (!opt) return;
        roleTypeInput.value = opt.textContent;
        roleTypeDropdown.style.display = 'none';
    });

    document.addEventListener('click', function(e) {
        if (!roleTypeInput.contains(e.target) && !roleTypeDropdown.contains(e.target)) {
            roleTypeDropdown.style.display = 'none';
        }
    });

    // --- Utility ---
    function escapeH(s) {
        var d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }
})();
</script>`;
}

// --- Helper to parse form body ---

function parseMapBody(body) {
    return {
        linkId: body.linkId,
        sourceRoleId: body.sourceRoleId,
        targetRoleId: body.targetRoleId || '',
        targetMode: body.targetMode || 'existing',
        targetRoleNameIfCreate: body.targetRoleNameIfCreate || '',
        syncMode: body.syncMode,
        enabled: body.enabled === '1' || body.enabled === 'on',
        maxDelaySeconds: parseInt(body.maxDelaySeconds) || 120,
        roleType: body.roleType || null,
        copyVisual: body.copyVisual === '1' || body.copyVisual === 'on',
        copyPermissionsMode: body.copyPermissionsMode,
        note: body.note || null,
    };
}

// --- Factory function ---

module.exports = function createConfigRoutes(client) {
    const router = Router();

    // --- Guild roles cache ---
    const guildRolesCache = new Map();
    const GUILD_ROLES_CACHE_TTL = 5 * 60 * 1000;

    async function fetchGuildRoles(guildId) {
        const cached = guildRolesCache.get(guildId);
        if (cached && Date.now() - cached.fetchedAt < GUILD_ROLES_CACHE_TTL) {
            return cached.roles;
        }
        const guild = await client.guilds.fetch(guildId);
        const roles = await guild.roles.fetch();
        const roleList = Array.from(roles.values())
            .filter(r => r.id !== guildId) // exclude @everyone
            .map(r => ({
                id: r.id,
                name: r.name,
                color: r.hexColor,
                position: r.position,
            }))
            .sort((a, b) => b.position - a.position);
        guildRolesCache.set(guildId, { roles: roleList, fetchedAt: Date.now() });
        return roleList;
    }

    // --- API: get guild roles ---

    router.get('/config/api/roles/:guildId', async (req, res) => {
        const guildId = req.params.guildId;
        if (!/^\d{17,20}$/.test(guildId)) {
            return res.status(400).json({ error: 'Invalid guild ID' });
        }
        try {
            const roleList = await fetchGuildRoles(guildId);
            res.json(roleList);
        } catch (err) {
            console.error('[RoleSync Config] Failed to fetch roles for guild', guildId, err.message);
            res.status(500).json({ error: 'Failed to fetch roles' });
        }
    });

    // --- API: get distinct role types ---

    router.get('/config/api/role-types', (_req, res) => {
        try {
            const types = getDistinctRoleTypes();
            res.json(types);
        } catch (err) {
            console.error('[RoleSync Config] Failed to fetch role types', err.message);
            res.status(500).json({ error: 'Failed to fetch role types' });
        }
    });

    // --- GET /config ---

    router.get('/config', async (req, res) => {
        const lang = getLang(req);
        const { links, roleMaps } = queryConfig();
        const csrfToken = req.session.user.csrfToken;

        // Collect unique guild IDs and build role name/color map
        const roleNameMap = new Map(); // roleId -> { name, color }
        const guildIds = new Set();
        for (const link of links) {
            guildIds.add(link.source_guild_id);
            guildIds.add(link.target_guild_id);
        }
        for (const gid of guildIds) {
            try {
                const roles = await fetchGuildRoles(gid);
                for (const r of roles) {
                    roleNameMap.set(r.id, { name: r.name, color: r.color });
                }
            } catch { /* ignore - will show ID only */ }
        }

        function renderRoleName(roleId) {
            const info = roleNameMap.get(roleId);
            if (!info) return `<span class="mono"><small>${escapeHtml(roleId)}</small></span>`;
            return `<span class="role-name-cell" style="flex-direction:column;align-items:flex-start;gap:0.1rem;">
                <span style="display:flex;align-items:center;gap:0.4rem;">
                    <span class="role-color-dot" style="background:${escapeHtml(info.color || '#99aab5')}"></span>
                    <span>${escapeHtml(info.name)}</span>
                </span>
                <small class="mono" style="color:var(--pico-muted-color)">${escapeHtml(roleId)}</small>
            </span>`;
        }

        let html = renderFormStyles();
        html += `<h2>${t(lang, 'config_title')}</h2>`;

        // Sync Links
        html += `<h3>${t(lang, 'sync_links_section')}</h3>`;
        html += `<table>
            <thead><tr>
                <th>${t(lang, 'col_link_id')}</th><th>${t(lang, 'col_source_guild')}</th><th>${t(lang, 'col_target_guild')}</th>
                <th>${t(lang, 'col_enabled')}</th><th>${t(lang, 'col_conflict_policy')}</th><th>${t(lang, 'col_created')}</th><th>${t(lang, 'col_actions')}</th>
            </tr></thead><tbody>`;

        for (const link of links) {
            html += `<tr>
                <td class="mono">${escapeHtml(link.link_id)}</td>
                <td>${escapeHtml(link.source_guild_name || link.source_guild_id)}</td>
                <td>${escapeHtml(link.target_guild_name || link.target_guild_id)}</td>
                <td>${link.enabled ? `<span class="badge badge-success">${t(lang, 'lbl_enabled')}</span>` : `<span class="badge badge-danger">${t(lang, 'lbl_disabled')}</span>`}</td>
                <td>${escapeHtml(link.default_conflict_policy)}</td>
                <td><small>${escapeHtml(link.created_at)}</small></td>
                <td>
                    <form class="inline-form" method="POST" action="/config/link/${encodeURIComponent(link.link_id)}/toggle">
                        <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
                        <input type="hidden" name="lang" value="${escapeHtml(lang)}">
                        <button type="submit" class="outline ${link.enabled ? 'secondary' : ''}">${link.enabled ? t(lang, 'btn_disable') : t(lang, 'btn_enable')}</button>
                    </form>
                </td>
            </tr>`;
        }
        html += '</tbody></table>';

        // Role Maps grouped by link
        html += `<h3>${t(lang, 'role_mappings_section')}</h3>`;

        const mapsByLink = {};
        for (const rm of roleMaps) {
            if (!mapsByLink[rm.link_id]) mapsByLink[rm.link_id] = [];
            mapsByLink[rm.link_id].push(rm);
        }

        for (const link of links) {
            const maps = mapsByLink[link.link_id] || [];

            html += `<h4>${escapeHtml(link.source_guild_name || link.source_guild_id)} &rarr; ${escapeHtml(link.target_guild_name || link.target_guild_id)}</h4>`;

            if (maps.length > 0) {
                html += `<table>
                    <thead><tr>
                        <th>${t(lang, 'col_source_role')}</th><th>${t(lang, 'col_target_role')}</th><th>${t(lang, 'col_sync_mode')}</th><th>${t(lang, 'col_enabled')}</th>
                        <th>${t(lang, 'col_max_delay')}</th><th>${t(lang, 'col_type')}</th><th>${t(lang, 'col_copy_visual')}</th><th>${t(lang, 'col_copy_perms')}</th><th>${t(lang, 'col_note')}</th><th>${t(lang, 'col_actions')}</th>
                    </tr></thead><tbody>`;

                for (const rm of maps) {
                    // Check if either role has been deleted (snapshot marked)
                    const srcSnapshot = getRoleSnapshot(link.source_guild_id, rm.source_role_id);
                    const tgtSnapshot = getRoleSnapshot(link.target_guild_id, rm.target_role_id);
                    const srcDeleted = srcSnapshot && srcSnapshot.deleted_at;
                    const tgtDeleted = tgtSnapshot && tgtSnapshot.deleted_at;
                    const hasDeletedRole = srcDeleted || tgtDeleted;

                    html += `<tr${hasDeletedRole ? ' style="background:rgba(255,0,0,0.08);"' : ''}>
                        <td>${renderRoleName(rm.source_role_id)}${srcDeleted ? ` <span class="badge badge-danger">${t(lang, 'badge_role_deleted')}</span>` : ''}</td>
                        <td>${renderRoleName(rm.target_role_id)}${tgtDeleted ? ` <span class="badge badge-danger">${t(lang, 'badge_role_deleted')}</span>` : ''}</td>
                        <td>${escapeHtml(rm.sync_mode)}</td>
                        <td>${rm.enabled ? `<span class="badge badge-success">${t(lang, 'lbl_yes')}</span>` : `<span class="badge badge-danger">${t(lang, 'lbl_no')}</span>`}</td>
                        <td>${rm.max_delay_seconds}s</td>
                        <td>${escapeHtml(rm.role_type || '-')}</td>
                        <td>${rm.copy_visual ? t(lang, 'lbl_yes') : t(lang, 'lbl_no')}</td>
                        <td>${escapeHtml(rm.copy_permissions_mode)}</td>
                        <td><small>${escapeHtml(rm.note || '-')}</small></td>
                        <td style="white-space:nowrap;">
                            <div style="display:flex;gap:0.2rem;margin-bottom:${hasDeletedRole ? '0.3rem' : '0'};">
                                <form class="inline-form" method="POST" action="/config/map/${rm.map_id}/toggle">
                                    <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
                                    <input type="hidden" name="lang" value="${escapeHtml(lang)}">
                                    <button type="submit" class="outline ${rm.enabled ? 'secondary' : ''}">${rm.enabled ? t(lang, 'btn_disable') : t(lang, 'btn_enable')}</button>
                                </form>
                                <a href="/config/map/${rm.map_id}/edit?lang=${lang}" role="button" class="outline btn-small">${t(lang, 'btn_edit')}</a>
                                <form class="inline-form" method="POST" action="/config/map/${rm.map_id}/delete" onsubmit="return confirm('${escapeHtml(t(lang, 'confirm_delete'))}')">
                                    <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
                                    <input type="hidden" name="lang" value="${escapeHtml(lang)}">
                                    <button type="submit" class="outline contrast">${t(lang, 'btn_delete')}</button>
                                </form>
                            </div>
                            ${hasDeletedRole ? `<div style="display:flex;gap:0.2rem;">
                                <a href="/config/recovery/${rm.map_id}?lang=${lang}" role="button" class="outline btn-small" style="border-color:var(--pico-primary);color:var(--pico-primary);">${t(lang, 'btn_recovery')}</a>
                                <a href="/config/map/${rm.map_id}/purge-confirm?lang=${lang}" role="button" class="outline contrast btn-small">${t(lang, 'btn_purge')}</a>
                            </div>` : ''}
                        </td>
                    </tr>`;
                }

                html += '</tbody></table>';
            }

            html += `<a href="/config/map/new?link_id=${encodeURIComponent(link.link_id)}&lang=${lang}" role="button" class="outline btn-small">${t(lang, 'btn_add_mapping')}</a>`;
        }

        res.send(layout(t(lang, 'config_title'), html, req.session.user, lang, req.originalUrl));
    });

    // --- Toggle sync link enabled ---

    router.post('/config/link/:linkId/toggle', (req, res) => {
        const linkId = req.params.linkId;
        const lang = req.body.lang || 'zh';
        const { links } = queryConfig();
        const link = links.find(l => l.link_id === linkId);
        if (!link) return res.status(404).send('Not found');

        updateSyncLinkEnabled(linkId, link.enabled ? 0 : 1);
        res.redirect(`/config?lang=${lang}`);
    });

    // --- Add new role mapping ---

    router.get('/config/map/new', (req, res) => {
        const lang = getLang(req);
        const linkId = req.query.link_id || '';
        const links = getLinkList();
        const roleTypes = getDistinctRoleTypes();
        const emptyRow = {
            link_id: linkId,
            source_role_id: '',
            target_role_id: '',
            sync_mode: 'source_to_target',
            enabled: 1,
            max_delay_seconds: 120,
            copy_permissions_mode: 'none',
            copy_visual: 1,
            role_type: '',
            note: '',
            targetMode: 'existing',
        };
        const formHtml = renderRoleMapForm({
            lang,
            row: emptyRow,
            links,
            action: '/config/map/new',
            csrfToken: req.session.user.csrfToken,
            roleTypes,
        });
        res.send(layout(t(lang, 'form_add_title'), formHtml, req.session.user, lang, req.originalUrl));
    });

    router.post('/config/map/new', async (req, res) => {
        const lang = req.body.lang || 'zh';
        const parsed = parseMapBody(req.body);
        const errors = validateRoleMapInput({
            linkId: parsed.linkId,
            sourceRoleId: parsed.sourceRoleId,
            targetRoleId: parsed.targetRoleId,
            targetMode: parsed.targetMode,
            targetRoleNameIfCreate: parsed.targetRoleNameIfCreate,
            syncMode: parsed.syncMode,
            copyPermissionsMode: parsed.copyPermissionsMode,
            maxDelaySeconds: parsed.maxDelaySeconds,
        }, lang);

        if (errors.length > 0) {
            const links = getLinkList();
            const roleTypes = getDistinctRoleTypes();
            const formHtml = renderRoleMapForm({
                lang,
                row: req.body,
                links,
                action: '/config/map/new',
                csrfToken: req.session.user.csrfToken,
                errors,
                roleTypes,
            });
            return res.status(422).send(layout(t(lang, 'form_add_title'), formHtml, req.session.user, lang, '/config/map/new?lang=' + lang));
        }

        // Handle "create new role" mode
        if (parsed.targetMode === 'create') {
            try {
                const links = getLinkList();
                const link = links.find(l => l.link_id === parsed.linkId);
                if (!link) {
                    return res.status(400).send('Link not found');
                }
                const targetGuild = await client.guilds.fetch(link.target_guild_id);
                const sourceGuild = await client.guilds.fetch(link.source_guild_id);
                const sourceRole = await sourceGuild.roles.fetch(parsed.sourceRoleId);
                const roleName = (parsed.targetRoleNameIfCreate && parsed.targetRoleNameIfCreate.trim())
                    || (sourceRole ? sourceRole.name : 'new-role');
                const createPayload = {
                    name: roleName,
                    reason: '[RoleSync] Dashboard 创建身份组',
                };
                if (parsed.copyVisual && sourceRole) {
                    createPayload.color = sourceRole.color;
                    createPayload.hoist = sourceRole.hoist;
                    createPayload.mentionable = sourceRole.mentionable;
                }
                const createdRole = await targetGuild.roles.create(createPayload);
                parsed.targetRoleId = createdRole.id;
                guildRolesCache.delete(link.target_guild_id);
            } catch (err) {
                console.error('[RoleSync Config] Failed to create role:', err.message);
                const links = getLinkList();
                const roleTypes = getDistinctRoleTypes();
                const errMsg = `${t(lang, 'create_role_error')}: ${err.message}`;
                const formHtml = renderRoleMapForm({
                    lang,
                    row: req.body,
                    links,
                    action: '/config/map/new',
                    csrfToken: req.session.user.csrfToken,
                    errors: [errMsg],
                    roleTypes,
                });
                return res.status(500).send(layout(t(lang, 'form_add_title'), formHtml, req.session.user, lang, '/config/map/new?lang=' + lang));
            }
        }

        upsertRoleSyncMap(parsed);
        res.redirect(`/config?lang=${lang}`);
    });

    // --- Edit role mapping ---

    router.get('/config/map/:mapId/edit', (req, res) => {
        const lang = getLang(req);
        const mapId = parseInt(req.params.mapId);
        const row = getRoleSyncMapById(mapId);
        if (!row) return res.status(404).send('Not found');

        const links = getLinkList();
        const roleTypes = getDistinctRoleTypes();
        const formHtml = renderRoleMapForm({
            lang,
            row,
            links,
            action: `/config/map/${mapId}/edit`,
            csrfToken: req.session.user.csrfToken,
            roleTypes,
        });
        res.send(layout(t(lang, 'form_edit_title'), formHtml, req.session.user, lang, req.originalUrl));
    });

    router.post('/config/map/:mapId/edit', async (req, res) => {
        const lang = req.body.lang || 'zh';
        const mapId = parseInt(req.params.mapId);
        const existing = getRoleSyncMapById(mapId);
        if (!existing) return res.status(404).send('Not found');

        const parsed = parseMapBody(req.body);
        // Use existing linkId for edit (cannot change)
        parsed.linkId = existing.link_id;

        const errors = validateRoleMapInput({
            linkId: parsed.linkId,
            sourceRoleId: parsed.sourceRoleId,
            targetRoleId: parsed.targetRoleId,
            targetMode: parsed.targetMode,
            targetRoleNameIfCreate: parsed.targetRoleNameIfCreate,
            syncMode: parsed.syncMode,
            copyPermissionsMode: parsed.copyPermissionsMode,
            maxDelaySeconds: parsed.maxDelaySeconds,
        }, lang);

        if (errors.length > 0) {
            const links = getLinkList();
            const roleTypes = getDistinctRoleTypes();
            const formHtml = renderRoleMapForm({
                lang,
                row: { ...existing, ...req.body, link_id: existing.link_id },
                links,
                action: `/config/map/${mapId}/edit`,
                csrfToken: req.session.user.csrfToken,
                errors,
                roleTypes,
            });
            return res.status(422).send(layout(t(lang, 'form_edit_title'), formHtml, req.session.user, lang, `/config/map/${mapId}/edit?lang=${lang}`));
        }

        // Handle "create new role" mode
        if (parsed.targetMode === 'create') {
            try {
                const links = getLinkList();
                const link = links.find(l => l.link_id === parsed.linkId);
                if (!link) {
                    return res.status(400).send('Link not found');
                }
                const targetGuild = await client.guilds.fetch(link.target_guild_id);
                const sourceGuild = await client.guilds.fetch(link.source_guild_id);
                const sourceRole = await sourceGuild.roles.fetch(parsed.sourceRoleId);
                const roleName = (parsed.targetRoleNameIfCreate && parsed.targetRoleNameIfCreate.trim())
                    || (sourceRole ? sourceRole.name : 'new-role');
                const createPayload = {
                    name: roleName,
                    reason: '[RoleSync] Dashboard 创建身份组',
                };
                if (parsed.copyVisual && sourceRole) {
                    createPayload.color = sourceRole.color;
                    createPayload.hoist = sourceRole.hoist;
                    createPayload.mentionable = sourceRole.mentionable;
                }
                const createdRole = await targetGuild.roles.create(createPayload);
                parsed.targetRoleId = createdRole.id;
                guildRolesCache.delete(link.target_guild_id);
            } catch (err) {
                console.error('[RoleSync Config] Failed to create role:', err.message);
                const links = getLinkList();
                const roleTypes = getDistinctRoleTypes();
                const errMsg = `${t(lang, 'create_role_error')}: ${err.message}`;
                const formHtml = renderRoleMapForm({
                    lang,
                    row: { ...existing, ...req.body, link_id: existing.link_id },
                    links,
                    action: `/config/map/${mapId}/edit`,
                    csrfToken: req.session.user.csrfToken,
                    errors: [errMsg],
                    roleTypes,
                });
                return res.status(500).send(layout(t(lang, 'form_edit_title'), formHtml, req.session.user, lang, `/config/map/${mapId}/edit?lang=${lang}`));
            }
        }

        upsertRoleSyncMap(parsed);
        res.redirect(`/config?lang=${lang}`);
    });

    // --- Toggle role mapping enabled ---

    router.post('/config/map/:mapId/toggle', (req, res) => {
        const lang = req.body.lang || 'zh';
        const mapId = parseInt(req.params.mapId);
        const row = getRoleSyncMapById(mapId);
        if (!row) return res.status(404).send('Not found');

        upsertRoleSyncMap({
            linkId: row.link_id,
            sourceRoleId: row.source_role_id,
            targetRoleId: row.target_role_id,
            enabled: !row.enabled,
            syncMode: row.sync_mode,
            conflictPolicy: row.conflict_policy,
            maxDelaySeconds: row.max_delay_seconds,
            roleType: row.role_type,
            copyVisual: !!row.copy_visual,
            copyPermissionsMode: row.copy_permissions_mode,
            note: row.note,
        });

        res.redirect(`/config?lang=${lang}`);
    });

    // --- Delete role mapping ---

    router.post('/config/map/:mapId/delete', (req, res) => {
        const lang = req.body.lang || 'zh';
        const mapId = parseInt(req.params.mapId);
        const row = getRoleSyncMapById(mapId);
        if (!row) return res.status(404).send('Not found');

        removeRoleSyncMap({
            linkId: row.link_id,
            sourceRoleId: row.source_role_id,
            targetRoleId: row.target_role_id,
        });

        res.redirect(`/config?lang=${lang}`);
    });

    // --- Recovery: show recovery page ---

    router.get('/config/recovery/:mapId', (req, res) => {
        const lang = getLang(req);
        const mapId = parseInt(req.params.mapId);
        const map = getRoleSyncMapByIdFull(mapId);
        if (!map) return res.status(404).send(t(lang, 'recovery_map_not_found'));

        const csrfToken = req.session.user.csrfToken;

        // Determine which role is deleted
        const srcSnapshot = getRoleSnapshot(map.source_guild_id, map.source_role_id);
        const tgtSnapshot = getRoleSnapshot(map.target_guild_id, map.target_role_id);
        const deletedSnapshot = (srcSnapshot && srcSnapshot.deleted_at) ? srcSnapshot : (tgtSnapshot && tgtSnapshot.deleted_at) ? tgtSnapshot : null;

        if (!deletedSnapshot) {
            return res.status(400).send(t(lang, 'recovery_no_snapshot'));
        }

        const isSourceDeleted = srcSnapshot && srcSnapshot.deleted_at;
        const deletedGuildId = isSourceDeleted ? map.source_guild_id : map.target_guild_id;
        const deletedRoleId = isSourceDeleted ? map.source_role_id : map.target_role_id;

        // Find members who had this role (from source guild snapshot for source deletion, target guild for target deletion)
        const affectedUserIds = getMembersWithRole(deletedGuildId, deletedRoleId);

        const colorHex = '#' + (deletedSnapshot.role_color || 0).toString(16).padStart(6, '0');
        const message = req.query.message || '';
        const messageType = req.query.messageType || '';

        let html = `<h2>${t(lang, 'recovery_title')}</h2>`;

        if (message) {
            const msgClass = messageType === 'error' ? 'badge-danger' : 'badge-success';
            html += `<div style="padding:0.75rem;margin-bottom:1rem;border-radius:4px;background:${messageType === 'error' ? 'rgba(255,0,0,0.1)' : 'rgba(0,255,0,0.1)'};">
                <span class="badge ${msgClass}">${escapeHtml(message)}</span>
            </div>`;
        }

        html += `<h4>${t(lang, 'recovery_role_info')}</h4>
            <table>
                <tr><td><strong>${t(lang, 'recovery_role_name')}</strong></td><td>${escapeHtml(deletedSnapshot.role_name)}</td></tr>
                <tr><td><strong>${t(lang, 'recovery_role_color')}</strong></td><td><span class="role-color-dot" style="background:${escapeHtml(colorHex)};display:inline-block;width:16px;height:16px;border-radius:50%;vertical-align:middle;"></span> ${escapeHtml(colorHex)}</td></tr>
                <tr><td><strong>${t(lang, 'recovery_deleted_at')}</strong></td><td>${escapeHtml(deletedSnapshot.deleted_at)}</td></tr>
                <tr><td><strong>${t(lang, 'purge_source_label')}</strong></td><td><code>${escapeHtml(map.source_role_id)}</code>${isSourceDeleted ? ` <span class="badge badge-danger">${t(lang, 'badge_role_deleted')}</span>` : ''}</td></tr>
                <tr><td><strong>${t(lang, 'purge_target_label')}</strong></td><td><code>${escapeHtml(map.target_role_id)}</code>${!isSourceDeleted ? ` <span class="badge badge-danger">${t(lang, 'badge_role_deleted')}</span>` : ''}</td></tr>
            </table>`;

        html += `<h4>${t(lang, 'recovery_affected_members')}</h4>
            <p><small>${t(lang, 'recovery_affected_members_desc')}</small></p>`;

        if (affectedUserIds.length > 0) {
            html += `<p>${affectedUserIds.length} ${lang === 'zh' ? '位成员' : 'members'}</p>`;
            html += `<div style="max-height:200px;overflow-y:auto;border:1px solid var(--pico-muted-border-color);border-radius:4px;padding:0.5rem;margin-bottom:1rem;">`;
            html += affectedUserIds.slice(0, 100).map(uid => `<code>${escapeHtml(uid)}</code>`).join(', ');
            if (affectedUserIds.length > 100) html += ` … ${lang === 'zh' ? `及另外 ${affectedUserIds.length - 100} 位` : `and ${affectedUserIds.length - 100} more`}`;
            html += `</div>`;
        } else {
            html += `<p><em>${t(lang, 'recovery_no_members')}</em></p>`;
        }

        html += `<p><small>${t(lang, 'recovery_action_desc')}</small></p>`;

        html += `<div style="display:flex;gap:0.5rem;">
            <form method="POST" action="/config/recovery/${mapId}/execute">
                <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
                <input type="hidden" name="lang" value="${escapeHtml(lang)}">
                <button type="submit">${t(lang, 'btn_execute_recovery')}</button>
            </form>
            <a href="/config?lang=${escapeHtml(lang)}" role="button" class="outline secondary">${t(lang, 'btn_cancel')}</a>
        </div>`;

        res.send(layout(t(lang, 'recovery_title'), html, req.session.user, lang, req.originalUrl));
    });

    // --- Recovery: execute ---

    router.post('/config/recovery/:mapId/execute', async (req, res) => {
        const lang = req.body.lang || 'zh';
        const mapId = parseInt(req.params.mapId);
        const map = getRoleSyncMapByIdFull(mapId);
        if (!map) return res.status(404).send(t(lang, 'recovery_map_not_found'));

        try {
            const srcSnapshot = getRoleSnapshot(map.source_guild_id, map.source_role_id);
            const tgtSnapshot = getRoleSnapshot(map.target_guild_id, map.target_role_id);
            const isSourceDeleted = srcSnapshot && srcSnapshot.deleted_at;
            const isTargetDeleted = tgtSnapshot && tgtSnapshot.deleted_at;
            const deletedSnapshot = isSourceDeleted ? srcSnapshot : isTargetDeleted ? tgtSnapshot : null;

            if (!deletedSnapshot) {
                return res.redirect(`/config/recovery/${mapId}?lang=${lang}&message=${encodeURIComponent(t(lang, 'recovery_no_snapshot'))}&messageType=error`);
            }

            const deletedGuildId = isSourceDeleted ? map.source_guild_id : map.target_guild_id;
            const deletedRoleId = isSourceDeleted ? map.source_role_id : map.target_role_id;

            // 1. Check if role exists in Discord, create if not
            const guild = await client.guilds.fetch(deletedGuildId);
            let discordRole = await guild.roles.fetch(deletedRoleId).catch(() => null);
            let newRoleId = deletedRoleId;

            if (!discordRole) {
                // Create new role with snapshot data
                const createdRole = await guild.roles.create({
                    name: deletedSnapshot.role_name,
                    color: deletedSnapshot.role_color || 0,
                    reason: '[RoleSync] 恢复被删角色',
                });
                newRoleId = createdRole.id;
                guildRolesCache.delete(deletedGuildId);

                // 2. Update mapping with new role ID
                if (isSourceDeleted) {
                    updateRoleSyncMapRoleId(mapId, { sourceRoleId: newRoleId });
                } else {
                    updateRoleSyncMapRoleId(mapId, { targetRoleId: newRoleId });
                }
            }

            // 3. Re-enable the mapping
            enableRoleSyncMapById(mapId);

            // 4. Batch enqueue add jobs for affected members
            // 恢复任务：在被删角色所在的服务器重新分配新角色
            const affectedUserIds = getMembersWithRole(deletedGuildId, deletedRoleId);
            const jobTargetGuildId = deletedGuildId;
            const jobTargetRoleId = newRoleId;
            const jobSourceRoleId = isSourceDeleted ? map.target_role_id : map.source_role_id;

            let enqueuedCount = 0;
            for (const userId of affectedUserIds) {
                const result = enqueueSyncJob({
                    linkId: map.link_id,
                    operationId: `recovery_${mapId}_${Date.now()}`,
                    sourceGuildId: isSourceDeleted ? map.target_guild_id : map.source_guild_id,
                    targetGuildId: jobTargetGuildId,
                    userId,
                    sourceRoleId: jobSourceRoleId,
                    targetRoleId: jobTargetRoleId,
                    action: 'add',
                    lane: 'normal',
                    priority: 10,
                    maxAttempts: 3,
                    notBeforeMs: null,
                    conflictPolicy: null,
                    maxDelaySeconds: 120,
                    sourceEvent: 'recovery',
                });
                if (result.enqueued) enqueuedCount++;
            }

            res.redirect(`/config?lang=${lang}`);
        } catch (err) {
            console.error('[RoleSync Config] Recovery failed:', err);
            const msg = `${t(lang, 'recovery_error')}: ${err.message}`;
            res.redirect(`/config/recovery/${mapId}?lang=${lang}&message=${encodeURIComponent(msg)}&messageType=error`);
        }
    });

    // --- Purge: confirmation page ---

    router.get('/config/map/:mapId/purge-confirm', (req, res) => {
        const lang = getLang(req);
        const mapId = parseInt(req.params.mapId);
        const map = getRoleSyncMapByIdFull(mapId);
        if (!map) return res.status(404).send(t(lang, 'recovery_map_not_found'));

        const csrfToken = req.session.user.csrfToken;

        // Determine the role name for confirmation
        const srcSnapshot = getRoleSnapshot(map.source_guild_id, map.source_role_id);
        const tgtSnapshot = getRoleSnapshot(map.target_guild_id, map.target_role_id);
        const deletedSnapshot = (srcSnapshot && srcSnapshot.deleted_at) ? srcSnapshot : (tgtSnapshot && tgtSnapshot.deleted_at) ? tgtSnapshot : null;
        const confirmName = deletedSnapshot ? deletedSnapshot.role_name : (srcSnapshot ? srcSnapshot.role_name : map.source_role_id);

        const message = req.query.message || '';

        let html = `<h2>${t(lang, 'purge_confirm_title')}</h2>`;

        if (message) {
            html += `<div style="padding:0.75rem;margin-bottom:1rem;border-radius:4px;background:rgba(255,0,0,0.1);">
                <span class="badge badge-danger">${escapeHtml(message)}</span>
            </div>`;
        }

        html += `<div style="padding:1rem;margin-bottom:1rem;border:2px solid var(--pico-del-color);border-radius:4px;background:rgba(255,0,0,0.05);">
            <strong>⚠️ ${t(lang, 'purge_warning')}</strong>
        </div>`;

        html += `<h4>${t(lang, 'purge_role_info')}</h4>
            <table>
                <tr><td><strong>${t(lang, 'purge_source_label')}</strong></td><td><code>${escapeHtml(map.source_role_id)}</code>${srcSnapshot ? ` (${escapeHtml(srcSnapshot.role_name)})` : ''}</td></tr>
                <tr><td><strong>${t(lang, 'purge_target_label')}</strong></td><td><code>${escapeHtml(map.target_role_id)}</code>${tgtSnapshot ? ` (${escapeHtml(tgtSnapshot.role_name)})` : ''}</td></tr>
                <tr><td><strong>Link ID</strong></td><td><code>${escapeHtml(map.link_id)}</code></td></tr>
            </table>`;

        html += `<form method="POST" action="/config/map/${mapId}/purge" id="purgeForm">
            <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
            <input type="hidden" name="lang" value="${escapeHtml(lang)}">
            <label>${t(lang, 'purge_input_label', confirmName)}
                <input type="text" name="confirmName" id="purgeConfirmInput" placeholder="${escapeHtml(t(lang, 'purge_input_placeholder'))}" autocomplete="off" required>
            </label>
            <div style="display:flex;gap:0.5rem;">
                <button type="submit" id="purgeSubmitBtn" disabled style="background:var(--pico-del-color);border-color:var(--pico-del-color);">${t(lang, 'btn_confirm_purge')}</button>
                <a href="/config?lang=${escapeHtml(lang)}" role="button" class="outline secondary">${t(lang, 'btn_cancel')}</a>
            </div>
        </form>
        <script>
        (function() {
            var expected = ${JSON.stringify(confirmName)};
            var input = document.getElementById('purgeConfirmInput');
            var btn = document.getElementById('purgeSubmitBtn');
            input.addEventListener('input', function() {
                btn.disabled = input.value !== expected;
            });
        })();
        </script>`;

        res.send(layout(t(lang, 'purge_confirm_title'), html, req.session.user, lang, req.originalUrl));
    });

    // --- Purge: execute ---

    router.post('/config/map/:mapId/purge', (req, res) => {
        const lang = req.body.lang || 'zh';
        const mapId = parseInt(req.params.mapId);
        const map = getRoleSyncMapByIdFull(mapId);
        if (!map) return res.status(404).send(t(lang, 'recovery_map_not_found'));

        // Verify confirmation name
        const srcSnapshot = getRoleSnapshot(map.source_guild_id, map.source_role_id);
        const tgtSnapshot = getRoleSnapshot(map.target_guild_id, map.target_role_id);
        const deletedSnapshot = (srcSnapshot && srcSnapshot.deleted_at) ? srcSnapshot : (tgtSnapshot && tgtSnapshot.deleted_at) ? tgtSnapshot : null;
        const expectedName = deletedSnapshot ? deletedSnapshot.role_name : (srcSnapshot ? srcSnapshot.role_name : map.source_role_id);

        if (req.body.confirmName !== expectedName) {
            return res.redirect(`/config/map/${mapId}/purge-confirm?lang=${lang}&message=${encodeURIComponent(t(lang, 'purge_name_mismatch'))}`);
        }

        try {
            const result = purgeOrphanMappingData([mapId]);
            console.log(`[RoleSync Config] Purged mapping ${mapId}: ${JSON.stringify(result)}`);
            res.redirect(`/config?lang=${lang}`);
        } catch (err) {
            console.error('[RoleSync Config] Purge failed:', err);
            return res.redirect(`/config/map/${mapId}/purge-confirm?lang=${lang}&message=${encodeURIComponent(t(lang, 'purge_error') + ': ' + err.message)}`);
        }
    });

    return router;
};
