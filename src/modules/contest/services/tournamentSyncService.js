// src/modules/contest/services/tournamentSyncService.js
const forumApi = require('./forumApiService');
const { getSubmissionsByChannel, getAllContestChannels } = require('../utils/contestDatabase');

async function onContestCreated(channelData) {
    try {
        const result = await forumApi.createTournament(
            channelData.channelId,
            channelData.applicantId,
            channelData.contestTitle,
        );
        console.log(`[TournamentSync] 书单已创建 - 频道: ${channelData.channelId}, 新建: ${result?.created}`);
    } catch (e) {
        console.warn(`[TournamentSync] 创建书单失败 - 频道: ${channelData.channelId}:`, e.message);
    }
}

async function onSubmissionAdded(submission) {
    try {
        await forumApi.addItems(submission.contestChannelId, [{
            thread_id: submission.parsedInfo.channelId,
            tournament_participated_at: submission.submittedAt,
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
            await forumApi.createTournament(
                channelData.channelId,
                channelData.applicantId,
                channelData.contestTitle,
            );

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
                    await forumApi.addItems(channelData.channelId, [{
                        thread_id: sub.parsedInfo.channelId,
                        tournament_participated_at: sub.submittedAt,
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

module.exports = { onContestCreated, onSubmissionAdded, onSubmissionRemoved, onContestTitleUpdated, retroSync };
