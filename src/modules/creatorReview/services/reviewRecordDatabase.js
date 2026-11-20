// src/modules/creatorReview/services/reviewRecordDatabase.js
//
// 创作者审核通过记录。每次成功发放奖励身份组时写一条，
// 用于事后追溯"谁、凭哪个帖子、在多少反应数下拿到的身份组"。
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '../../../../data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const CREATOR_REVIEW_DB_FILE = path.join(DATA_DIR, 'creatorReview.sqlite');
const db = new Database(CREATOR_REVIEW_DB_FILE);

let initialized = false;
const stmts = {};

function initializeCreatorReviewDatabase() {
    if (initialized) return;

    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');

    // guild_id 是发放身份组的服务器；source_guild_id 是帖子所在的服务器（允许跨服审核时两者不同）
    db.exec(`
        CREATE TABLE IF NOT EXISTS creator_review_approvals (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id            TEXT NOT NULL,
            user_id             TEXT NOT NULL,
            user_tag            TEXT,
            role_id             TEXT NOT NULL,
            source_guild_id     TEXT NOT NULL,
            forum_channel_id    TEXT NOT NULL,
            thread_id           TEXT NOT NULL,
            thread_name         TEXT,
            post_link           TEXT NOT NULL,
            unique_reactions    INTEGER NOT NULL,
            required_reactions  INTEGER NOT NULL,
            thread_created_at   TEXT,
            approved_at         TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_cra_guild_user ON creator_review_approvals(guild_id, user_id);
        CREATE INDEX IF NOT EXISTS idx_cra_thread ON creator_review_approvals(source_guild_id, thread_id);
    `);

    stmts.insertApproval = db.prepare(`
        INSERT INTO creator_review_approvals
            (guild_id, user_id, user_tag, role_id, source_guild_id, forum_channel_id, thread_id, thread_name,
             post_link, unique_reactions, required_reactions, thread_created_at, approved_at)
        VALUES
            (@guildId, @userId, @userTag, @roleId, @sourceGuildId, @forumChannelId, @threadId, @threadName,
             @postLink, @uniqueReactions, @requiredReactions, @threadCreatedAt, @approvedAt)
    `);

    initialized = true;
}

/**
 * 写入一条审核通过记录。
 * @param {object} record
 * @param {string} record.guildId 发放身份组的服务器ID
 * @param {string} record.userId 获得身份组的用户ID
 * @param {string} [record.userTag] 用户当时的 tag，仅供人工查看
 * @param {string} record.roleId 发放的身份组ID
 * @param {string} record.sourceGuildId 帖子所在服务器ID
 * @param {string} record.forumChannelId 帖子所在论坛频道ID
 * @param {string} record.threadId 帖子ID
 * @param {string} [record.threadName] 帖子标题
 * @param {string} record.postLink 用户提交的原始链接
 * @param {number} record.uniqueReactions 审核时的不重复反应用户数
 * @param {number} record.requiredReactions 审核时的门槛
 * @param {number} [record.threadCreatedTimestamp] 帖子创建时间（毫秒时间戳）
 * @returns {number} 新记录的ID
 */
function recordApproval(record) {
    if (!initialized) initializeCreatorReviewDatabase();

    const info = stmts.insertApproval.run({
        guildId: record.guildId,
        userId: record.userId,
        userTag: record.userTag ?? null,
        roleId: record.roleId,
        sourceGuildId: record.sourceGuildId,
        forumChannelId: record.forumChannelId,
        threadId: record.threadId,
        threadName: record.threadName ?? null,
        postLink: record.postLink,
        uniqueReactions: record.uniqueReactions,
        requiredReactions: record.requiredReactions,
        threadCreatedAt: record.threadCreatedTimestamp
            ? new Date(record.threadCreatedTimestamp).toISOString()
            : null,
        approvedAt: new Date().toISOString(),
    });

    return Number(info.lastInsertRowid);
}

module.exports = {
    initializeCreatorReviewDatabase,
    recordApproval,
};
