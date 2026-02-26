const { Router } = require('express');
const { queryJobs, getLinkList } = require('../queries');
const { layout, pagination, statusBadge, escapeHtml } = require('../views/layout');
const { t, getLang } = require('../views/i18n');

const router = Router();

router.get('/jobs', (req, res) => {
    const lang = getLang(req);
    const page = parseInt(req.query.page) || 1;
    const status = req.query.status || null;
    const lane = req.query.lane || null;
    const linkId = req.query.link || null;
    const userId = req.query.search || null;

    const result = queryJobs({ status, lane, linkId, userId, page });
    const links = getLinkList();

    let html = `<h2>${t(lang, 'jobs_title')}</h2>`;

    // Filters
    html += `<form class="filters" method="get" action="/jobs">
        <input type="hidden" name="lang" value="${escapeHtml(lang)}">
        <label>${t(lang, 'col_status')}:
            <select name="status">
                <option value="">${t(lang, 'filter_all')}</option>
                ${['pending', 'processing', 'completed', 'failed', 'cancelled'].map(s => `<option value="${s}" ${s === status ? 'selected' : ''}>${t(lang, `status_${s}`)}</option>`).join('')}
            </select>
        </label>
        <label>${t(lang, 'filter_lane')}:
            <select name="lane">
                <option value="">${t(lang, 'filter_all')}</option>
                <option value="fast" ${lane === 'fast' ? 'selected' : ''}>Fast</option>
                <option value="normal" ${lane === 'normal' ? 'selected' : ''}>Normal</option>
            </select>
        </label>
        <label>${t(lang, 'filter_link')}:
            <select name="link">
                <option value="">${t(lang, 'filter_all')}</option>
                ${links.map(l => `<option value="${escapeHtml(l.link_id)}" ${l.link_id === linkId ? 'selected' : ''}>${escapeHtml(l.source_guild_name)} &rarr; ${escapeHtml(l.target_guild_name)}</option>`).join('')}
            </select>
        </label>
        <label>${t(lang, 'filter_user_id')}:
            <input type="text" name="search" value="${escapeHtml(userId || '')}" placeholder="${t(lang, 'search_placeholder')}">
        </label>
        <button type="submit">${t(lang, 'btn_filter')}</button>
        <a href="/jobs?lang=${lang}" role="button" class="outline">${t(lang, 'btn_clear')}</a>
    </form>`;

    html += `<p><small>${t(lang, 'total_records', result.total)}</small></p>`;

    html += `<table>
        <thead><tr>
            <th>${t(lang, 'col_id')}</th><th>${t(lang, 'col_status')}</th><th>${t(lang, 'filter_lane')}</th><th>${t(lang, 'col_user_id')}</th><th>${t(lang, 'col_action')}</th>
            <th>${t(lang, 'col_source_role')}</th><th>${t(lang, 'col_target_role')}</th><th>${t(lang, 'col_attempts')}</th><th>${t(lang, 'col_created')}</th><th>${t(lang, 'col_error')}</th>
        </tr></thead><tbody>`;

    for (const row of result.rows) {
        html += `<tr>
            <td>${row.job_id}</td>
            <td>${statusBadge(row.status, lang)}</td>
            <td><span class="badge ${row.lane === 'fast' ? 'badge-info' : 'badge-secondary'}">${escapeHtml(row.lane)}</span></td>
            <td class="mono">${escapeHtml(row.user_id)}</td>
            <td>${escapeHtml(row.action)}</td>
            <td class="mono"><small>${escapeHtml(row.source_role_id)}</small></td>
            <td class="mono"><small>${escapeHtml(row.target_role_id)}</small></td>
            <td>${row.attempt_count}/${row.max_attempts}</td>
            <td><small>${escapeHtml(row.created_at)}</small></td>
            <td><small>${escapeHtml(row.last_error || '-')}</small></td>
        </tr>`;
    }

    html += '</tbody></table>';
    html += pagination(page, result.total, result.pageSize, req.originalUrl, lang);

    res.send(layout(t(lang, 'jobs_title'), html, req.session.user, lang, req.originalUrl));
});

module.exports = router;
