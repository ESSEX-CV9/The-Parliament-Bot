const { Router } = require('express');
const { queryChangeLogs, getLinkList } = require('../queries');
const { layout, pagination, statusBadge, escapeHtml } = require('../views/layout');
const { t, getLang } = require('../views/i18n');

const router = Router();

router.get('/logs', (req, res) => {
    const lang = getLang(req);
    const page = parseInt(req.query.page) || 1;
    const userId = req.query.search || null;
    const linkId = req.query.link || null;
    const result = req.query.result || null;
    const action = req.query.action || null;
    const timeFrom = req.query.from || null;
    const timeTo = req.query.to || null;

    const data = queryChangeLogs({ userId, linkId, result, action, timeFrom, timeTo, page });
    const links = getLinkList();

    let html = `<h2>${t(lang, 'logs_title')}</h2>`;

    // Filters
    html += `<form class="filters" method="get" action="/logs">
        <input type="hidden" name="lang" value="${escapeHtml(lang)}">
        <label>${t(lang, 'filter_user_id')}:
            <input type="text" name="search" value="${escapeHtml(userId || '')}" placeholder="${t(lang, 'search_placeholder')}">
        </label>
        <label>${t(lang, 'filter_link')}:
            <select name="link">
                <option value="">${t(lang, 'filter_all')}</option>
                ${links.map(l => `<option value="${escapeHtml(l.link_id)}" ${l.link_id === linkId ? 'selected' : ''}>${escapeHtml(l.source_guild_name)} &rarr; ${escapeHtml(l.target_guild_name)}</option>`).join('')}
            </select>
        </label>
        <label>${t(lang, 'filter_result')}:
            <select name="result">
                <option value="">${t(lang, 'filter_all')}</option>
                ${['success', 'failed', 'skipped', 'noop', 'planned'].map(r => `<option value="${r}" ${r === result ? 'selected' : ''}>${t(lang, `status_${r}`)}</option>`).join('')}
            </select>
        </label>
        <label>${t(lang, 'filter_action')}:
            <select name="action">
                <option value="">${t(lang, 'filter_all')}</option>
                <option value="add" ${action === 'add' ? 'selected' : ''}>add</option>
                <option value="remove" ${action === 'remove' ? 'selected' : ''}>remove</option>
            </select>
        </label>
        <label>${t(lang, 'filter_from')}:
            <input type="datetime-local" name="from" value="${escapeHtml(timeFrom || '')}">
        </label>
        <label>${t(lang, 'filter_to')}:
            <input type="datetime-local" name="to" value="${escapeHtml(timeTo || '')}">
        </label>
        <button type="submit">${t(lang, 'btn_filter')}</button>
        <a href="/logs?lang=${lang}" role="button" class="outline">${t(lang, 'btn_clear')}</a>
    </form>`;

    html += `<p><small>${t(lang, 'total_records', data.total)}</small></p>`;

    html += `<table>
        <thead><tr>
            <th>${t(lang, 'col_id')}</th><th>${t(lang, 'col_user_id')}</th><th>${t(lang, 'col_action')}</th><th>${t(lang, 'col_result')}</th>
            <th>${t(lang, 'col_source_role')}</th><th>${t(lang, 'col_target_role')}</th><th>${t(lang, 'col_event')}</th><th>${t(lang, 'col_error')}</th><th>${t(lang, 'col_time')}</th>
        </tr></thead><tbody>`;

    for (const row of data.rows) {
        html += `<tr>
            <td>${row.log_id}</td>
            <td class="mono">${escapeHtml(row.user_id)}</td>
            <td>${escapeHtml(row.action)}</td>
            <td>${statusBadge(row.result, lang)}</td>
            <td class="mono"><small>${escapeHtml(row.source_role_id || '-')}</small></td>
            <td class="mono"><small>${escapeHtml(row.target_role_id || '-')}</small></td>
            <td><small>${escapeHtml(row.source_event || '-')}</small></td>
            <td><small>${escapeHtml(row.error_message || '-')}</small></td>
            <td><small>${escapeHtml(row.created_at)}</small></td>
        </tr>`;
    }

    html += '</tbody></table>';
    html += pagination(page, data.total, data.pageSize, req.originalUrl, lang);

    res.send(layout(t(lang, 'logs_title'), html, req.session.user, lang, req.originalUrl));
});

module.exports = router;
