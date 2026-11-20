// src/modules/channelArchive/services/archiveQueue.js
const { getStore } = require('../store/instance');
const { ARCHIVE_STATUS, SUBTHREAD_STATUS } = require('../utils/constants');
const { truncate } = require('../utils/text');
const { ArchiveJob } = require('./archiveEngine');

const queues = new WeakMap();

function describeError(error) {
    const message = error?.message || String(error);
    if (error?.code === 50013 || /missing permissions/i.test(message)) {
        return [
            '机器人缺少权限。请在**目标论坛频道**（或其所属分类）为机器人授予：',
            '`管理 Webhook`、`创建公开帖子`、`管理帖子`、`发送消息`、`嵌入链接`、`附加文件`、`读取消息历史`。',
        ].join('\n');
    }
    return truncate(message, 500);
}

function needsWork(store, record) {
    if (!record) return false;
    if (record.status === ARCHIVE_STATUS.ARCHIVING) return true;
    if (record.status === ARCHIVE_STATUS.ARCHIVED) {
        if (Number(record.subthreads_complete) !== 1) return true;
        return store.listSubthreads(record.source_channel_id)
            .some(row => row.status !== SUBTHREAD_STATUS.ARCHIVED);
    }
    return false;
}

class ArchiveQueue {
    constructor(client) {
        this.client = client;
        this.waiting = [];
        this.queued = new Set();
        this.current = null;
        this.running = false;
        this.stopped = false;
    }

    enqueue(channelId) {
        if (!channelId || this.stopped) return false;
        if (this.queued.has(channelId)) return false;
        if (this.current?.record?.source_channel_id === channelId) return false;

        const store = getStore();
        if (!needsWork(store, store.getArchive(channelId))) return false;

        this.queued.add(channelId);
        this.waiting.push(channelId);
        void this.drain();
        return true;
    }

    start() {
        this.stopped = false;
        const store = getStore();
        for (const record of store.listRetryable()) {
            this.enqueue(record.source_channel_id);
        }
    }

    async drain() {
        if (this.running || this.stopped) return;
        this.running = true;
        const store = getStore();
        try {
            while (!this.stopped && this.waiting.length) {
                const channelId = this.waiting.shift();
                this.queued.delete(channelId);

                const record = store.getArchive(channelId);
                if (!needsWork(store, record)) continue;

                const job = new ArchiveJob(this.client, record);
                this.current = job;
                try {
                    await job.run();
                } catch (error) {
                    console.error(`[ChannelArchive] 归档任务失败 ${channelId}:`, error);
                    store.setArchive(channelId, { last_error: truncate(error.message, 900) });
                    await this.notifyFailure(channelId, error);
                } finally {
                    job.stopProgressTimer();
                    this.current = null;
                }
            }
        } finally {
            this.running = false;
        }
    }

    async notifyFailure(channelId, error) {
        const channel = await this.client.channels.fetch(channelId).catch(() => null);
        if (!channel?.send) return;
        await channel.send({
            content: [
                '❌ **频道归档失败**',
                describeError(error),
                '',
                '修复后执行 `/频道归档 重试` 继续，已有断点不会丢失。',
            ].join('\n'),
            allowedMentions: { parse: [] },
        }).catch(() => {});
    }

    stop() {
        this.stopped = true;
        this.waiting.length = 0;
        this.queued.clear();
        if (this.current) this.current.stop();
        this.current = null;
    }

    isBusy(channelId) {
        if (!channelId) return false;
        if (this.current?.record?.source_channel_id === channelId) return true;
        return this.queued.has(channelId);
    }

    describe() {
        return {
            running: Boolean(this.current),
            channelId: this.current?.record?.source_channel_id || null,
            waiting: this.waiting.length,
        };
    }
}

function getArchiveQueue(client) {
    if (!queues.has(client)) queues.set(client, new ArchiveQueue(client));
    return queues.get(client);
}

module.exports = {
    ArchiveQueue,
    getArchiveQueue,
};
