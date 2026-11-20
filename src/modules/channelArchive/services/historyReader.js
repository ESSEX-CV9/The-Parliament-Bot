// src/modules/channelArchive/services/historyReader.js
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { MESSAGE_BATCH_SIZE, PROGRESS_MARKER } = require('../utils/constants');
const { compareIds } = require('../utils/text');

function serializeMessage(message) {
    const author = message.author || {};
    const member = message.member;
    const flags = message.flags?.bitfield ?? (Number(message.flags) || 0);

    const avatarURL = member?.displayAvatarURL?.({ extension: 'png', size: 128 })
        || author.displayAvatarURL?.({ extension: 'png', size: 128 })
        || null;

    const embeds = (message.embeds || []).map(embed => {
        try {
            return typeof embed.toJSON === 'function' ? embed.toJSON() : embed;
        } catch (_) {
            return null;
        }
    }).filter(Boolean);

    const stickers = [...(message.stickers?.values?.() || [])].map(sticker => ({
        id: sticker.id,
        name: sticker.name,
        format: sticker.format,
        url: sticker.url,
    }));

    const reactions = [...(message.reactions?.cache?.values?.() || [])].map(reaction => ({
        count: reaction.count,
        emoji: {
            id: reaction.emoji?.id || null,
            name: reaction.emoji?.name || null,
            animated: Boolean(reaction.emoji?.animated),
        },
    }));

    const reference = message.reference ? {
        messageId: message.reference.messageId || null,
        channelId: message.reference.channelId || null,
        guildId: message.reference.guildId || null,
        repliedUser: message.mentions?.repliedUser ? {
            id: message.mentions.repliedUser.id,
            name: message.mentions.repliedUser.globalName
                || message.mentions.repliedUser.displayName
                || message.mentions.repliedUser.username
                || '未知用户',
        } : null,
    } : null;

    const poll = message.poll ? {
        question: message.poll.question?.text || '',
        answers: [...(message.poll.answers?.values?.() || [])].map(answer => ({
            text: answer.text,
            voteCount: answer.voteCount ?? null,
        })),
        allowMultiselect: Boolean(message.poll.allowMultiselect),
        expiresTimestamp: message.poll.expiresTimestamp || null,
    } : null;

    return {
        id: message.id,
        channelId: message.channelId || null,
        content: message.content || '',
        createdTimestamp: message.createdTimestamp || message.createdAt?.getTime?.() || 0,
        editedTimestamp: message.editedTimestamp || null,
        type: message.type,
        flags,
        webhookId: message.webhookId || null,
        pinned: Boolean(message.pinned),
        author: {
            id: author.id || null,
            username: author.username || null,
            displayName: member?.displayName
                || author.globalName
                || author.displayName
                || author.username
                || '未知用户',
            avatarURL,
        },
        attachments: [...(message.attachments?.values?.() || [])].map(attachment => ({
            id: attachment.id,
            name: attachment.name,
            size: attachment.size,
            url: attachment.url,
            proxyURL: attachment.proxyURL,
            contentType: attachment.contentType || null,
            width: attachment.width || null,
            height: attachment.height || null,
        })),
        embeds,
        stickers,
        reactions,
        reference,
        poll,
        mentions: {
            users: [...(message.mentions?.users?.values?.() || [])].map(user => ({
                id: user.id,
                name: user.globalName || user.displayName || user.username || '未知用户',
            })),
            roles: [...(message.mentions?.roles?.values?.() || [])].map(role => ({
                id: role.id,
                name: role.name,
            })),
            channels: [...(message.mentions?.channels?.values?.() || [])].map(channel => ({
                id: channel.id,
                name: channel.name,
            })),
        },
    };
}

function safeSerialize(message) {
    try {
        return serializeMessage(message);
    } catch (error) {
        console.warn(`[ChannelArchive] 序列化消息失败 ${message?.id}:`, error.message);
        return {
            id: message.id,
            channelId: message.channelId || null,
            content: message.content || '',
            createdTimestamp: message.createdTimestamp || 0,
            editedTimestamp: null,
            type: message.type,
            flags: 0,
            webhookId: null,
            pinned: false,
            author: {
                id: message.author?.id || null,
                username: message.author?.username || null,
                displayName: message.author?.username || '未知用户',
                avatarURL: null,
            },
            attachments: [],
            embeds: [],
            stickers: [],
            reactions: [],
            reference: null,
            poll: null,
            mentions: { users: [], roles: [], channels: [] },
        };
    }
}

function shouldSkip(record, { skipIds, skipMarker, clientUserId }) {
    if (skipIds?.has(record.id)) return true;
    if (skipMarker && clientUserId && record.author.id === clientUserId
        && String(record.content || '').includes(skipMarker)) {
        return true;
    }
    return false;
}

function writeJsonl(filePath, records) {
    const content = records.map(record => JSON.stringify(record)).join('\n');
    fs.writeFileSync(filePath, content ? `${content}\n` : '', 'utf8');
}

function readManifest(dir) {
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (!manifest?.complete || !Array.isArray(manifest.pages)) return null;
        return {
            ...manifest,
            dir,
            catchupPath: manifest.catchupPath || path.join(dir, 'catchup.jsonl'),
        };
    } catch (_) {
        return null;
    }
}

/**
 * 首次全量落盘：从最新消息往前翻页，按页写 JSONL；返回按时间正序的页列表。
 */
async function ensureSpool(channel, dir, options = {}) {
    const {
        skipIds = new Set(),
        skipMarker = null,
        clientUserId = null,
    } = options;

    const existing = readManifest(dir);
    if (existing) return existing;

    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    const pages = [];
    let before = null;
    let pageIndex = 0;
    let total = 0;

    for (;;) {
        const fetchOptions = { limit: MESSAGE_BATCH_SIZE };
        if (before) fetchOptions.before = before;

        const batch = await channel.messages.fetch(fetchOptions);
        if (!batch.size) break;

        const messages = [...batch.values()].sort((a, b) => compareIds(a.id, b.id));
        const records = messages.map(safeSerialize).filter(record => !shouldSkip(record, {
            skipIds,
            skipMarker,
            clientUserId,
        }));

        const pageFile = path.join(dir, `page-${String(pageIndex).padStart(5, '0')}.jsonl`);
        writeJsonl(pageFile, records);
        pages.push(pageFile);
        total += records.length;
        pageIndex += 1;

        const oldest = messages.reduce((min, message) => (
            !min || compareIds(message.id, min.id) < 0 ? message : min
        ), null);
        if (!oldest || oldest.id === before) break;
        before = oldest.id;
        if (batch.size < MESSAGE_BATCH_SIZE) break;
    }

    pages.reverse();
    const catchupPath = path.join(dir, 'catchup.jsonl');
    fs.writeFileSync(catchupPath, '', 'utf8');

    const manifest = {
        complete: true,
        pages,
        total,
        catchupPath,
        lastMessageId: channel.lastMessageId || null,
        createdAt: Date.now(),
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return { ...manifest, dir };
}

async function* readRecords(manifest) {
    if (!manifest) return;
    for (const pageFile of manifest.pages) {
        if (!fs.existsSync(pageFile)) continue;
        const input = fs.createReadStream(pageFile, { encoding: 'utf8' });
        const reader = readline.createInterface({ input, crlfDelay: Infinity });
        for await (const line of reader) {
            if (!line.trim()) continue;
            try {
                yield JSON.parse(line);
            } catch (_) {
                // skip broken line
            }
        }
    }
    if (manifest.catchupPath && fs.existsSync(manifest.catchupPath)) {
        const input = fs.createReadStream(manifest.catchupPath, { encoding: 'utf8' });
        const reader = readline.createInterface({ input, crlfDelay: Infinity });
        for await (const line of reader) {
            if (!line.trim()) continue;
            try {
                yield JSON.parse(line);
            } catch (_) {
                // skip broken line
            }
        }
    }
}

function appendCatchup(manifest, record) {
    fs.appendFileSync(manifest.catchupPath, `${JSON.stringify(record)}\n`, 'utf8');
}

async function fetchAfter(channel, afterId, limit = MESSAGE_BATCH_SIZE) {
    try {
        const options = afterId ? { limit, after: afterId } : { limit };
        const batch = await channel.messages.fetch(options);
        return [...batch.values()]
            .sort((a, b) => compareIds(a.id, b.id))
            .map(safeSerialize);
    } catch (error) {
        console.warn(`[ChannelArchive] 拉取增量消息失败 ${channel.id}:`, error.message);
        return [];
    }
}

async function listThreads(channel) {
    const found = new Map();

    try {
        const active = await channel.threads.fetchActive();
        for (const thread of active.threads.values()) found.set(thread.id, thread);
    } catch (error) {
        console.warn(`[ChannelArchive] 读取活动子区失败 ${channel.id}:`, error.message);
    }

    for (const type of ['public', 'private']) {
        let before = null;
        for (;;) {
            try {
                const result = await channel.threads.fetchArchived({
                    type,
                    limit: MESSAGE_BATCH_SIZE,
                    ...(before ? { before } : {}),
                });
                if (!result || !result.threads.size) break;
                for (const thread of result.threads.values()) found.set(thread.id, thread);
                if (!result.hasMore) break;
                const oldest = [...result.threads.values()].reduce((min, thread) => (
                    !min || compareIds(thread.id, min.id) < 0 ? thread : min
                ), null);
                if (!oldest || oldest.id === before) break;
                before = oldest.id;
            } catch (error) {
                if (type === 'private') {
                    console.warn(`[ChannelArchive] 读取私有子区失败 ${channel.id}:`, error.message);
                } else {
                    console.warn(`[ChannelArchive] 读取归档子区失败 ${channel.id}:`, error.message);
                }
                break;
            }
        }
    }

    return [...found.values()].sort((a, b) => {
        const left = a.createdTimestamp || 0;
        const right = b.createdTimestamp || 0;
        if (left !== right) return left - right;
        return compareIds(a.id, b.id);
    });
}

module.exports = {
    serializeMessage,
    ensureSpool,
    readManifest,
    readRecords,
    appendCatchup,
    fetchAfter,
    listThreads,
};
