// src/modules/channelArchive/services/archiveEngine.js
const fs = require('node:fs');
const path = require('node:path');
const {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    EmbedBuilder,
} = require('discord.js');
const { getStore } = require('../store/instance');
const {
    ARCHIVE_STATUS,
    ARCHIVE_LINK_TITLE,
    AUDIT_ACTION,
    IDLE_CONFIRM_MS,
    PROGRESS_INTERVAL_MS,
    PROGRESS_MARKER,
    SUBTHREAD_STATUS,
    TEMP_ROOT,
    VOTE_TYPE,
    WEBHOOK_SENDER_NAME,
    getUploadLimit,
} = require('../utils/constants');
const {
    compareIds,
    formatBytes,
    formatChinaDateTime,
    formatChinaTime,
    sanitizeFileName,
    sanitizeThreadName,
    sanitizeUsername,
    sleep,
    truncate,
} = require('../utils/text');
const {
    appendCatchup,
    ensureSpool,
    fetchAfter,
    listThreads,
    readRecords,
} = require('./historyReader');
const { composeWebhookParts, sanitizeEmbeds } = require('./contentFormatter');
const { buildAttachmentFiles, buildProblemText } = require('./attachmentService');
const { WebhookTransport } = require('./webhookTransport');
const { createBackupArchive } = require('./backupService');
const {
    buildAppendixContents,
    buildContestFields,
    buildContestPayload,
    getContestSnapshot,
} = require('./contestSnapshot');

function threadUrl(guildId, threadId) {
    return `https://discord.com/channels/${guildId}/${threadId}`;
}

class ArchiveJob {
    constructor(client, record) {
        this.client = client;
        this.store = getStore();
        this.record = record;
        this.guild = null;
        this.channel = null;
        this.config = null;
        this.forum = null;
        this.transport = null;

        this.mainThread = null;
        this.mainStarter = null;
        this.mainManifest = null;
        this.subManifests = new Map();
        this.links = [];
        this.skipIds = new Set();
        this.referenceIndex = new Map();
        this.referenceIndexLimit = 3000;

        this.sentMain = Number(record.total_synced_count) || 0;
        this.mainTotal = 0;
        this.completedSub = 0;
        this.subCount = 0;
        this.catchingUp = false;
        this.hasFailedSubthreads = false;
        this.warnings = [];

        this.uploadLimit = 10 * 1024 * 1024;
        this.contest = null;
        this.mainAlreadyArchived = record.status === ARCHIVE_STATUS.ARCHIVED;
        this.progressMessage = null;
        this.progressTimer = null;
        this.progressBusy = false;
        this.lastProgressText = '';
        this.lastProgressAt = 0;
        this.stopped = false;
    }

    async run() {
        this.record = this.store.getArchive(this.record.source_channel_id) || this.record;
        this.guild = await this.client.guilds.fetch(this.record.guild_id);
        this.channel = await this.guild.channels.fetch(this.record.source_channel_id).catch(() => null);
        if (!this.channel) throw new Error('原频道不存在或无法访问');
        if (this.channel.type !== ChannelType.GuildText) throw new Error('原频道不是普通文字频道');

        this.config = this.store.getConfig(this.guild.id);
        if (!this.config) throw new Error('服务器未配置归档系统');

        this.forum = await this.guild.channels.fetch(this.config.target_forum_id).catch(() => null);
        if (!this.forum || this.forum.type !== ChannelType.GuildForum) {
            throw new Error('目标论坛不存在或类型错误');
        }

        this.uploadLimit = getUploadLimit(this.guild);
        this.contest = await getContestSnapshot(this.channel.id);
        this.transport = new WebhookTransport(this.forum);
        await this.transport.initialize();

        await this.ensureProgressMessage();
        this.startProgressTimer();

        const archiveVote = this.store.getLatestVoteByChannelAndType(this.channel.id, VOTE_TYPE.ARCHIVE);
        if (archiveVote?.message_id) this.skipIds.add(archiveVote.message_id);
        if (this.record.progress_message_id) this.skipIds.add(this.record.progress_message_id);

        if (!this.mainAlreadyArchived) {
            this.mainManifest = await ensureSpool(
                this.channel,
                path.join(TEMP_ROOT, this.channel.id, 'main'),
                {
                    skipIds: this.skipIds,
                    skipMarker: PROGRESS_MARKER,
                    clientUserId: this.client.user.id,
                },
            );
            this.mainTotal = this.mainManifest.total;
        }

        const threads = await listThreads(this.channel);
        for (const thread of threads) {
            this.store.upsertSubthread({
                threadId: thread.id,
                guildId: this.guild.id,
                sourceChannelId: this.channel.id,
                threadName: thread.name || '未命名子区',
                creatorId: thread.ownerId || null,
                createdAt: thread.createdTimestamp || null,
            });
        }

        let subRows = this.store.listSubthreads(this.channel.id);
        this.subCount = subRows.length;
        this.completedSub = subRows.filter(row => row.status === SUBTHREAD_STATUS.ARCHIVED).length;

        for (const row of subRows) {
            if (row.status === SUBTHREAD_STATUS.ARCHIVED) continue;
            try {
                const sourceThread = await this.guild.channels.fetch(row.thread_id).catch(() => null);
                if (!sourceThread) throw new Error('子区不存在或无法访问');
                const manifest = await ensureSpool(
                    sourceThread,
                    path.join(TEMP_ROOT, this.channel.id, 'sub', row.thread_id),
                    {
                        skipIds: this.skipIds,
                        skipMarker: PROGRESS_MARKER,
                        clientUserId: this.client.user.id,
                    },
                );
                this.subManifests.set(row.thread_id, manifest);
            } catch (error) {
                this.store.setSubthread(row.thread_id, {
                    status: SUBTHREAD_STATUS.FAILED,
                    last_error: truncate(error.message, 900),
                });
                this.warnings.push(`子区 ${row.thread_name} 读取失败：${error.message}`);
            }
        }

        subRows = this.store.listSubthreads(this.channel.id);
        this.subCount = subRows.length;
        this.completedSub = subRows.filter(row => row.status === SUBTHREAD_STATUS.ARCHIVED).length;

        if (!this.mainAlreadyArchived) {
            await this.ensureMainThread();
            await this.ensureSubthreadPosts(subRows);
            await this.streamMain();
        } else {
            this.mainThread = await this.fetchThreadById(this.record.target_thread_id);
            if (!this.mainThread) throw new Error('主备份帖已不存在，无法继续子区归档');
            await this.ensureSubthreadPosts(this.store.listSubthreads(this.channel.id));
        }

        const fillRows = this.store.listSubthreads(this.channel.id)
            .filter(row => row.status !== SUBTHREAD_STATUS.ARCHIVED);
        for (let index = 0; index < fillRows.length; index += 1) {
            if (this.stopped) break;
            await this.fillSubthread(fillRows[index], index + 1, fillRows.length);
        }

        if (this.stopped) {
            this.stopProgressTimer();
            return;
        }

        await this.appendContestAppendix();

        const finalRows = this.store.listSubthreads(this.channel.id);
        this.subCount = finalRows.length;
        this.completedSub = finalRows.filter(row => row.status === SUBTHREAD_STATUS.ARCHIVED).length;
        this.hasFailedSubthreads = finalRows.some(row => row.status !== SUBTHREAD_STATUS.ARCHIVED);
        if (this.hasFailedSubthreads) {
            const failed = finalRows.filter(row => row.status !== SUBTHREAD_STATUS.ARCHIVED);
            this.warnings.push(`仍有 ${failed.length} 个子区未完成备份`);
        }

        if (!this.mainAlreadyArchived) {
            await this.finalizeMain();
        }

        await this.editProgressFinal();
        this.stopProgressTimer();

        if (!this.hasFailedSubthreads) {
            this.cleanupTemp();
        }
    }

    stop() {
        this.stopped = true;
        this.stopProgressTimer();
    }

    // ---------- progress ----------
    async ensureProgressMessage() {
        if (this.record.progress_message_id) {
            const existing = await this.channel.messages.fetch(this.record.progress_message_id).catch(() => null);
            if (existing) {
                this.progressMessage = existing;
                return;
            }
        }
        const message = await this.channel.send({
            content: `⏳ ${PROGRESS_MARKER} 归档任务已启动，正在读取历史消息...`,
            allowedMentions: { parse: [] },
        });
        this.progressMessage = message;
        this.store.setArchive(this.channel.id, { progress_message_id: message.id });
        this.record.progress_message_id = message.id;
    }

    startProgressTimer() {
        this.stopProgressTimer();
        this.progressTimer = setInterval(() => {
            this.updateProgress().catch(error => {
                console.warn('[ChannelArchive] 刷新进度失败:', error.message);
            });
        }, PROGRESS_INTERVAL_MS);
        this.progressTimer.unref?.();
    }

    stopProgressTimer() {
        if (this.progressTimer) {
            clearInterval(this.progressTimer);
            this.progressTimer = null;
        }
    }

    progressText() {
        const mainLine = this.mainAlreadyArchived
            ? '主频道：已完成'
            : `主频道：${this.sentMain}/${this.mainTotal}`;
        return [
            `🔄 ${PROGRESS_MARKER} 归档进行中`,
            mainLine,
            `子区：${this.completedSub}/${this.subCount}`,
            this.catchingUp ? '已追平，等待静默确认' : '正在同步消息',
            `更新：${formatChinaTime(Date.now())}`,
        ].join('\n');
    }

    async updateProgress(force = false) {
        if (this.progressBusy || !this.progressMessage) return;
        const now = Date.now();
        if (!force && now - this.lastProgressAt < 5000) return;
        const text = this.progressText();
        if (!force && text === this.lastProgressText) return;

        this.progressBusy = true;
        try {
            this.lastProgressText = text;
            this.lastProgressAt = now;
            await this.progressMessage.edit({
                content: text,
                allowedMentions: { parse: [] },
            });
        } catch (error) {
            console.warn('[ChannelArchive] 编辑进度消息失败:', error.message);
        } finally {
            this.progressBusy = false;
        }
    }

    async editProgressFinal() {
        if (!this.progressMessage) return;
        const mainLink = this.mainThread ? `\n主帖：${threadUrl(this.guild.id, this.mainThread.id)}` : '';
        const warning = this.warnings.length
            ? `\n⚠️ ${this.warnings.slice(0, 5).map(item => truncate(item, 120)).join('\n⚠️ ')}`
            : '';
        const content = [
            `✅ ${PROGRESS_MARKER} 归档流程结束`,
            `主频道已同步：${this.sentMain} 条`,
            `子区：${this.completedSub}/${this.subCount}`,
            warning,
            mainLink,
        ].join('\n').trim();
        try {
            await this.progressMessage.edit({
                content,
                allowedMentions: { parse: [] },
            });
        } catch (error) {
            console.warn('[ChannelArchive] 编辑完成消息失败:', error.message);
        }
    }

    // ---------- threads ----------
    async fetchThreadById(threadId) {
        if (!threadId) return null;
        const channel = await this.client.channels.fetch(threadId).catch(() => null);
        if (!channel || !channel.isThread?.()) return null;
        return channel;
    }

    buildMainEmbed({ final = false } = {}) {
        const archiveVote = this.store.getLatestVoteByChannelAndType(this.channel.id, VOTE_TYPE.ARCHIVE);
        const initiator = archiveVote?.initiator_id ? `<@${archiveVote.initiator_id}>` : '未知';
        const total = Math.max(this.mainTotal, this.sentMain);
        const embed = new EmbedBuilder()
            .setTitle(`📦 频道归档备份：${this.channel.name}`)
            .setColor(final ? 0x57f287 : 0x5865f2)
            .addFields(
                { name: '原始频道', value: `${this.channel.name}\nID: ${this.channel.id}`, inline: true },
                { name: '原始类别', value: this.channel.parentId ? `<#${this.channel.parentId}>\nID: ${this.channel.parentId}` : '无', inline: true },
                { name: '频道简介', value: this.channel.topic ? truncate(this.channel.topic, 200) : '无', inline: false },
                { name: '发起人', value: initiator, inline: true },
                { name: '频道创建时间', value: formatChinaDateTime(this.channel.createdTimestamp), inline: true },
                { name: '归档时间', value: final ? formatChinaDateTime(Date.now()) : '进行中', inline: true },
                { name: '消息总数', value: final ? String(total) : '统计中', inline: true },
                { name: '子区备份', value: `${this.subCount} 个子区`, inline: true },
                { name: '文本备份', value: final ? '见本条消息附件 zip' : '完成后生成', inline: true },
                ...buildContestFields(this.contest),
            )
            .setFooter({ text: '由频道归档系统生成' })
            .setTimestamp(new Date());
        return embed;
    }

    buildSubthreadEmbed(row, { final = false, messageCount = null, zipNote = null } = {}) {
        const mainLink = this.mainThread ? threadUrl(this.guild.id, this.mainThread.id) : '主帖不可用';
        const embed = new EmbedBuilder()
            .setTitle(`🧵 子区归档备份：${row.thread_name}`)
            .setColor(final ? 0x57f287 : 0x5865f2)
            .addFields(
                { name: '原始子区 ID', value: row.thread_id, inline: true },
                { name: '原始父频道', value: `${this.channel.name}\nID: ${this.channel.id}`, inline: true },
                { name: '子区创建者', value: row.thread_creator_id ? `<@${row.thread_creator_id}>` : '未知', inline: true },
                { name: '子区创建时间', value: formatChinaDateTime(row.thread_created_at), inline: true },
                { name: '归档时间', value: final ? formatChinaDateTime(Date.now()) : '进行中', inline: true },
                { name: '消息总数', value: final ? String(messageCount ?? 0) : '统计中', inline: true },
                { name: '主备份帖', value: mainLink, inline: true },
                { name: '原始子区', value: threadUrl(this.guild.id, row.thread_id), inline: true },
                { name: '文本备份', value: zipNote || (final ? '见本条消息附件 zip' : '完成后生成'), inline: true },
            )
            .setFooter({ text: '由频道归档系统生成' })
            .setTimestamp(new Date());
        return embed;
    }

    async ensureMainThread() {
        let thread = await this.fetchThreadById(this.record.target_thread_id);
        if (!thread) {
            thread = await this.forum.threads.create({
                name: sanitizeThreadName(this.channel.name),
                message: { embeds: [this.buildMainEmbed()] },
                reason: '频道归档',
            });
            this.store.setArchive(this.channel.id, {
                target_forum_id: this.forum.id,
                target_thread_id: thread.id,
            });
            this.record.target_thread_id = thread.id;
        }
        this.mainThread = thread;
        if (thread.archived) await thread.setArchived(false).catch(() => {});
        this.mainStarter = await thread.fetchStarterMessage().catch(() => null);
    }

    async createSubthreadPost(row) {
        const thread = await this.forum.threads.create({
            name: sanitizeThreadName(row.thread_name),
            message: { embeds: [this.buildSubthreadEmbed(row)] },
            reason: '子区归档',
        });
        this.store.setSubthread(row.thread_id, {
            target_forum_id: this.forum.id,
            target_thread_id: thread.id,
            status: SUBTHREAD_STATUS.PENDING,
            last_error: null,
        });
        await sleep(300);
        return thread;
    }

    async ensureSubthreadPosts(rows) {
        const pending = rows.filter(row => (
            row.status !== SUBTHREAD_STATUS.ARCHIVED
            && this.subManifests.has(row.thread_id)
        ));
        if (!pending.length) return;

        let unlocked = false;
        if (this.mainAlreadyArchived && this.mainThread) {
            try {
                if (this.mainThread.archived) await this.mainThread.setArchived(false);
                await this.mainThread.setLocked(false);
                unlocked = true;
            } catch (error) {
                console.warn('[ChannelArchive] 解锁主帖失败，无法补建子区帖:', error.message);
            }
        }

        for (const row of pending) {
            let target = await this.fetchThreadById(row.target_thread_id);
            if (!target) {
                try {
                    target = await this.createSubthreadPost(row);
                    row.target_thread_id = target.id;
                } catch (error) {
                    this.store.setSubthread(row.thread_id, {
                        status: SUBTHREAD_STATUS.FAILED,
                        last_error: truncate(error.message, 900),
                    });
                    this.warnings.push(`子区 ${row.thread_name} 建帖失败：${error.message}`);
                    continue;
                }
            }

            if (!this.links.some(link => link.threadId === row.thread_id)) {
                this.links.push({
                    threadId: row.thread_id,
                    name: row.thread_name,
                    targetThreadId: target.id,
                    createdAt: row.thread_created_at || 0,
                    sent: false,
                });
            }
        }

        if (unlocked && this.mainThread) {
            await this.sendRemainingLinks();
            await this.lockThread(this.mainThread);
        }
    }

    async refreshSubthreads() {
        const threads = await listThreads(this.channel);
        for (const thread of threads) {
            const existing = this.store.getSubthread(thread.id);
            if (existing) continue;

            const row = this.store.upsertSubthread({
                threadId: thread.id,
                guildId: this.guild.id,
                sourceChannelId: this.channel.id,
                threadName: thread.name || '未命名子区',
                creatorId: thread.ownerId || null,
                createdAt: thread.createdTimestamp || null,
            });

            try {
                const manifest = await ensureSpool(
                    thread,
                    path.join(TEMP_ROOT, this.channel.id, 'sub', thread.id),
                    {
                        skipIds: this.skipIds,
                        skipMarker: PROGRESS_MARKER,
                        clientUserId: this.client.user.id,
                    },
                );
                this.subManifests.set(thread.id, manifest);
                if (this.mainThread) {
                    const target = await this.createSubthreadPost(row);
                    this.links.push({
                        threadId: row.thread_id,
                        name: row.thread_name,
                        targetThreadId: target.id,
                        createdAt: row.thread_created_at || 0,
                        sent: false,
                    });
                }
                this.subCount += 1;
            } catch (error) {
                this.store.setSubthread(row.thread_id, {
                    status: SUBTHREAD_STATUS.FAILED,
                    last_error: truncate(error.message, 900),
                });
                this.warnings.push(`新子区 ${row.thread_name} 处理失败：${error.message}`);
            }
        }
    }

    // ---------- main stream ----------
    async streamMain() {
        let lastId = this.record.last_synced_message_id || null;
        let sent = Number(this.record.total_synced_count) || 0;
        let counter = 0;

        for await (const record of readRecords(this.mainManifest)) {
            if (this.stopped) return;
            await this.maybeSendLinks(record);
            if (this.isSkipped(record)) continue;
            if (lastId && compareIds(record.id, lastId) <= 0) {
                // 断点续传时也缓存已归档消息，保证后续回复能显示原文。
                this.rememberRecord(record);
                continue;
            }

            await this.sendRecord(this.mainThread, record);
            sent += 1;
            counter += 1;
            lastId = record.id;
            this.sentMain = sent;
            this.store.updateArchiveCheckpoint(this.channel.id, lastId, sent);
            if (counter % 10 === 0) await this.updateProgress();
        }

        if (!lastId && this.mainManifest?.lastMessageId) {
            lastId = this.mainManifest.lastMessageId;
        }

        this.catchingUp = true;
        const result = await this.catchUpChannel({
            sourceChannel: this.channel,
            targetThread: this.mainThread,
            manifest: this.mainManifest,
            lastId,
            sent,
            countTotal: () => { this.mainTotal += 1; },
            beforeSend: record => this.maybeSendLinks(record),
            onCheckpoint: (nextId, nextSent) => {
                this.sentMain = nextSent;
                this.store.updateArchiveCheckpoint(this.channel.id, nextId, nextSent);
            },
            onIdle: async () => {
                await this.refreshSubthreads();
                await this.sendRemainingLinks();
            },
        });
        this.sentMain = result.sent;
        await this.sendRemainingLinks();
        await this.updateProgress(true);
    }

    async catchUpChannel({
        sourceChannel,
        targetThread,
        manifest,
        lastId,
        sent,
        countTotal,
        beforeSend,
        onCheckpoint,
        onIdle,
    }) {
        let idle = 0;
        while (!this.stopped && idle < 2) {
            const batch = await fetchAfter(sourceChannel, lastId, 100);
            if (!batch.length) {
                idle += 1;
                this.catchingUp = true;
                await this.updateProgress(true);
                if (onIdle) {
                    try {
                        await onIdle();
                    } catch (error) {
                        console.warn('[ChannelArchive] 追平期间检查新子区失败:', error.message);
                    }
                }
                await sleep(IDLE_CONFIRM_MS);
                continue;
            }
            idle = 0;
            this.catchingUp = false;

            for (const record of batch) {
                if (this.stopped) break;
                if (lastId && compareIds(record.id, lastId) <= 0) continue;
                if (this.isSkipped(record)) {
                    lastId = record.id;
                    onCheckpoint(lastId, sent);
                    continue;
                }
                if (beforeSend) await beforeSend(record);
                await this.sendRecord(targetThread, record);
                appendCatchup(manifest, record);
                lastId = record.id;
                sent += 1;
                if (countTotal) countTotal();
                onCheckpoint(lastId, sent);
            }
            await this.updateProgress(true);
        }
        return { lastId, sent };
    }

    // ---------- subthreads ----------
    async fillSubthread(row, index, total) {
        let current = this.store.getSubthread(row.thread_id) || row;
        if (current.status === SUBTHREAD_STATUS.ARCHIVED) return;

        try {
            let target = await this.fetchThreadById(current.target_thread_id);
            if (!target) {
                target = await this.createSubthreadPost(current);
                current = this.store.getSubthread(current.thread_id) || current;
                if (this.mainThread) {
                    const wasLocked = this.mainThread.locked || this.mainThread.archived;
                    if (wasLocked) {
                        await this.mainThread.setArchived(false).catch(() => {});
                        await this.mainThread.setLocked(false).catch(() => {});
                    }
                    await this.sendSubthreadLink({
                        threadId: current.thread_id,
                        name: current.thread_name,
                        targetThreadId: target.id,
                        createdAt: current.thread_created_at || Date.now(),
                    });
                    if (wasLocked) await this.lockThread(this.mainThread);
                }
            }

            this.store.setSubthread(current.thread_id, {
                status: SUBTHREAD_STATUS.ARCHIVING,
                last_error: null,
            });
            if (target.archived) await target.setArchived(false).catch(() => {});

            let manifest = this.subManifests.get(current.thread_id);
            if (!manifest) {
                const sourceThread = await this.guild.channels.fetch(current.thread_id).catch(() => null);
                if (!sourceThread) throw new Error('子区不存在或无法访问');
                manifest = await ensureSpool(
                    sourceThread,
                    path.join(TEMP_ROOT, this.channel.id, 'sub', current.thread_id),
                    {
                        skipIds: this.skipIds,
                        skipMarker: PROGRESS_MARKER,
                        clientUserId: this.client.user.id,
                    },
                );
                this.subManifests.set(current.thread_id, manifest);
            }

            let lastId = current.last_synced_message_id || null;
            let sent = Number(current.synced_count) || 0;

            for await (const record of readRecords(manifest)) {
                if (this.stopped) return;
                if (this.isSkipped(record)) continue;
                if (lastId && compareIds(record.id, lastId) <= 0) {
                    this.rememberRecord(record);
                    continue;
                }
                await this.sendRecord(target, record);
                lastId = record.id;
                sent += 1;
                this.store.setSubthread(current.thread_id, {
                    last_synced_message_id: lastId,
                    synced_count: sent,
                });
                if (sent % 10 === 0) await this.updateProgress();
            }

            if (!lastId && manifest.lastMessageId) lastId = manifest.lastMessageId;

            this.catchingUp = true;
            const sourceThread = await this.guild.channels.fetch(current.thread_id).catch(() => null);
            if (!sourceThread) throw new Error('子区不存在或无法访问');
            const result = await this.catchUpChannel({
                sourceChannel: sourceThread,
                targetThread: target,
                manifest,
                lastId,
                sent,
                countTotal: null,
                beforeSend: null,
                onCheckpoint: (nextId, nextSent) => {
                    this.store.setSubthread(current.thread_id, {
                        last_synced_message_id: nextId,
                        synced_count: nextSent,
                    });
                },
            });
            sent = result.sent;

            const baseName = `${sanitizeFileName(current.thread_name)}_${current.thread_id}`;
            const backup = await createBackupArchive({
                manifest,
                meta: {
                    id: current.thread_id,
                    name: current.thread_name,
                    type: 'subthread',
                    guildId: this.guild.id,
                    parentChannelId: this.channel.id,
                    parentChannelName: this.channel.name,
                    creatorId: current.thread_creator_id,
                    createdAt: current.thread_created_at,
                    archivedAt: Date.now(),
                },
                outDir: path.join(TEMP_ROOT, this.channel.id, 'backup', current.thread_id),
                baseName,
            });

            const zipName = `${baseName}.zip`;
            const canAttach = backup.zipSize <= this.uploadLimit * 0.95;
            const starter = await target.fetchStarterMessage().catch(() => null);
            if (starter) {
                await starter.edit({
                    embeds: [this.buildSubthreadEmbed(current, {
                        final: true,
                        messageCount: Math.max(manifest.total, sent),
                        zipNote: canAttach
                            ? `见附件 zip（${formatBytes(backup.zipSize)}）`
                            : `zip 超过上传上限（${formatBytes(backup.zipSize)}），未附加`,
                    })],
                    files: canAttach ? [new AttachmentBuilder(backup.zipPath, { name: zipName })] : [],
                }).catch(error => {
                    console.warn(`[ChannelArchive] 更新子区首楼失败 ${current.thread_id}:`, error.message);
                });
            }

            await this.lockThread(target);
            this.store.setSubthread(current.thread_id, {
                status: SUBTHREAD_STATUS.ARCHIVED,
                last_error: null,
                synced_count: sent,
            });
            this.completedSub += 1;
            await this.updateProgress(true);
        } catch (error) {
            console.error(`[ChannelArchive] 子区归档失败 ${current.thread_id}:`, error);
            this.store.setSubthread(current.thread_id, {
                status: SUBTHREAD_STATUS.FAILED,
                last_error: truncate(error.message, 900),
            });
            this.warnings.push(`子区 ${current.thread_name} 归档失败：${error.message}`);
            await this.updateProgress(true);
        }
    }

    // ---------- links ----------
    async maybeSendLinks(record) {
        const timestamp = record.createdTimestamp || 0;
        for (const link of this.links) {
            if (link.sent) continue;
            if (!link.targetThreadId) continue;
            if ((link.createdAt || 0) <= timestamp) {
                await this.sendSubthreadLink(link);
            }
        }
    }

    async sendSubthreadLink(link) {
        if (!this.mainThread) return;
        if (link.sent) return;
        const url = threadUrl(this.guild.id, link.targetThreadId);
        const content = [
            `${ARCHIVE_LINK_TITLE}：**${truncate(link.name, 80)}**`,
            `原始子区 ID：${link.threadId}`,
            url,
        ].join('\n');
        try {
            await this.transport.send(this.mainThread.id, {
                content,
                username: WEBHOOK_SENDER_NAME,
            });
            link.sent = true;
        } catch (error) {
            console.warn(`[ChannelArchive] 发送子区链接失败 ${link.threadId}:`, error.message);
        }
    }

    async sendRemainingLinks() {
        for (const link of this.links) {
            if (!link.sent) await this.sendSubthreadLink(link);
        }
    }

    // ---------- record sending ----------
    isSkipped(record) {
        if (this.skipIds.has(record.id)) return true;
        if (record.author?.id === this.client.user?.id
            && String(record.content || '').includes(PROGRESS_MARKER)) {
            return true;
        }
        return false;
    }

    rememberRecord(record) {
        const content = String(record.content || '').trim();
        if (!content) return;
        this.referenceIndex.set(record.id, {
            author: record.author?.displayName || '未知用户',
            content: content.slice(0, 300),
        });
        if (this.referenceIndex.size > this.referenceIndexLimit) {
            const oldest = this.referenceIndex.keys().next().value;
            this.referenceIndex.delete(oldest);
        }
    }

    resolveChannelLink(channelId) {
        if (!channelId) return null;
        if (this.channel?.id === channelId && this.mainThread) {
            return { label: '主频道备份', url: threadUrl(this.guild.id, this.mainThread.id) };
        }
        const row = this.store.getSubthread(channelId);
        if (row?.target_thread_id) {
            return {
                label: `子区备份：${row.thread_name}`,
                url: threadUrl(this.guild.id, row.target_thread_id),
            };
        }
        return null;
    }

    async sendRecord(thread, record) {
        const parts = composeWebhookParts(record, {
            resolveReference: id => this.referenceIndex.get(id),
            resolveChannel: id => this.resolveChannelLink(id),
        });
        const embeds = sanitizeEmbeds(record);
        let batches = [];
        let problems = [];

        if (record.attachments?.length) {
            const result = await buildAttachmentFiles(record, this.uploadLimit);
            batches = result.batches;
            problems = result.problems;
        }

        for (let index = 0; index < parts.length; index += 1) {
            const last = index === parts.length - 1;
            let content = parts[index];
            if (last && problems.length) content = `${content}\n${buildProblemText(problems)}`;
            if (content.length > 2000) content = `${content.slice(0, 1999)}…`;

            const payload = {
                content,
                username: sanitizeUsername(record.author?.displayName),
                avatarURL: record.author?.avatarURL || undefined,
            };
            if (last && batches[0]?.length) payload.files = batches[0];
            if (last && embeds.length) payload.embeds = embeds;

            try {
                await this.transport.send(thread.id, payload);
            } catch (error) {
                console.warn(`[ChannelArchive] 消息还原失败 ${record.id}:`, error.message);
                try {
                    await this.transport.send(thread.id, {
                        content: `⚠️ 消息 ${record.id} 还原失败：${truncate(error.message, 150)}`,
                        username: WEBHOOK_SENDER_NAME,
                    });
                } catch (_) {
                    // ignore
                }
            }
        }

        for (let index = 1; index < batches.length; index += 1) {
            try {
                await this.transport.send(thread.id, {
                    content: `-# 📎 附件续传（${index + 1}/${batches.length}）`,
                    username: sanitizeUsername(record.author?.displayName),
                    avatarURL: record.author?.avatarURL || undefined,
                    files: batches[index],
                });
            } catch (error) {
                console.warn(`[ChannelArchive] 附件续传失败 ${record.id}:`, error.message);
            }
        }

        this.rememberRecord(record);
    }

    async appendContestAppendix() {
        if (!this.contest || !this.contest.validSubmissions.length) return;
        const contents = buildAppendixContents(this.contest);
        if (!contents.length) return;

        const thread = this.mainThread || await this.fetchThreadById(this.record.target_thread_id);
        if (!thread) return;
        this.mainThread = thread;

        const wasLocked = Boolean(thread.locked);
        const wasArchived = Boolean(thread.archived);
        try {
            if (wasArchived) await thread.setArchived(false).catch(() => {});
            if (wasLocked) await thread.setLocked(false).catch(() => {});

            const existing = new Set();
            const messages = await thread.messages.fetch({ limit: 100 }).catch(() => null);
            if (messages) {
                for (const message of messages.values()) {
                    const match = String(message.content || '').match(/【赛事附录 (\d+)\/(\d+)】/);
                    if (match && message.author?.id === this.client.user.id) {
                        existing.add(Number(match[1]));
                    }
                }
            }

            for (let index = 0; index < contents.length; index += 1) {
                if (this.stopped) break;
                if (existing.has(index + 1)) continue;
                await thread.send({
                    content: contents[index],
                    allowedMentions: { parse: [] },
                });
                await sleep(300);
            }
        } catch (error) {
            this.warnings.push(`赛事附录发送失败：${error.message}`);
            console.warn('[ChannelArchive] 赛事附录发送失败:', error.message);
        } finally {
            if ((wasLocked || wasArchived) && !this.stopped) {
                await this.lockThread(thread);
            }
        }
    }

    buildContestComponents() {
        if (!this.contest) return [];
        return [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`c_all_${this.channel.id}`)
                    .setLabel('📋 查看所有参赛作品')
                    .setStyle(ButtonStyle.Primary),
            ),
        ];
    }

    // ---------- finalize ----------
    async finalizeMain() {
        const baseName = `${sanitizeFileName(this.channel.name)}_${this.channel.id}`;
        const backup = await createBackupArchive({
            manifest: this.mainManifest,
            meta: {
                id: this.channel.id,
                name: this.channel.name,
                type: 'channel',
                guildId: this.guild.id,
                categoryId: this.channel.parentId || null,
                createdAt: this.channel.createdTimestamp,
                archivedAt: Date.now(),
            },
            outDir: path.join(TEMP_ROOT, this.channel.id, 'backup', 'main'),
            baseName,
            extraFiles: this.contest
                ? [{
                    name: 'contest-submissions.json',
                    content: JSON.stringify(buildContestPayload(this.contest), null, 2),
                }]
                : [],
        });

        const zipName = `${baseName}.zip`;
        const canAttach = backup.zipSize <= this.uploadLimit * 0.95;
        if (!canAttach) {
            this.warnings.push(`主频道 zip 超过上传上限（${formatBytes(backup.zipSize)}），未附加`);
        }

        if (this.mainStarter) {
            await this.mainStarter.edit({
                embeds: [this.buildMainEmbed({ final: true })],
                components: this.buildContestComponents(),
                files: canAttach ? [new AttachmentBuilder(backup.zipPath, { name: zipName })] : [],
            }).catch(error => {
                console.warn('[ChannelArchive] 更新主帖首楼失败:', error.message);
            });
        }

        await this.lockThread(this.mainThread);
        this.store.markArchived(this.channel.id);

        const archiveVote = this.store.getLatestVoteByChannelAndType(this.channel.id, VOTE_TYPE.ARCHIVE);
        this.store.addAudit({
            guildId: this.guild.id,
            actionType: AUDIT_ACTION.ARCHIVE_DONE,
            channelId: this.channel.id,
            channelName: this.channel.name,
            initiatorId: archiveVote?.initiator_id || null,
            votersSnapshot: archiveVote?.approvedUsers || [],
            targetThreadId: this.mainThread?.id || null,
        });

        this.sentMain = Math.max(this.sentMain, this.mainTotal);
        await this.updateProgress(true);
    }

    async lockThread(thread) {
        if (!thread) return;
        try {
            await thread.setLocked(true);
        } catch (error) {
            console.warn(`[ChannelArchive] 锁定帖子失败 ${thread.id}:`, error.message);
        }
        try {
            if (!thread.archived) await thread.setArchived(true);
        } catch (error) {
            console.warn(`[ChannelArchive] 归档帖子失败 ${thread.id}:`, error.message);
        }
    }

    cleanupTemp() {
        try {
            fs.rmSync(path.join(TEMP_ROOT, this.channel.id), { recursive: true, force: true });
        } catch (error) {
            console.warn('[ChannelArchive] 清理临时文件失败:', error.message);
        }
    }
}

module.exports = {
    ArchiveJob,
};
