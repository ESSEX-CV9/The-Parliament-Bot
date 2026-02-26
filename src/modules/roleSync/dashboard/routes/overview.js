const { Router } = require('express');
const { getOverviewStats } = require('../queries');
const { layout, escapeHtml, statusBadge } = require('../views/layout');
const { t, getLang } = require('../views/i18n');

const router = Router();

router.get('/', (req, res) => {
    const lang = getLang(req);
    const stats = getOverviewStats();

    let html = `<h2>${t(lang, 'overview_title')}</h2>`;

    // Guild stats
    html += `<h3>${t(lang, 'guilds_section')}</h3><div class="stats-grid">`;
    for (const g of stats.guildStats) {
        html += `<div class="stat-card">
            <h3>${escapeHtml(g.guild_name || g.guild_id)}</h3>
            <div class="value">${g.active_members}</div>
            <small>${t(lang, 'stat_active')} / ${g.total_members} ${t(lang, 'stat_total')} / ${g.inactive_members} ${t(lang, 'stat_inactive')}</small>
        </div>`;
    }
    html += '</div>';

    // Intersection counts
    if (stats.intersectionCounts.length > 0) {
        html += `<h3>${t(lang, 'intersections_section')}</h3><div class="stats-grid">`;
        for (const ic of stats.intersectionCounts) {
            html += `<div class="stat-card">
                <h3>${escapeHtml(ic.source_guild_name)} &harr; ${escapeHtml(ic.target_guild_name)}</h3>
                <div class="value">${ic.count}</div>
                <small>${t(lang, 'stat_in_both_guilds')}</small>
            </div>`;
        }
        html += '</div>';
    }

    // Job queue stats
    html += `<h3>${t(lang, 'job_queue_section')}</h3><div class="stats-grid">`;
    const jobMap = {};
    for (const j of stats.jobStats) {
        jobMap[j.status] = j.count;
    }
    for (const status of ['pending', 'processing', 'completed', 'failed', 'cancelled']) {
        const count = jobMap[status] || 0;
        html += `<div class="stat-card">
            <h3>${statusBadge(status, lang)}</h3>
            <div class="value">${count}</div>
        </div>`;
    }
    html += '</div>';

    // Lane breakdown
    if (stats.laneStats.length > 0) {
        html += `<h4>${t(lang, 'active_lanes_section')}</h4><table><thead><tr><th>${t(lang, 'col_lane')}</th><th>${t(lang, 'col_status')}</th><th>${t(lang, 'col_count')}</th></tr></thead><tbody>`;
        for (const ls of stats.laneStats) {
            html += `<tr><td>${escapeHtml(ls.lane)}</td><td>${statusBadge(ls.status, lang)}</td><td>${ls.count}</td></tr>`;
        }
        html += '</tbody></table>';
    }

    res.send(layout(t(lang, 'overview_title'), html, req.session.user, lang, req.originalUrl));
});

module.exports = router;
