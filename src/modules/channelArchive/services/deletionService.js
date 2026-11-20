// src/modules/channelArchive/services/deletionService.js
const { getStore } = require('../store/instance');
const {
    ARCHIVE_STATUS,
    AUDIT_ACTION,
    SUBTHREAD_STATUS,
} = require('../utils/constants');
const { truncate } = require('../utils/text');

async function fetchThread(client, threadId) {
    if (!threadId) return null;
    const channel = await client.channels.fetch(threadId).catch(() => null);
    if (!channel || !channel.isThread?.()) return null;
    return channel;
}

async function notifyChannel(channel, content) {
    if (!channel?.send) return;
    await channel.send({
        content,
        allowedMentions: { parse: [] },
    }).catch(error => {
        console.warn('[ChannelArchive] 发送删除校验提示失败:', error.message);
    });
}

function buildProblemText(problems) {
    const lines = problems.slice(0, 8).map(item => `- ${truncate(item, 150)}`);
    return [
        '❌ **删除已终止：备份不完整**',
        '以下核验未通过，原频道不会被删除：',
        ...lines,
        '',
        '请先修复主帖/子区帖或使用 `/频道归档 重试` 补齐归档后再发起删除投票。',
    ].join('\n');
}

/**
 * 删除投票通过后执行：核验主帖与全部子区帖仍存在，再删除原文字频道。
 */
async function deleteArchivedChannel(client, vote) {
    const store = getStore();
    const record = store.getArchive(vote.channel_id);
    const channel = await client.channels.fetch(vote.channel_id).catch(() => null);

    if (!record) {
        await notifyChannel(channel, '❌ 删除已终止：找不到该频道的归档记录。');
        return { ok: false, reason: 'missing_record' };
    }

    if (record.status === ARCHIVE_STATUS.DELETED) {
        await notifyChannel(channel, 'ℹ️ 该频道已标记为已删除，无需重复操作。');
        return { ok: false, reason: 'already_deleted' };
    }

    if (!channel) {
        // 频道已被手动删除：直接落库并记录审计。
        store.markDeleted(record.source_channel_id);
        store.addAudit({
            guildId: record.guild_id,
            actionType: AUDIT_ACTION.CHANNEL_DELETE,
            channelId: record.source_channel_id,
            channelName: record.source_channel_name,
            initiatorId: vote.initiator_id,
            votersSnapshot: vote.approvedUsers,
            targetThreadId: record.target_thread_id,
        });
        return { ok: true, reason: 'channel_already_gone' };
    }

    if (record.status !== ARCHIVE_STATUS.ARCHIVED) {
        await notifyChannel(channel, `❌ 删除已终止：归档状态为 \`${record.status}\`，必须完成归档后才能删除。`);
        return { ok: false, reason: 'not_archived' };
    }

    const problems = [];

    if (!record.target_thread_id) {
        problems.push('主备份帖未记录');
    } else {
        const mainThread = await fetchThread(client, record.target_thread_id);
        if (!mainThread) {
            problems.push(`主备份帖 ${record.target_thread_id} 已不存在`);
        } else if (record.target_forum_id && mainThread.parentId !== record.target_forum_id) {
            problems.push(`主备份帖 ${record.target_thread_id} 已不在目标论坛中`);
        }
    }

    const subRows = store.listSubthreads(record.source_channel_id);
    for (const row of subRows) {
        if (row.status !== SUBTHREAD_STATUS.ARCHIVED) {
            problems.push(`子区「${row.thread_name}」归档未完成（${row.status}）`);
            continue;
        }
        if (!row.target_thread_id) {
            problems.push(`子区「${row.thread_name}」缺少备份帖记录`);
            continue;
        }
        const subThread = await fetchThread(client, row.target_thread_id);
        if (!subThread) {
            problems.push(`子区「${row.thread_name}」的备份帖 ${row.target_thread_id} 已不存在`);
        } else if (row.target_forum_id && subThread.parentId !== row.target_forum_id) {
            problems.push(`子区「${row.thread_name}」的备份帖已不在目标论坛中`);
        }
    }

    if (problems.length) {
        await notifyChannel(channel, buildProblemText(problems));
        return { ok: false, reason: 'verification_failed', problems };
    }

    try {
        await channel.delete('归档频道删除投票通过，备份已核验');
    } catch (error) {
        if (error?.code === 10003) {
            store.markDeleted(record.source_channel_id);
            return { ok: true, reason: 'channel_already_gone' };
        }
        console.error('[ChannelArchive] 删除频道失败:', error);
        await notifyChannel(channel, `❌ 删除频道失败：${truncate(error.message, 300)}`);
        return { ok: false, reason: 'delete_failed' };
    }

    store.markDeleted(record.source_channel_id);
    store.addAudit({
        guildId: record.guild_id,
        actionType: AUDIT_ACTION.CHANNEL_DELETE,
        channelId: record.source_channel_id,
        channelName: record.source_channel_name,
        initiatorId: vote.initiator_id,
        votersSnapshot: vote.approvedUsers,
        targetThreadId: record.target_thread_id,
    });
    return { ok: true, reason: 'deleted' };
}

module.exports = {
    deleteArchivedChannel,
};
