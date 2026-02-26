const { Router } = require('express');
const { queryConfig, getLinkList, getRoleSyncMapById } = require('../queries');
const { upsertRoleSyncMap, removeRoleSyncMap, updateSyncLinkEnabled } = require('../../utils/roleSyncDatabase');
const { layout, escapeHtml } = require('../views/layout');
const { t, getLang } = require('../views/i18n');

const router = Router();

// --- Validation ---

const VALID_SYNC_MODES = new Set(['bidirectional', 'source_to_target', 'target_to_source', 'disabled']);
const VALID_COPY_PERM_MODES = new Set(['none', 'safe', 'strict']);
const ROLE_ID_RE = /^\d{17,20}$/;

function validateRoleMapInput({ linkId, sourceRoleId, targetRoleId, syncMode, copyPermissionsMode, maxDelaySeconds }, lang) {
    const errors = [];
    if (!linkId) errors.push(lang === 'zh' ? 'link_id 不能为空' : 'link_id is required');
    if (!ROLE_ID_RE.test(sourceRoleId)) errors.push(lang === 'zh' ? 'source_role_id 必须是 17-20 位数字' : 'source_role_id must be 17-20 digits');
    if (!ROLE_ID_RE.test(targetRoleId)) errors.push(lang === 'zh' ? 'target_role_id 必须是 17-20 位数字' : 'target_role_id must be 17-20 digits');
    if (!VALID_SYNC_MODES.has(syncMode)) errors.push(lang === 'zh' ? 'sync_mode 无效' : 'sync_mode is invalid');
    if (!VALID_COPY_PERM_MODES.has(copyPermissionsMode)) errors.push(lang === 'zh' ? 'copy_permissions_mode 无效' : 'copy_permissions_mode is invalid');
    const delay = parseInt(maxDelaySeconds);
    if (!Number.isFinite(delay) || delay <= 0 || delay > 3600) errors.push(lang === 'zh' ? 'max_delay_seconds 必须在 1-3600 之间' : 'max_delay_seconds must be 1-3600');
    return errors;
}

// --- Form rendering helper ---

function renderRoleMapForm({ lang, row, links, action, csrfToken, errors = [] }) {
    const syncModes = ['bidirectional', 'source_to_target', 'target_to_source', 'disabled'];
    const copyPermModes = ['none', 'safe', 'strict'];
    const isEdit = action.includes('/edit');

    const errorHtml = errors.length > 0
        ? `<div class="error-box"><strong>${t(lang, 'validation_error')}:</strong><ul>${errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div>`
        : '';

    return `
        <h2>${t(lang, isEdit ? 'form_edit_title' : 'form_add_title')}</h2>
        ${errorHtml}
        <form method="POST" action="${escapeHtml(action)}">
            <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
            <input type="hidden" name="lang" value="${escapeHtml(lang)}">

            <label>${t(lang, 'filter_link')}:
                <select name="linkId" ${isEdit ? 'disabled' : ''}>
                    ${links.map(l => `<option value="${escapeHtml(l.link_id)}" ${l.link_id === (row.link_id || row.linkId) ? 'selected' : ''}>${escapeHtml(l.source_guild_name)} &rarr; ${escapeHtml(l.target_guild_name)}</option>`).join('')}
                </select>
                ${isEdit ? `<input type="hidden" name="linkId" value="${escapeHtml(row.link_id || row.linkId || '')}">` : ''}
            </label>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;">
                <label>${t(lang, 'col_source_role')} ID:
                    <input type="text" name="sourceRoleId" value="${escapeHtml(row.source_role_id || row.sourceRoleId || '')}" placeholder="17-20 digits" pattern="\\d{17,20}" required>
                </label>
                <label>${t(lang, 'col_target_role')} ID:
                    <input type="text" name="targetRoleId" value="${escapeHtml(row.target_role_id || row.targetRoleId || '')}" placeholder="17-20 digits" pattern="\\d{17,20}" required>
                </label>
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
                <label>${t(lang, 'col_type')}:
                    <input type="text" name="roleType" value="${escapeHtml(row.role_type || row.roleType || '')}">
                </label>
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
    `;
}

// --- Helper to parse form body ---

function parseMapBody(body) {
    return {
        linkId: body.linkId,
        sourceRoleId: body.sourceRoleId,
        targetRoleId: body.targetRoleId,
        syncMode: body.syncMode,
        enabled: body.enabled === '1' || body.enabled === 'on',
        maxDelaySeconds: parseInt(body.maxDelaySeconds) || 120,
        roleType: body.roleType || null,
        copyVisual: body.copyVisual === '1' || body.copyVisual === 'on',
        copyPermissionsMode: body.copyPermissionsMode,
        note: body.note || null,
    };
}

// --- GET /config ---

router.get('/config', (req, res) => {
    const lang = getLang(req);
    const { links, roleMaps } = queryConfig();
    const csrfToken = req.session.user.csrfToken;

    let html = `<h2>${t(lang, 'config_title')}</h2>`;

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
                html += `<tr>
                    <td class="mono"><small>${escapeHtml(rm.source_role_id)}</small></td>
                    <td class="mono"><small>${escapeHtml(rm.target_role_id)}</small></td>
                    <td>${escapeHtml(rm.sync_mode)}</td>
                    <td>${rm.enabled ? `<span class="badge badge-success">${t(lang, 'lbl_yes')}</span>` : `<span class="badge badge-danger">${t(lang, 'lbl_no')}</span>`}</td>
                    <td>${rm.max_delay_seconds}s</td>
                    <td>${escapeHtml(rm.role_type || '-')}</td>
                    <td>${rm.copy_visual ? t(lang, 'lbl_yes') : t(lang, 'lbl_no')}</td>
                    <td>${escapeHtml(rm.copy_permissions_mode)}</td>
                    <td><small>${escapeHtml(rm.note || '-')}</small></td>
                    <td style="white-space:nowrap;">
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
// NOTE: /config/map/new must be registered BEFORE /config/map/:mapId routes

router.get('/config/map/new', (req, res) => {
    const lang = getLang(req);
    const linkId = req.query.link_id || '';
    const links = getLinkList();
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
    };
    const formHtml = renderRoleMapForm({
        lang,
        row: emptyRow,
        links,
        action: '/config/map/new',
        csrfToken: req.session.user.csrfToken,
    });
    res.send(layout(t(lang, 'form_add_title'), formHtml, req.session.user, lang, req.originalUrl));
});

router.post('/config/map/new', (req, res) => {
    const lang = req.body.lang || 'zh';
    const parsed = parseMapBody(req.body);
    const errors = validateRoleMapInput({
        linkId: parsed.linkId,
        sourceRoleId: parsed.sourceRoleId,
        targetRoleId: parsed.targetRoleId,
        syncMode: parsed.syncMode,
        copyPermissionsMode: parsed.copyPermissionsMode,
        maxDelaySeconds: parsed.maxDelaySeconds,
    }, lang);

    if (errors.length > 0) {
        const links = getLinkList();
        const formHtml = renderRoleMapForm({
            lang,
            row: req.body,
            links,
            action: '/config/map/new',
            csrfToken: req.session.user.csrfToken,
            errors,
        });
        return res.status(422).send(layout(t(lang, 'form_add_title'), formHtml, req.session.user, lang, '/config/map/new?lang=' + lang));
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
    const formHtml = renderRoleMapForm({
        lang,
        row,
        links,
        action: `/config/map/${mapId}/edit`,
        csrfToken: req.session.user.csrfToken,
    });
    res.send(layout(t(lang, 'form_edit_title'), formHtml, req.session.user, lang, req.originalUrl));
});

router.post('/config/map/:mapId/edit', (req, res) => {
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
        syncMode: parsed.syncMode,
        copyPermissionsMode: parsed.copyPermissionsMode,
        maxDelaySeconds: parsed.maxDelaySeconds,
    }, lang);

    if (errors.length > 0) {
        const links = getLinkList();
        const formHtml = renderRoleMapForm({
            lang,
            row: { ...existing, ...req.body, link_id: existing.link_id },
            links,
            action: `/config/map/${mapId}/edit`,
            csrfToken: req.session.user.csrfToken,
            errors,
        });
        return res.status(422).send(layout(t(lang, 'form_edit_title'), formHtml, req.session.user, lang, `/config/map/${mapId}/edit?lang=${lang}`));
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

module.exports = router;
