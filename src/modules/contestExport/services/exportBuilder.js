// src/modules/contestExport/services/exportBuilder.js
// 只读：把赛事频道与投稿记录整理成可下载的 JSON 快照，不修改任何数据文件。

const EXPORT_VERSION = 1;

function toIso(value) {
    if (value === null || value === undefined || value === '') return null;
    const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function buildWorkUrl(submission) {
    const info = submission?.parsedInfo;
    if (info?.guildId && info?.channelId && info?.messageId) {
        return `https://discord.com/channels/${info.guildId}/${info.channelId}/${info.messageId}`;
    }
    if (submission?.originalUrl) {
        return String(submission.originalUrl).split('~')[0];
    }
    return null;
}

function pickSubmission(submission) {
    const preview = submission.cachedPreview || {};
    return {
        globalId: submission.globalId ?? null,
        contestSubmissionId: submission.contestSubmissionId ?? null,
        submitterId: submission.submitterId ?? null,
        workUrl: buildWorkUrl(submission),
        originalUrl: submission.originalUrl ?? null,
        linkType: submission.linkType ?? null,
        title: preview.title ?? null,
        authorName: preview.authorName ?? null,
        postedAt: toIso(preview.timestamp),
        submittedAt: toIso(submission.submittedAt),
        description: submission.submissionDescription ?? null,
        isValid: submission.isValid !== false,
        isExternal: Boolean(submission.isExternal),
        award: submission.awardInfo?.awardName
            ? { name: submission.awardInfo.awardName, message: submission.awardInfo.awardMessage || null }
            : null,
    };
}

function pickContest(contest, submissions) {
    const sorted = [...submissions].sort(
        (a, b) => (Number(a.contestSubmissionId) || 0) - (Number(b.contestSubmissionId) || 0),
    );
    const picked = sorted.map(pickSubmission);
    const valid = picked.filter(item => item.isValid);
    return {
        channelId: contest.channelId ?? null,
        guildId: contest.guildId ?? null,
        title: contest.contestTitle ?? null,
        theme: contest.contestTheme ?? null,
        applicantId: contest.applicantId ?? null,
        trackId: contest.trackId ?? null,
        isFinished: Boolean(contest.isFinished),
        createdAt: toIso(contest.createdAt),
        stats: {
            total: picked.length,
            valid: valid.length,
            awarded: valid.filter(item => item.award).length,
        },
        submissions: picked,
    };
}

/**
 * @param {Object} channels contestChannels.json 内容 { [channelId]: contest }
 * @param {Object} submissions contestSubmissions.json 内容 { [globalId]: submission }
 * @param {string} guildId 只导出属于该服务器的赛事；早期缺少 guildId 的记录也一并导出并标注 guildIdMissing
 */
function buildContestExport(channels, submissions, guildId, now = new Date()) {
    const byChannel = new Map();
    for (const submission of Object.values(submissions || {})) {
        if (!submission?.contestChannelId) continue;
        const list = byChannel.get(submission.contestChannelId) || [];
        list.push(submission);
        byChannel.set(submission.contestChannelId, list);
    }

    const contests = [];
    for (const [channelId, contest] of Object.entries(channels || {})) {
        if (!contest || typeof contest !== 'object') continue;
        if (contest.guildId && contest.guildId !== guildId) continue;
        const record = pickContest({ ...contest, channelId }, byChannel.get(channelId) || []);
        if (!contest.guildId) record.guildIdMissing = true;
        contests.push(record);
    }
    contests.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

    return {
        version: EXPORT_VERSION,
        guildId,
        generatedAt: now.toISOString(),
        stats: {
            contests: contests.length,
            submissions: contests.reduce((sum, item) => sum + item.stats.total, 0),
            validSubmissions: contests.reduce((sum, item) => sum + item.stats.valid, 0),
        },
        contests,
    };
}

module.exports = { buildContestExport, buildWorkUrl, EXPORT_VERSION };
