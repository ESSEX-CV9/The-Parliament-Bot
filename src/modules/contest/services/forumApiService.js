// src/modules/contest/services/forumApiService.js
const BASE_URL = (process.env.FORUM_API_BASE || 'https://forum.shimmerday.top').replace(/\/$/, '');
const API_KEY = (process.env.FORUM_API_KEY || '').trim();

async function apiRequest(method, path, body) {
    const url = `${BASE_URL}${path}`;
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': API_KEY,
        },
    };
    if (body !== undefined) options.body = JSON.stringify(body);

    const res = await fetch(url, options);
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`[ForumAPI] ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return null;
}

// Discord 雪花 ID 超过 JS Number 安全整数范围，需原样传字符串由 Pydantic 强转
async function createTournament(channelId, ownerId, title, description) {
    const body = { tournament_channel_id: channelId, owner_id: ownerId, title };
    if (description) body.description = description;
    return apiRequest('POST', '/v1/tournament/create', body);
}

async function updateTournament(channelId, patch) {
    return apiRequest('PATCH', `/v1/tournament/${channelId}`, patch);
}

async function addItems(channelId, items) {
    return apiRequest('POST', `/v1/tournament/${channelId}/items/add`, { items });
}

async function removeItems(channelId, threadIds) {
    return apiRequest('DELETE', `/v1/tournament/${channelId}/items/delete`, { thread_ids: threadIds });
}

async function getItems(channelId, limit = 100, offset = 0) {
    return apiRequest('GET', `/v1/tournament/${channelId}/items?limit=${limit}&offset=${offset}`);
}

async function deleteTournament(channelId) {
    return apiRequest('DELETE', `/v1/tournament/${channelId}`);
}

async function listTournaments(limit = 100, offset = 0) {
    return apiRequest('GET', `/v1/tournament/list/page?limit=${limit}&offset=${offset}&sort_method=4&sort_order=desc`);
}

module.exports = { createTournament, updateTournament, addItems, removeItems, getItems, deleteTournament, listTournaments };
