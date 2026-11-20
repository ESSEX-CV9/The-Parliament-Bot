// src/modules/channelArchive/index.js
const { initStore, getStore } = require('./store/instance');
const { setVoteHandlers } = require('./services/hooks');
const { getArchiveQueue } = require('./services/archiveQueue');
const { handleVoteInteraction } = require('./services/voteInteraction');
const { deleteArchivedChannel } = require('./services/deletionService');
const { buildPublicPanel } = require('./services/votePanel');
const { AUDIT_ACTION, isArchiveCustomId } = require('./utils/constants');

let activeClient = null;
let started = false;

async function restoreActiveVotes(client) {
    const store = getStore();
    for (const vote of store.listActiveVotes()) {
        try {
            const channel = await client.channels.fetch(vote.channel_id).catch(() => null);
            const message = channel
                ? await channel.messages.fetch(vote.message_id).catch(() => null)
                : null;
            if (!message) {
                store.expireVote(vote.vote_id);
                console.warn(`[ChannelArchive] 投票 ${vote.vote_id} 的面板已不可用，已标记过期。`);
                continue;
            }
            await message.edit(buildPublicPanel(vote, channel.name));
        } catch (error) {
            console.warn(`[ChannelArchive] 恢复投票面板失败 ${vote.vote_id}:`, error.message);
        }
    }
}

async function onArchivePassed(vote) {
    const store = getStore();
    if (!activeClient) return;

    const record = store.getArchive(vote.channel_id);
    const config = store.getConfig(vote.guild_id);
    if (!record || !config) {
        console.warn(`[ChannelArchive] 归档投票 ${vote.vote_id} 通过，但缺少归档记录或服务器配置。`);
        return;
    }

    store.markArchiveStarted(vote.channel_id, config.target_forum_id);
    store.addAudit({
        guildId: vote.guild_id,
        actionType: AUDIT_ACTION.ARCHIVE_START,
        channelId: vote.channel_id,
        channelName: record.source_channel_name,
        initiatorId: vote.initiator_id,
        votersSnapshot: vote.approvedUsers,
        targetThreadId: record.target_thread_id,
    });

    const queued = getArchiveQueue(activeClient).enqueue(vote.channel_id);
    console.log(`[ChannelArchive] 归档投票通过：${record.source_channel_name}（${vote.channel_id}），入队=${queued}`);
}

async function onDeletePassed(vote) {
    if (!activeClient) return;
    const result = await deleteArchivedChannel(activeClient, vote);
    console.log(`[ChannelArchive] 删除投票处理完成：${vote.channel_id}，结果=${result.reason}`);
}

async function startChannelArchiveSystem(client) {
    if (started) return;

    initStore();
    started = true;
    activeClient = client;
    const store = getStore();
    store.expireOverdueVotes();
    setVoteHandlers({ onArchivePassed, onDeletePassed });

    await restoreActiveVotes(client);
    getArchiveQueue(client).start();
    console.log('[ChannelArchive] 频道归档系统已启动');
}

function stopChannelArchiveSystem() {
    // 进程退出时保留数据库连接，避免在途任务访问已关闭的 store。
    if (activeClient) getArchiveQueue(activeClient).stop();
    started = false;
    activeClient = null;
}

async function handleChannelArchiveInteraction(interaction) {
    if (!isArchiveCustomId(interaction.customId)) return false;
    return handleVoteInteraction(interaction);
}

module.exports = {
    startChannelArchiveSystem,
    stopChannelArchiveSystem,
    handleChannelArchiveInteraction,
};
