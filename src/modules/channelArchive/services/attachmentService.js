// src/modules/channelArchive/services/attachmentService.js
const { AttachmentBuilder } = require('discord.js');
const { sanitizeFileName, sleep } = require('../utils/text');

const DOWNLOAD_TIMEOUT_MS = 60000;

async function downloadBuffer(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 下载附件并按单次上传上限分组；超过上限时拆成多条 Webhook 消息。
 */
function isPermanentDownloadError(error) {
    const match = /HTTP (\d{3})/.exec(String(error?.message || ''));
    if (!match) return false;
    const status = Number(match[1]);
    return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

async function buildAttachmentFiles(record, limitBytes, { retry = 1 } = {}) {
    const attachments = record.attachments || [];
    const batches = [];
    const problems = [];
    const failures = [];
    let current = [];
    let usedBytes = 0;
    const safeLimit = Math.max(0, Math.floor(limitBytes * 0.95));

    const flush = () => {
        if (current.length) {
            batches.push(current);
            current = [];
            usedBytes = 0;
        }
    };

    for (let index = 0; index < attachments.length; index += 1) {
        const attachment = attachments[index];
        if (!attachment?.url) {
            problems.push(`[附件未转存: ${attachment?.name || '未知文件'}]`);
            continue;
        }

        let buffer = null;
        let lastError = null;
        for (let attempt = 0; attempt <= retry; attempt += 1) {
            try {
                buffer = await downloadBuffer(attachment.url);
                break;
            } catch (error) {
                lastError = error;
                if (attempt < retry) await sleep(1000);
            }
        }
        if (!buffer) {
            const message = lastError?.message || '下载失败';
            if (isPermanentDownloadError(lastError)) {
                problems.push(`[附件已失效: ${attachment.name}（${message}）]`);
            } else {
                failures.push({ name: attachment.name, error: message });
            }
            continue;
        }
        if (buffer.length > safeLimit) {
            problems.push(`[附件未转存: ${attachment.name}（单个文件超出上传上限）]`);
            continue;
        }
        if (usedBytes + buffer.length > safeLimit) flush();

        const name = sanitizeFileName(`${index + 1}_${attachment.name}`, `file-${index + 1}`);
        current.push(new AttachmentBuilder(buffer, { name }));
        usedBytes += buffer.length;
    }
    flush();

    return { batches, problems, failures };
}

function buildProblemText(problems) {
    if (!problems?.length) return '';
    return problems.join('\n');
}

module.exports = {
    buildAttachmentFiles,
    buildProblemText,
    downloadBuffer,
};
