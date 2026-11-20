// src/modules/channelArchive/utils/constants.js
const path = require('node:path');

const CUSTOM_ID_PREFIX = 'charc:';

const VOTE_ACTION = Object.freeze({
    JOIN: 'join',
    AGREE: 'agree',
    WITHDRAW: 'withdraw',
    OPPOSE: 'oppose',
    CONFIRM: 'confirm',
});

const VOTE_TYPE = Object.freeze({
    ARCHIVE: 'ARCHIVE',
    DELETE: 'DELETE',
});

const VOTE_STATUS = Object.freeze({
    ACTIVE: 'ACTIVE',
    PASSED: 'PASSED',
    VETOED: 'VETOED',
    EXPIRED: 'EXPIRED',
});

const ARCHIVE_STATUS = Object.freeze({
    PENDING_VOTE: 'PENDING_VOTE',
    ARCHIVING: 'ARCHIVING',
    ARCHIVED: 'ARCHIVED',
    DELETED: 'DELETED',
});

const SUBTHREAD_STATUS = Object.freeze({
    PENDING: 'PENDING',
    ARCHIVING: 'ARCHIVING',
    ARCHIVED: 'ARCHIVED',
    FAILED: 'FAILED',
});

const AUDIT_ACTION = Object.freeze({
    ARCHIVE_START: 'ARCHIVE_START',
    ARCHIVE_DONE: 'ARCHIVE_DONE',
    VOTE_VETO: 'VOTE_VETO',
    CHANNEL_DELETE: 'CHANNEL_DELETE',
});

function envThreshold(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

// 默认 3/5；测试环境可通过环境变量临时降低，正式环境删除变量即恢复默认。
const VOTE_THRESHOLD = Object.freeze({
    [VOTE_TYPE.ARCHIVE]: envThreshold('CHANNEL_ARCHIVE_VOTE_THRESHOLD', 3),
    [VOTE_TYPE.DELETE]: envThreshold('CHANNEL_ARCHIVE_DELETE_THRESHOLD', 5),
});

const VOTE_DURATION_MS = 24 * 60 * 60 * 1000;
const VOTE_ACTION_LABEL = Object.freeze({
    [VOTE_TYPE.ARCHIVE]: '频道归档',
    [VOTE_TYPE.DELETE]: '删除归档频道',
});

const WEBHOOK_NAME = 'ChannelArchive';
const WEBHOOK_SENDER_NAME = '频道归档';
const PROGRESS_MARKER = '[频道归档]';

const MESSAGE_BATCH_SIZE = 100;
const WEBHOOK_SEND_INTERVAL_MS = 1200;
const IDLE_CONFIRM_MS = 5000;
const PROGRESS_INTERVAL_MS = 30000;
const MAX_CONTENT_LENGTH = 2000;

// Discord 服务器上传上限：无 Boost / Lv1 / Lv2 / Lv3
const UPLOAD_LIMIT_BY_TIER = Object.freeze({
    0: 10 * 1024 * 1024,
    1: 25 * 1024 * 1024,
    2: 50 * 1024 * 1024,
    3: 100 * 1024 * 1024,
});

const DATA_DIR = path.join(__dirname, '../../../../data');
const TEMP_ROOT = path.join(DATA_DIR, 'channelArchive-temp');
const ARCHIVE_LINK_TITLE = '🧵 子区备份帖';

function voteCustomId(action, voteId) {
    return `${CUSTOM_ID_PREFIX}vote:${action}:${voteId}`;
}

function parseVoteCustomId(customId) {
    if (typeof customId !== 'string' || !customId.startsWith(`${CUSTOM_ID_PREFIX}vote:`)) return null;
    const parts = customId.split(':');
    // charc : vote : action : voteId
    if (parts.length !== 4) return null;
    const [, , action, voteId] = parts;
    if (!Object.values(VOTE_ACTION).includes(action) || !voteId) return null;
    return { action, voteId };
}

function getUploadLimit(guild) {
    const tier = Number(guild?.premiumTier) || 0;
    return UPLOAD_LIMIT_BY_TIER[tier] || UPLOAD_LIMIT_BY_TIER[0];
}

function isArchiveCustomId(customId) {
    return typeof customId === 'string' && customId.startsWith(CUSTOM_ID_PREFIX);
}

module.exports = {
    CUSTOM_ID_PREFIX,
    VOTE_ACTION,
    VOTE_TYPE,
    VOTE_STATUS,
    ARCHIVE_STATUS,
    SUBTHREAD_STATUS,
    AUDIT_ACTION,
    VOTE_THRESHOLD,
    VOTE_DURATION_MS,
    VOTE_ACTION_LABEL,
    WEBHOOK_NAME,
    WEBHOOK_SENDER_NAME,
    PROGRESS_MARKER,
    MESSAGE_BATCH_SIZE,
    WEBHOOK_SEND_INTERVAL_MS,
    IDLE_CONFIRM_MS,
    PROGRESS_INTERVAL_MS,
    MAX_CONTENT_LENGTH,
    UPLOAD_LIMIT_BY_TIER,
    DATA_DIR,
    TEMP_ROOT,
    ARCHIVE_LINK_TITLE,
    voteCustomId,
    parseVoteCustomId,
    getUploadLimit,
    isArchiveCustomId,
};
