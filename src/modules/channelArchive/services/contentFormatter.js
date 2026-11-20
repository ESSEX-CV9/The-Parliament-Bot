// src/modules/channelArchive/services/contentFormatter.js
const {
    appendMetadataToParts,
    formatBytes,
    formatChinaTime,
    splitContent,
    truncate,
} = require('../utils/text');

const VOICE_MESSAGE_FLAG = 1 << 13;
const NORMAL_TYPES = new Set([0, 19]);

function replaceMentions(content, record) {
    let text = String(content ?? '');
    const userMap = new Map((record.mentions?.users || []).map(user => [user.id, user.name]));
    const roleMap = new Map((record.mentions?.roles || []).map(role => [role.id, role.name]));
    const channelMap = new Map((record.mentions?.channels || []).map(channel => [channel.id, channel.name]));

    text = text.replace(/<@!?(\d+)>/g, (_, id) => `@${userMap.get(id) || id}`);
    text = text.replace(/<@&(\d+)>/g, (_, id) => `@${roleMap.get(id) || id}`);
    text = text.replace(/<#(\d+)>/g, (_, id) => `#${channelMap.get(id) || id}`);
    return text;
}

function emojiLabel(emoji) {
    if (!emoji) return '❔';
    if (emoji.id) return `<:${emoji.name || 'emoji'}:${emoji.id}>`;
    return emoji.name || '❔';
}

function buildMetadataLine(record) {
    // 使用 Discord 原生时间戳：按查看者本地时区显示，点击可看完整时间。
    const unix = Math.floor(record.createdTimestamp / 1000);
    const parts = [`🕒 <t:${unix}:f>`];
    if (record.editedTimestamp) parts.push('已编辑');
    if (record.reactions?.length) {
        const reactionText = record.reactions
            .map(reaction => `${emojiLabel(reaction.emoji)} ${reaction.count}`)
            .join('  ');
        parts.push(reactionText);
    }
    return `-# ${parts.join(' | ')}`;
}

function formatPoll(poll) {
    if (!poll) return '';
    const lines = [`📊 **投票：${poll.question || '未命名投票'}**`];
    (poll.answers || []).forEach((answer, index) => {
        const votes = answer.voteCount == null ? '' : ` — ${answer.voteCount} 票`;
        lines.push(`${index + 1}. ${answer.text}${votes}`);
    });
    if (poll.allowMultiselect) lines.push('（多选）');
    return lines.join('\n');
}

function renderEmbed(embed) {
    const lines = [];
    if (embed.title) lines.push(`> **${embed.title}**`);
    if (embed.description) {
        for (const line of String(embed.description).split('\n')) lines.push(`> ${line}`);
    }
    for (const field of embed.fields || []) {
        lines.push(`> **${field.name || '字段'}：** ${field.value || ''}`);
    }
    if (embed.footer?.text) lines.push(`> — ${embed.footer.text}`);
    return lines.join('\n');
}

function renderEmbeds(embeds) {
    return (embeds || []).map(renderEmbed).filter(Boolean).join('\n\n');
}

function replySnippet(target) {
    if (!target) return '';
    return truncate(String(target.content || '').replace(/\s+/g, ' ').trim(), 120);
}

function buildReplyQuote(record, { resolveReference, resolveChannel } = {}) {
    if (!record.reference) return '';
    const name = record.reference.repliedUser?.name || '未知用户';
    const reference = record.reference;
    const target = reference.messageId && resolveReference
        ? resolveReference(reference.messageId)
        : null;
    const snippet = replySnippet(target) || '（无文字内容）';

    if (record.channelId && reference.channelId && reference.channelId !== record.channelId) {
        // 跨频道回复：优先指向对应的备份帖，原频道删除后链接依然有效。
        const mapped = resolveChannel ? resolveChannel(reference.channelId) : null;
        if (mapped) {
            return target
                ? `> ↩️ **${name}**（见 [${mapped.label}](${mapped.url})）：${snippet}`
                : `> ↩️ **${name}**（见 [${mapped.label}](${mapped.url})）`;
        }
        return target
            ? `> ↩️ **${name}**（来自 <#${reference.channelId}>）：${snippet}`
            : `> ↩️ **${name}**（来自 <#${reference.channelId}>）`;
    }

    if (!target) {
        return `> ↩️ 回复 **${name}**（原消息未收录或已删除）`;
    }

    const author = target.author || name;
    return `> ↩️ **${author}**：${snippet}`;
}

function buildStickerText(record) {
    if (!record.stickers?.length) return '';
    return record.stickers.map(sticker => `[贴纸: ${sticker.name || '未命名'}]`).join(' ');
}

function buildAttachmentText(record) {
    if (!record.attachments?.length) return '';
    return record.attachments
        .map(attachment => `📎 ${attachment.name}（${formatBytes(attachment.size)}）`)
        .join('\n');
}

function buildVoiceText(record) {
    return (record.flags & VOICE_MESSAGE_FLAG) ? '[语音消息]' : '';
}

function buildSystemText(record) {
    if (NORMAL_TYPES.has(record.type)) return '';
    if (record.type === 18) {
        return `-# 子区已创建${record.content ? `：${record.content}` : ''}`;
    }
    if (record.content) return `-# 系统消息：${record.content}`;
    return `-# 系统消息（类型 ${record.type}）`;
}

function composeBody(record, { includeEmbedsInText = false, includeReply = true, resolveReference, resolveChannel } = {}) {
    const blocks = [];
    const reply = includeReply ? buildReplyQuote(record, { resolveReference, resolveChannel }) : '';
    if (reply) blocks.push(reply);

    const system = buildSystemText(record);
    if (system) blocks.push(system);

    const content = replaceMentions(record.content, record);
    if (content) blocks.push(content);

    const voice = buildVoiceText(record);
    if (voice) blocks.push(voice);

    const stickers = buildStickerText(record);
    if (stickers) blocks.push(stickers);

    if (record.poll) blocks.push(formatPoll(record.poll));

    if (includeEmbedsInText) {
        const embeds = renderEmbeds(record.embeds);
        if (embeds) blocks.push(embeds);
    }

    const attachments = buildAttachmentText(record);
    if (attachments) blocks.push(attachments);

    return blocks.join('\n').trim();
}

function composeWebhookParts(record, { resolveReference, resolveChannel } = {}) {
    const body = composeBody(record, { includeEmbedsInText: false, resolveReference, resolveChannel });
    const parts = body ? splitContent(body) : [];
    return appendMetadataToParts(parts, buildMetadataLine(record));
}

function buildBackupRecord(record) {
    return {
        id: record.id,
        time: formatChinaTime(record.createdTimestamp),
        timestamp: record.createdTimestamp,
        edited: Boolean(record.editedTimestamp),
        author: record.author?.displayName || '未知用户',
        authorId: record.author?.id || null,
        content: composeBody(record, { includeEmbedsInText: true, includeReply: false }),
        attachments: (record.attachments || []).map(attachment => ({
            name: attachment.name,
            size: attachment.size,
            contentType: attachment.contentType || null,
        })),
        reactions: (record.reactions || []).map(reaction => ({
            emoji: reaction.emoji?.name || reaction.emoji?.id || null,
            count: reaction.count,
        })),
        replyTo: record.reference?.messageId || null,
    };
}

function sanitizeEmbeds(record) {
    if (!record.embeds?.length) return [];
    return record.embeds.slice(0, 10).map(embed => {
        const next = { ...embed };
        delete next.timestamp;
        if (Array.isArray(next.fields)) next.fields = next.fields.slice(0, 25);
        return next;
    });
}

module.exports = {
    replaceMentions,
    buildMetadataLine,
    composeWebhookParts,
    buildBackupRecord,
    sanitizeEmbeds,
    renderEmbeds,
};
