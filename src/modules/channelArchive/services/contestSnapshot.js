// src/modules/channelArchive/services/contestSnapshot.js
const { getContestChannel, getSubmissionsByChannel } = require('../../contest/utils/contestDatabase');
const { truncate } = require('../utils/text');

const APPENDIX_BUDGET = 1800;

function isValidSubmission(submission) {
    return Boolean(submission) && submission.isValid !== false;
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

function buildSubmissionLine(submission, index) {
    const url = buildWorkUrl(submission);
    const title = submission?.cachedPreview?.title;
    let link = '（无作品链接）';
    if (url) link = title ? `[${truncate(title, 80)}](${url})` : url;

    const lines = [`${index}. ${link}`];

    const meta = [];
    if (submission.submitterId) meta.push(`👤 <@${submission.submitterId}>`);
    const rawTimestamp = submission.cachedPreview?.timestamp || submission.submittedAt;
    const timestamp = rawTimestamp
        ? (typeof rawTimestamp === 'number' ? rawTimestamp : new Date(rawTimestamp).getTime())
        : null;
    if (Number.isFinite(timestamp)) meta.push(`🕒 <t:${Math.floor(timestamp / 1000)}:f>`);
    if (submission.awardInfo?.awardName) meta.push(`🏆 ${truncate(submission.awardInfo.awardName, 40)}`);
    if (submission.isExternal) meta.push('📡 外服投稿');
    if (meta.length) lines.push(meta.join('｜'));

    if (submission.submissionDescription) {
        lines.push(`📝 ${truncate(submission.submissionDescription, 200)}`);
    }
    if (submission.contestSubmissionId != null) {
        lines.push(`🆔 \`${submission.contestSubmissionId}\``);
    }
    return lines.join('\n');
}

async function getContestSnapshot(channelId) {
    try {
        const contest = await getContestChannel(channelId);
        if (!contest) return null;
        const submissions = await getSubmissionsByChannel(channelId);
        const validSubmissions = submissions.filter(isValidSubmission);
        return {
            contest,
            submissions,
            validSubmissions,
            stats: {
                total: submissions.length,
                valid: validSubmissions.length,
                awarded: validSubmissions.filter(item => item.awardInfo?.awardName).length,
            },
        };
    } catch (error) {
        console.warn('[ChannelArchive] 读取赛事数据失败:', error.message);
        return null;
    }
}

function buildContestFields(snapshot) {
    if (!snapshot) return [];
    const { contest, stats } = snapshot;
    return [
        { name: '赛事名称', value: truncate(contest.contestTitle || '未知', 200), inline: false },
        { name: '赛事主办人', value: contest.applicantId ? `<@${contest.applicantId}>` : '未知', inline: true },
        { name: '赛事状态', value: contest.isFinished ? '已完赛' : '进行中', inline: true },
        { name: '投稿统计', value: `有效 ${stats.valid} / 总计 ${stats.total}｜获奖 ${stats.awarded}`, inline: false },
    ];
}

function buildAppendixContents(snapshot) {
    if (!snapshot?.validSubmissions?.length) return [];
    const chunks = [];
    let current = '';
    for (let index = 0; index < snapshot.validSubmissions.length; index += 1) {
        const line = buildSubmissionLine(snapshot.validSubmissions[index], index + 1);
        const candidate = current ? `${current}\n\n${line}` : line;
        if (current && candidate.length > APPENDIX_BUDGET - 80) {
            chunks.push(current);
            current = line;
        } else {
            current = candidate;
        }
    }
    if (current) chunks.push(current);

    const title = truncate(snapshot.contest.contestTitle || '未知', 80);
    return chunks.map((chunk, index) => (
        `[频道归档] 【赛事附录 ${index + 1}/${chunks.length}】赛事：${title}｜有效作品 ${snapshot.stats.valid} 个\n\n${chunk}`
    ));
}

function buildContestPayload(snapshot) {
    return {
        contest: snapshot.contest,
        stats: snapshot.stats,
        submissions: snapshot.submissions,
    };
}

module.exports = {
    getContestSnapshot,
    buildContestFields,
    buildAppendixContents,
    buildContestPayload,
};
