// src/modules/channelArchive/utils/text.js
const { MAX_CONTENT_LENGTH } = require('./constants');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatChinaTime(timestamp) {
    if (!timestamp) return '';
    const shifted = new Date(Number(timestamp) + 8 * 60 * 60 * 1000);
    return shifted.toISOString().slice(0, 16).replace('T', ' ');
}

function formatChinaDateTime(timestamp) {
    if (!timestamp) return '未知';
    const shifted = new Date(Number(timestamp) + 8 * 60 * 60 * 1000);
    return `${shifted.toISOString().slice(0, 19).replace('T', ' ')} (UTC+8)`;
}

function safeSlice(text, max) {
    if (text.length <= max) return text;
    let end = max;
    const code = text.charCodeAt(end - 1);
    if (code >= 0xD800 && code <= 0xDBFF) end -= 1;
    return text.slice(0, end);
}

function splitContent(content, max = MAX_CONTENT_LENGTH) {
    const text = String(content ?? '');
    if (!text) return [];
    if (text.length <= max) return [text];

    const parts = [];
    let current = '';
    const lines = text.split('\n');

    for (const line of lines) {
        const candidate = current ? `${current}\n${line}` : line;
        if (candidate.length <= max) {
            current = candidate;
            continue;
        }
        if (current) {
            parts.push(current);
            current = '';
        }
        if (line.length <= max) {
            current = line;
            continue;
        }
        let rest = line;
        while (rest.length > max) {
            const chunk = safeSlice(rest, max);
            parts.push(chunk);
            rest = rest.slice(chunk.length);
        }
        current = rest;
    }
    if (current) parts.push(current);
    return parts.length ? parts : [text];
}

function appendMetadataToParts(parts, metadata) {
    if (!metadata) return parts.length ? parts : [''];
    if (!parts.length) {
        return metadata.length <= MAX_CONTENT_LENGTH ? [metadata] : splitContent(metadata);
    }
    const last = parts[parts.length - 1];
    const withMeta = last ? `${last}\n${metadata}` : metadata;
    if (withMeta.length <= MAX_CONTENT_LENGTH) {
        parts[parts.length - 1] = withMeta;
        return parts;
    }
    if (metadata.length <= MAX_CONTENT_LENGTH) {
        parts.push(metadata);
    } else {
        parts.push(...splitContent(metadata));
    }
    return parts;
}

function truncate(text, max = 80) {
    const value = String(text ?? '');
    if (value.length <= max) return value;
    return `${safeSlice(value, Math.max(0, max - 1))}…`;
}

function sanitizeUsername(name) {
    let value = String(name ?? '').trim();
    value = value.replace(/```/g, "'''");
    value = value.replace(/discord/gi, 'd_iscord');
    value = value.replace(/clyde/gi, 'd_clyde');
    value = value.replace(/[\u0000-\u001F\u007F]/g, '');
    value = value.trim().slice(0, 80);
    return value || '未知用户';
}

function sanitizeThreadName(name) {
    let value = String(name ?? '').trim();
    value = value.replace(/[\u0000-\u001F\u007F]/g, '');
    value = value.slice(0, 100).trim();
    return value || '未命名频道';
}

function sanitizeFileName(name, fallback = 'file') {
    let value = String(name ?? '').trim();
    value = value.replace(/[\\/:*?"<>|\u0000-\u001F\u007F]/g, '_');
    value = value.slice(0, 100).trim();
    return value || fallback;
}

function toBigInt(value) {
    try {
        return BigInt(String(value));
    } catch (_) {
        return null;
    }
}

function compareIds(a, b) {
    if (a === b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    const left = toBigInt(a);
    const right = toBigInt(b);
    if (left !== null && right !== null) return left < right ? -1 : 1;
    return String(a) < String(b) ? -1 : 1;
}

function idGreater(a, b) {
    return compareIds(a, b) > 0;
}

function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${value} B`;
}

module.exports = {
    sleep,
    formatChinaTime,
    formatChinaDateTime,
    splitContent,
    appendMetadataToParts,
    truncate,
    sanitizeUsername,
    sanitizeThreadName,
    sanitizeFileName,
    compareIds,
    idGreater,
    formatBytes,
};
