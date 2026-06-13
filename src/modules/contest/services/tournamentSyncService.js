// src/modules/contest/services/tournamentSyncService.js
const forumApi = require('./forumApiService');
const { getSubmissionsByChannel, getAllContestChannels, getContestApplication } = require('../utils/contestDatabase');

// 前端简介显示上限 600 字，留安全余量截断到 580
const DESCRIPTION_MAX_LEN = 580;

// 解析书单简介：优先用 channelData 上持久化的主题，历史赛事则回查申请的「主题和参赛要求」
async function resolveDescription(channelData) {
    let theme = channelData.contestTheme;
    if (!theme && channelData.applicationId) {
        try {
            const app = await getContestApplication(channelData.applicationId);
            theme = app?.formData?.theme;
        } catch (_) { /* 回查失败则留空 */ }
    }
    if (!theme || typeof theme !== 'string') return undefined;
    const trimmed = theme.trim();
    if (!trimmed) return undefined;
    return trimmed.length > DESCRIPTION_MAX_LEN
        ? `${trimmed.slice(0, DESCRIPTION_MAX_LEN - 1)}…`
        : trimmed;
}

// 索引页 API 的日期解析（Python datetime.fromisoformat）不接受带 Z/时区后缀的字符串，
// 否则插入时报 500。此处统一转成无时区的 naive ISO 格式（如 2025-06-05T02:52:45.403）。
function toApiDateTime(value) {
    if (!value) return undefined;
    const d = new Date(value);
    if (isNaN(d.getTime())) return undefined;
    return d.toISOString().replace('Z', '');
}

async function onContestCreated(channelData) {
    try {
        const description = await resolveDescription(channelData);
        const result = await forumApi.createTournament(
            channelData.channelId,
            channelData.applicantId,
            channelData.contestTitle,
            description,
        );
        console.log(`[TournamentSync] 书单已创建 - 频道: ${channelData.channelId}, 新建: ${result?.created}`);
    } catch (e) {
        console.warn(`[TournamentSync] 创建书单失败 - 频道: ${channelData.channelId}:`, e.message);
    }
}

async function onSubmissionAdded(submission) {
    try {
        const participatedAt = toApiDateTime(submission.submittedAt);
        await forumApi.addItems(submission.contestChannelId, [{
            thread_id: submission.parsedInfo.channelId,
            ...(participatedAt ? { tournament_participated_at: participatedAt } : {}),
            ...(submission.submissionDescription ? { comment: submission.submissionDescription } : {}),
        }]);
        console.log(`[TournamentSync] 投稿已同步到书单 - 帖子: ${submission.parsedInfo.channelId}`);
    } catch (e) {
        console.warn(`[TournamentSync] 同步投稿失败 - 帖子: ${submission.parsedInfo.channelId}:`, e.message);
    }
}

async function onSubmissionRemoved(submission) {
    try {
        await forumApi.removeItems(submission.contestChannelId, [submission.parsedInfo.channelId]);
        console.log(`[TournamentSync] 投稿已从书单移除 - 帖子: ${submission.parsedInfo.channelId}`);
    } catch (e) {
        console.warn(`[TournamentSync] 移除投稿失败 - 帖子: ${submission.parsedInfo.channelId}:`, e.message);
    }
}

async function onContestTitleUpdated(channelId, newTitle) {
    try {
        await forumApi.updateTournament(channelId, { title: newTitle });
        console.log(`[TournamentSync] 书单标题已更新 - 频道: ${channelId}`);
    } catch (e) {
        console.warn(`[TournamentSync] 更新书单标题失败 - 频道: ${channelId}:`, e.message);
    }
}

async function retroSync(guildId, targetChannelId) {
    const allChannels = getAllContestChannels();

    const channels = Object.values(allChannels).filter(ch => {
        if (ch.guildId !== guildId) return false;
        if (targetChannelId && ch.channelId !== targetChannelId) return false;
        return true;
    });

    const stats = { total: channels.length, synced: 0, addedItems: 0, skippedItems: 0, errors: [] };

    for (const channelData of channels) {
        try {
            // 1. 创建赛事书单（幂等，已存在则直接返回）
            const description = await resolveDescription(channelData);
            await forumApi.createTournament(
                channelData.channelId,
                channelData.applicantId,
                channelData.contestTitle,
                description,
            );

            // 1.5 同步标题与简介（createTournament 幂等，已存在时不更新元信息，此处兜底自愈漂移）
            const patch = {};
            if (channelData.contestTitle) patch.title = channelData.contestTitle;
            if (description) patch.description = description;
            if (Object.keys(patch).length > 0) {
                try {
                    await forumApi.updateTournament(channelData.channelId, patch);
                } catch (e) {
                    console.warn(`[TournamentSync] 同步元信息失败 - 频道 ${channelData.channelId}:`, e.message);
                }
            }

            // 2. 分页获取 API 上已有的帖子 ID 集合
            const existingIds = new Set();
            let offset = 0;
            const pageSize = 100;
            while (true) {
                const page = await forumApi.getItems(channelData.channelId, pageSize, offset);
                if (!page || !page.results || page.results.length === 0) break;
                for (const item of page.results) existingIds.add(String(item.thread_id));
                if (page.results.length < pageSize) break;
                offset += pageSize;
            }

            // 3. 本地有效投稿中筛出 API 尚未收录的
            const localSubmissions = await getSubmissionsByChannel(channelData.channelId);
            const toAdd = localSubmissions.filter(s =>
                s.isValid !== false &&
                s.parsedInfo?.channelId &&
                !existingIds.has(String(s.parsedInfo.channelId))
            );

            // 4. 逐条添加，精确统计成功/跳过数
            for (const sub of toAdd) {
                try {
                    const participatedAt = toApiDateTime(sub.submittedAt);
                    await forumApi.addItems(channelData.channelId, [{
                        thread_id: sub.parsedInfo.channelId,
                        ...(participatedAt ? { tournament_participated_at: participatedAt } : {}),
                        ...(sub.submissionDescription ? { comment: sub.submissionDescription } : {}),
                    }]);
                    stats.addedItems++;
                } catch (e) {
                    stats.skippedItems++;
                    console.warn(`[TournamentSync] 跳过帖子 ${sub.parsedInfo.channelId}:`, e.message);
                }
            }

            stats.synced++;
        } catch (e) {
            stats.errors.push({
                channelId: channelData.channelId,
                title: channelData.contestTitle || channelData.channelId,
                error: e.message,
            });
            console.error(`[TournamentSync] retroSync 失败 - 频道 ${channelData.channelId}:`, e.message);
        }
    }

    return stats;
}

// 删除单个赛事书单
async function deleteBooklist(channelId) {
    await forumApi.deleteTournament(channelId);
}

// 列出本服在索引页上已建的赛事书单（与本地 contestChannels 按 guildId 交叉过滤，避免误删其他服）
async function listGuildBooklists(guildId) {
    const allChannels = getAllContestChannels();
    const guildChannelIds = new Set(
        Object.values(allChannels)
            .filter(ch => ch.guildId === guildId)
            .map(ch => String(ch.channelId))
    );

    const booklists = [];
    let offset = 0;
    const pageSize = 100;
    while (true) {
        const page = await forumApi.listTournaments(pageSize, offset);
        const results = page?.results || [];
        for (const t of results) {
            const chId = String(t.tournament_channel_id);
            if (guildChannelIds.has(chId)) {
                booklists.push({
                    channelId: chId,
                    title: t.title || allChannels[chId]?.contestTitle || chId,
                    itemCount: t.item_count ?? 0,
                });
            }
        }
        if (results.length < pageSize) break;
        offset += pageSize;
    }
    return booklists;
}

// 删除本服全部赛事书单，返回删除统计
async function deleteAllGuildBooklists(guildId) {
    const booklists = await listGuildBooklists(guildId);
    const stats = { total: booklists.length, deleted: 0, errors: [] };
    for (const bl of booklists) {
        try {
            await forumApi.deleteTournament(bl.channelId);
            stats.deleted++;
        } catch (e) {
            stats.errors.push({ channelId: bl.channelId, title: bl.title, error: e.message });
            console.warn(`[TournamentSync] 删除书单失败 - 频道 ${bl.channelId}:`, e.message);
        }
    }
    return stats;
}

module.exports = {
    onContestCreated,
    onSubmissionAdded,
    onSubmissionRemoved,
    onContestTitleUpdated,
    retroSync,
    deleteBooklist,
    listGuildBooklists,
    deleteAllGuildBooklists,
};
