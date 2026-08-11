const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '../../../../data', 'mystery');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const BLOCKLIST_FILE = path.join(DATA_DIR, 'channelBlocklist.json');

/**
 * channelBlocklist.json 结构：
 * {
 *   "guildId": {
 *     "channelId": { "blockedBy": "userId", "blockedAt": 1234567890 }
 *   }
 * }
 *
 * 支持的频道类型：子区 (thread)、论坛帖子 (forum post)、普通频道。
 * 子区主 (thread owner) 可以在自己的子区内禁用/启用神秘指令。
 * 管理员可以在任何频道禁用/启用。
 */

let cache = null;

function loadBlocklist() {
    if (cache !== null) return cache;
    try {
        if (fs.existsSync(BLOCKLIST_FILE)) {
            cache = JSON.parse(fs.readFileSync(BLOCKLIST_FILE, 'utf-8'));
        } else {
            cache = {};
        }
    } catch (error) {
        console.error('[MysteryBlocklist] 读取频道黑名单失败:', error);
        cache = {};
    }
    return cache;
}

function saveBlocklist() {
    try {
        fs.writeFileSync(BLOCKLIST_FILE, JSON.stringify(cache, null, 2), 'utf-8');
    } catch (error) {
        console.error('[MysteryBlocklist] 写入频道黑名单失败:', error);
    }
}

/**
 * 检查指定频道是否被禁用了神秘指令。
 * @param {string} guildId
 * @param {string} channelId
 * @returns {boolean}
 */
function isChannelBlocked(guildId, channelId) {
    const data = loadBlocklist();
    return !!(data[guildId] && data[guildId][channelId]);
}

/**
 * 在指定频道禁用神秘指令。
 * @param {string} guildId
 * @param {string} channelId
 * @param {string} userId 操作者 ID
 * @returns {boolean} true=新增禁用, false=已经禁用
 */
function blockChannel(guildId, channelId, userId) {
    const data = loadBlocklist();
    if (!data[guildId]) data[guildId] = {};
    if (data[guildId][channelId]) return false;
    data[guildId][channelId] = {
        blockedBy: userId,
        blockedAt: Date.now(),
    };
    saveBlocklist();
    return true;
}

/**
 * 在指定频道启用神秘指令（移除禁用）。
 * @param {string} guildId
 * @param {string} channelId
 * @returns {boolean} true=已移除禁用, false=本来就没禁用
 */
function unblockChannel(guildId, channelId) {
    const data = loadBlocklist();
    if (!data[guildId] || !data[guildId][channelId]) return false;
    delete data[guildId][channelId];
    if (Object.keys(data[guildId]).length === 0) {
        delete data[guildId];
    }
    saveBlocklist();
    return true;
}

module.exports = {
    isChannelBlocked,
    blockChannel,
    unblockChannel,
};
