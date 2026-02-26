const { t } = require('./i18n');

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function layout(title, bodyHtml, user, lang = 'zh', currentUrl = '/') {
    const htmlLang = lang === 'en' ? 'en' : 'zh-CN';

    // Build language toggle URL
    const toggleUrl = buildLangToggleUrl(currentUrl, lang);

    // Build nav link with lang param and current page highlighting
    const navLink = (path, key) => {
        const parsedUrl = new URL(currentUrl, 'http://localhost');
        const isCurrent = parsedUrl.pathname === path ||
                          (path !== '/' && parsedUrl.pathname.startsWith(path));
        const ariaCurrent = isCurrent ? ' aria-current="page"' : '';
        return `<a href="${path}?lang=${lang}"${ariaCurrent}>${t(lang, key)}</a>`;
    };

    return `<!DOCTYPE html>
<html lang="${htmlLang}" data-theme="dark">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} - ${t(lang, 'nav_brand')}</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
    <style>
        nav { margin-bottom: 1rem; }
        table { font-size: 0.85rem; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
        .stat-card { background: var(--pico-card-background-color); border: 1px solid var(--pico-muted-border-color); border-radius: 8px; padding: 1rem; }
        .stat-card h3 { margin: 0 0 0.25rem; font-size: 0.9rem; color: var(--pico-muted-color); }
        .stat-card .value { font-size: 1.5rem; font-weight: bold; }
        .filters { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: end; margin-bottom: 1rem; }
        .filters label { margin-bottom: 0; }
        .filters input, .filters select { margin-bottom: 0; padding: 0.4rem 0.6rem; font-size: 0.85rem; }
        .pagination { display: flex; gap: 0.5rem; justify-content: center; align-items: center; margin-top: 1rem; }
        .pagination a, .pagination span { padding: 0.3rem 0.7rem; border-radius: 4px; text-decoration: none; font-size: 0.85rem; }
        .pagination .current { background: var(--pico-primary-background); color: var(--pico-primary-inverse); }
        .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
        .badge-success { background: #1e3a2f; color: #6ee7a0; border: 1px solid #2d5a42; }
        .badge-warning { background: #3a3520; color: #fbbf24; border: 1px solid #5a4f2d; }
        .badge-danger { background: #3a1e20; color: #f87171; border: 1px solid #5a2d30; }
        .badge-info { background: #1e2e3a; color: #67b8e3; border: 1px solid #2d4a5a; }
        .badge-secondary { background: #2a2d30; color: #9ca3af; border: 1px solid #3a3d42; }
        .mono { font-family: monospace; font-size: 0.8rem; }
        .export-link { font-size: 0.85rem; }
        .inline-form { display: inline; }
        .inline-form button { padding: 0.2rem 0.5rem; font-size: 0.75rem; margin: 0 0.1rem; }
        .btn-small { padding: 0.2rem 0.5rem; font-size: 0.75rem; }
        .error-box { background: #3a1e20; color: #f87171; border: 1px solid #5a2d30; border-radius: 4px; padding: 0.75rem 1rem; margin-bottom: 1rem; }
        .expand-toggle { cursor: pointer; background: none; border: 1px solid var(--pico-muted-border-color); border-radius: 4px; padding: 0.15rem 0.5rem; font-size: 0.8rem; color: var(--pico-color); line-height: 1; }
        .expand-toggle:hover { background: var(--pico-primary-background); color: var(--pico-primary-inverse); }
        .detail-row td { padding: 0 !important; border-top: none !important; }
        .detail-row .detail-content { padding: 0.75rem 1rem; background: var(--pico-card-background-color); border-left: 3px solid var(--pico-primary-background); }
        .detail-row .detail-content h4 { font-size: 0.85rem; margin: 0.75rem 0 0.25rem; }
        .detail-row .detail-content h4:first-child { margin-top: 0; }
        .detail-row .detail-content table { font-size: 0.8rem; margin-bottom: 0.5rem; }
        .detail-row .detail-content .loading { color: var(--pico-muted-color); font-style: italic; }
        .user-cell .username { font-weight: 600; display: block; }
        .user-cell .user-id { font-family: monospace; font-size: 0.75rem; color: var(--pico-muted-color); display: block; }
        .status-cell .left-date { font-size: 0.7rem; color: var(--pico-muted-color); display: block; }
        .guild-roles-card { background: var(--pico-card-background-color); border: 1px solid var(--pico-muted-border-color); border-radius: 6px; padding: 0.75rem; margin-bottom: 0.5rem; }
        .guild-roles-header { margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
        .role-tags { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-bottom: 0.5rem; }
        .role-tag { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 3px; font-size: 0.75rem; background: #2a2d30; color: #d1d5db; border-left: 3px solid #6b7280; line-height: 1.3; }
        .role-tag-synced { background: #1e2e3a; color: #67b8e3; font-weight: 600; }
        .role-tag-sm { font-size: 0.7rem; padding: 0.1rem 0.35rem; }
        .role-sync-details { border-top: 1px solid var(--pico-muted-border-color); padding-top: 0.4rem; margin-top: 0.25rem; }
        .sync-detail-item { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; padding: 0.2rem 0; font-size: 0.8rem; }
        .sync-arrow { font-weight: bold; color: var(--pico-primary); font-size: 0.9rem; min-width: 1.2rem; text-align: center; }
        .sync-target { font-size: 0.8rem; color: var(--pico-color); }
        .guild-roles-error { opacity: 0.6; }
        .text-muted { color: var(--pico-muted-color); }
    </style>
</head>
<body>
    <nav class="container-fluid">
        <ul>
            <li><strong>${t(lang, 'nav_brand')}</strong></li>
        </ul>
        <ul>
            <li>${navLink('/', 'nav_overview')}</li>
            <li>${navLink('/members', 'nav_members')}</li>
            <li>${navLink('/jobs', 'nav_jobs')}</li>
            <li>${navLink('/logs', 'nav_logs')}</li>
            <li>${navLink('/config', 'nav_config')}</li>
            <li><a href="${escapeHtml(toggleUrl)}" role="button" class="outline secondary btn-small">${t(lang, 'lang_toggle')}</a></li>
            <li>${escapeHtml(user.username)} | <a href="/logout">${t(lang, 'nav_logout')}</a></li>
        </ul>
    </nav>
    <main class="container-fluid">
        ${bodyHtml}
    </main>
    <script>
    function toggleDetail(btn, userId, lang) {
        var row = btn.closest('tr');
        var nextRow = row.nextElementSibling;
        if (nextRow && nextRow.classList.contains('detail-row')) {
            nextRow.remove();
            btn.textContent = '+';
            return;
        }
        var detailRow = document.createElement('tr');
        detailRow.className = 'detail-row';
        var td = document.createElement('td');
        td.colSpan = row.children.length;
        td.innerHTML = '<div class="detail-content"><span class="loading">Loading...</span></div>';
        detailRow.appendChild(td);
        row.after(detailRow);
        btn.textContent = '\u2212';
        fetch('/members/' + encodeURIComponent(userId) + '/inline?lang=' + encodeURIComponent(lang))
            .then(function(r) { if (!r.ok) throw new Error(r.statusText); return r.text(); })
            .then(function(html) { td.querySelector('.detail-content').innerHTML = html; })
            .catch(function(err) { td.querySelector('.detail-content').innerHTML = '<span class="badge badge-danger">Error: ' + err.message + '</span>'; });
    }
    function refreshRoles(btn, userId, lang) {
        var detailContent = btn.closest('.detail-content');
        if (!detailContent) return;
        detailContent.innerHTML = '<span class="loading">Refreshing...</span>';
        fetch('/members/' + encodeURIComponent(userId) + '/inline?lang=' + encodeURIComponent(lang) + '&refresh=1')
            .then(function(r) { if (!r.ok) throw new Error(r.statusText); return r.text(); })
            .then(function(html) { detailContent.innerHTML = html; })
            .catch(function(err) { detailContent.innerHTML = '<span class="badge badge-danger">Error: ' + err.message + '</span>'; });
    }
    </script>
</body>
</html>`;
}

function buildLangToggleUrl(currentUrl, currentLang) {
    const url = new URL(currentUrl, 'http://localhost');
    url.searchParams.set('lang', currentLang === 'zh' ? 'en' : 'zh');
    return url.pathname + url.search;
}

function pagination(currentPage, totalItems, pageSize, baseUrl, lang = 'zh') {
    const totalPages = Math.ceil(totalItems / pageSize) || 1;
    if (totalPages <= 1) return '';

    // Build base URL preserving existing query params
    const url = new URL(baseUrl, 'http://localhost');
    const parts = [];

    const maxVisible = 5;
    let start = Math.max(1, currentPage - Math.floor(maxVisible / 2));
    let end = Math.min(totalPages, start + maxVisible - 1);
    if (end - start + 1 < maxVisible) {
        start = Math.max(1, end - maxVisible + 1);
    }

    const makeLink = (p, label) => {
        url.searchParams.set('page', p);
        return `<a href="${url.pathname}${url.search}">${label}</a>`;
    };

    if (currentPage > 1) {
        parts.push(makeLink(currentPage - 1, t(lang, 'pagination_prev')));
    }

    if (start > 1) {
        parts.push(makeLink(1, '1'));
        if (start > 2) parts.push('<span>...</span>');
    }

    for (let i = start; i <= end; i++) {
        if (i === currentPage) {
            parts.push(`<span class="current">${i}</span>`);
        } else {
            parts.push(makeLink(i, String(i)));
        }
    }

    if (end < totalPages) {
        if (end < totalPages - 1) parts.push('<span>...</span>');
        parts.push(makeLink(totalPages, String(totalPages)));
    }

    if (currentPage < totalPages) {
        parts.push(makeLink(currentPage + 1, t(lang, 'pagination_next')));
    }

    return `<div class="pagination">${parts.join('')}</div>`;
}

function statusBadge(status, lang = 'zh') {
    const map = {
        pending: 'badge-warning',
        processing: 'badge-info',
        completed: 'badge-success',
        failed: 'badge-danger',
        cancelled: 'badge-secondary',
        success: 'badge-success',
        skipped: 'badge-secondary',
        noop: 'badge-secondary',
        planned: 'badge-info',
    };
    const cls = map[status] || 'badge-secondary';
    const key = `status_${status}`;
    const translated = t(lang, key);
    const label = translated === key ? status : translated; // fallback to raw status if no translation
    return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

module.exports = { layout, pagination, statusBadge, escapeHtml };
