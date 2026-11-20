// src/modules/contestExport/services/panelPublisher.js
// 按对照表把投稿面板发到对应归档帖。已有面板的帖子跳过；归档/锁定的帖子发完后恢复原状。
const { PANEL_MARKER, buildPanelMessage, loadContest } = require('./archivePanel');

const MAX_ENTRIES = 300;
const ID_PATTERN = /^\d{15,25}$/;

function parseMapping(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch (_) {
        throw new Error('对照表不是有效的 JSON');
    }
    if (!Array.isArray(data)) throw new Error('对照表应为数组：[{"threadId": "...", "contestChannelId": "..."}]');
    if (data.length > MAX_ENTRIES) throw new Error(`对照表最多 ${MAX_ENTRIES} 条`);
    const seen = new Set();
    return data.map((item, index) => {
        const threadId = String(item?.threadId ?? '');
        const contestChannelId = String(item?.contestChannelId ?? '');
        if (!ID_PATTERN.test(threadId) || !ID_PATTERN.test(contestChannelId)) {
            throw new Error(`第 ${index + 1} 条的 threadId 或 contestChannelId 无效`);
        }
        if (seen.has(threadId)) throw new Error(`帖子 ${threadId} 重复出现`);
        seen.add(threadId);
        return { threadId, contestChannelId };
    });
}

function hasPanel(messages, botId, contestChannelId) {
    for (const message of messages.values()) {
        if (message.author?.id !== botId) continue;
        const footer = message.embeds?.[0]?.footer?.text || '';
        if (footer.includes(PANEL_MARKER) && footer.includes(contestChannelId)) return true;
    }
    return false;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param {Object} deps
 * @param {import('discord.js').Guild} deps.guild 只允许发到这个服务器内的帖子
 * @param {string} deps.botId
 * @param {(id: string) => Promise<any>} deps.fetchChannel
 * @param {(id: string) => Promise<Object|null>} deps.readContest
 * @param {(id: string) => Promise<Array>} deps.readSubmissions
 * @param {(done: number, total: number) => Promise<void>} [deps.onProgress]
 */
async function publishPanels(entries, deps) {
    const { guild, botId, fetchChannel, readContest, readSubmissions, onProgress = async () => {}, delay = 1200 } = deps;
    const result = { sent: [], skipped: [], failed: [] };

    for (let index = 0; index < entries.length; index += 1) {
        const { threadId, contestChannelId } = entries[index];
        try {
            const contest = loadContest(await readContest(contestChannelId), await readSubmissions(contestChannelId), contestChannelId);
            if (!contest) throw new Error('找不到赛事数据');
            if (contest.guildId && contest.guildId !== guild.id) throw new Error('赛事不属于本服务器');

            const thread = await fetchChannel(threadId).catch(() => null);
            if (!thread || typeof thread.isThread !== 'function' || !thread.isThread() || thread.guildId !== guild.id) {
                throw new Error('找不到本服务器内的这个帖子');
            }

            const recent = await thread.messages.fetch({ limit: 50 }).catch(() => null);
            if (recent && hasPanel(recent, botId, contestChannelId)) {
                result.skipped.push({ threadId, reason: '已有面板' });
            } else {
                const wasArchived = Boolean(thread.archived);
                const wasLocked = Boolean(thread.locked);
                try {
                    if (wasArchived) await thread.setArchived(false);
                    if (wasLocked) await thread.setLocked(false);
                    await thread.send(buildPanelMessage(contest));
                    result.sent.push({ threadId, contestChannelId });
                } finally {
                    if (wasLocked) await thread.setLocked(true).catch(() => {});
                    if (wasArchived) await thread.setArchived(true).catch(() => {});
                }
                if (delay) await sleep(delay);
            }
        } catch (error) {
            result.failed.push({ threadId, contestChannelId, reason: error.message });
        }
        await onProgress(index + 1, entries.length).catch(() => {});
    }
    return result;
}

module.exports = { parseMapping, publishPanels, hasPanel, MAX_ENTRIES };
