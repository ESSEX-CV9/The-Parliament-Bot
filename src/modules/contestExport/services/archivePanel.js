// src/modules/contestExport/services/archivePanel.js
// 赛事归档帖里的投稿面板：概览卡片 + 「查看所有参赛作品」（复用 c_all_ 分页浏览）+ 「查询作品」。
// 只读赛事数据；唯一的写操作是在指定帖子里发一条面板消息。
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { pickContest } = require('./exportBuilder');

const PREFIX = 'ctxp:';
const SEARCH_BUTTON = `${PREFIX}q:`;
const SEARCH_MODAL = `${PREFIX}qm:`;
const PANEL_MARKER = '赛事投稿面板';
const MAX_RESULTS = 10;
const MAX_AWARDS = 10;

function truncate(text, max) {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function escapeLinkText(text) {
    return String(text ?? '').replace(/[[\]]/g, m => (m === '[' ? '［' : '］'));
}

function formatEntry(submission) {
    const title = escapeLinkText(truncate(submission.title || '（无标题）', 80));
    const head = submission.workUrl ? `[${title}](${submission.workUrl})` : title;
    const meta = [];
    if (submission.submitterId) meta.push(`<@${submission.submitterId}>`);
    const time = submission.postedAt || submission.submittedAt;
    if (time) meta.push(`<t:${Math.floor(new Date(time).getTime() / 1000)}:d>`);
    if (submission.award) meta.push(`🏆 ${truncate(submission.award.name, 40)}`);
    return `**${submission.contestSubmissionId ?? '-'}.** ${head}${meta.length ? `\n　${meta.join('｜')}` : ''}`;
}

/** 由原始赛事记录与投稿记录生成整理后的赛事（与导出格式一致） */
function loadContest(rawContest, rawSubmissions, channelId) {
    if (!rawContest) return null;
    return pickContest({ ...rawContest, channelId }, rawSubmissions || []);
}

function buildPanelMessage(contest) {
    const valid = contest.submissions.filter(item => item.isValid);
    const awarded = valid.filter(item => item.award);
    const embed = new EmbedBuilder()
        .setTitle(`🏆 ${truncate(contest.title || '未知赛事', 240)}`)
        .setColor('#FFD700')
        .setDescription([
            `📊 有效投稿 **${contest.stats.valid}** 个（总计 ${contest.stats.total}），获奖 **${contest.stats.awarded}** 个`,
            contest.applicantId ? `🎤 主办人：<@${contest.applicantId}>` : null,
            '',
            '点「📋 查看所有参赛作品」分页浏览全部投稿，点「🔍 查询作品」按标题、作者或投稿人查找。结果只有你自己看得到。',
        ].filter(line => line !== null).join('\n'))
        .setFooter({ text: `${PANEL_MARKER} · 原赛事频道 ${contest.channelId}` });

    if (awarded.length) {
        let value = '';
        for (const item of awarded.slice(0, MAX_AWARDS)) {
            const line = formatEntry(item);
            if (value.length + line.length + 1 > 1000) break;
            value += `${value ? '\n' : ''}${line}`;
        }
        if (awarded.length > MAX_AWARDS) value += `\n……共 ${awarded.length} 个获奖作品`;
        embed.addFields({ name: '🏅 获奖作品', value });
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`c_all_${contest.channelId}`)
            .setLabel('📋 查看所有参赛作品')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(valid.length === 0),
        new ButtonBuilder()
            .setCustomId(`${SEARCH_BUTTON}${contest.channelId}`)
            .setLabel('🔍 查询作品')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(valid.length === 0),
    );
    return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

function searchSubmissions(contest, keyword) {
    const query = String(keyword || '').trim().toLowerCase();
    if (!query) return [];
    return contest.submissions.filter(item => item.isValid && [
        item.title, item.authorName, item.description, item.submitterId,
        item.contestSubmissionId != null ? String(item.contestSubmissionId) : null,
        item.award?.name,
    ].some(field => field && String(field).toLowerCase().includes(query)));
}

function buildSearchReply(contest, keyword, results) {
    const embed = new EmbedBuilder()
        .setTitle(`🔍 「${truncate(keyword, 50)}」的查询结果`)
        .setColor('#87CEEB')
        .setFooter({ text: truncate(contest.title || '未知赛事', 100) });
    if (!results.length) {
        embed.setDescription('没有找到匹配的作品。可以试试标题里的关键词、作者名，或投稿人的用户 ID。');
        return { embeds: [embed], allowedMentions: { parse: [] } };
    }
    let description = '';
    let shown = 0;
    for (const item of results.slice(0, MAX_RESULTS)) {
        const line = formatEntry(item);
        if (description.length + line.length + 2 > 3800) break;
        description += `${description ? '\n\n' : ''}${line}`;
        shown += 1;
    }
    if (results.length > shown) description += `\n\n共找到 ${results.length} 个，只显示前 ${shown} 个，换个更精确的关键词试试。`;
    embed.setDescription(description);
    return { embeds: [embed], allowedMentions: { parse: [] } };
}

function buildSearchModal(channelId) {
    return new ModalBuilder()
        .setCustomId(`${SEARCH_MODAL}${channelId}`)
        .setTitle('查询参赛作品')
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('keyword')
                .setLabel('关键词（标题 / 作者名 / 投稿人 ID / 编号）')
                .setStyle(TextInputStyle.Short)
                .setMinLength(1)
                .setMaxLength(100)
                .setRequired(true),
        ));
}

function isArchivePanelCustomId(customId) {
    return typeof customId === 'string' && customId.startsWith(PREFIX);
}

module.exports = {
    PREFIX,
    SEARCH_BUTTON,
    SEARCH_MODAL,
    PANEL_MARKER,
    loadContest,
    buildPanelMessage,
    searchSubmissions,
    buildSearchReply,
    buildSearchModal,
    isArchivePanelCustomId,
};
