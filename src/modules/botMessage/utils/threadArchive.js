// src/modules/botMessage/utils/threadArchive.js
const { PermissionFlagsBits } = require('discord.js');

/**
 * 该频道是否是「已归档的子区/论坛帖」
 */
function isArchivedThread(channel) {
    return Boolean(channel?.isThread?.() && channel.archived);
}

/**
 * 机器人是否有能力解除该子区的归档
 *
 * Discord 规则：已归档且被锁定的子区必须有「管理子区」权限才能解除归档；
 * 仅归档未锁定的，能在子区发言即可解除。
 */
function canUnarchive(channel) {
    if (!channel?.isThread?.()) return false;
    if (channel.manageable) return true;
    if (channel.locked) return false;

    const perms = channel.permissionsFor(channel.client.user);
    return Boolean(perms?.has(PermissionFlagsBits.SendMessagesInThreads));
}

/**
 * 描述无法解除归档的原因（可直接展示给用户）
 */
function describeUnarchiveBlock(channel) {
    if (channel?.locked) {
        return '该子区已归档并被锁定，机器人需要「管理子区」权限才能临时解除归档。';
    }
    return '机器人缺少解除该子区归档所需的权限（「管理子区」或「在子区发言」）。';
}

/**
 * 如果频道是已归档的子区，临时解除归档
 *
 * @param {import('discord.js').Channel} channel
 * @param {string} reason 审计日志原因
 * @returns {Promise<{wasArchived: boolean, ok: boolean, error?: string, channel?: object}>}
 *          wasArchived=true 且 ok=true 时，调用方有责任在操作结束后调用 restoreArchiveState 还原
 */
async function unarchiveIfNeeded(channel, reason) {
    if (!isArchivedThread(channel)) {
        return { wasArchived: false, ok: true };
    }

    if (!canUnarchive(channel)) {
        return { wasArchived: true, ok: false, error: describeUnarchiveBlock(channel), channel };
    }

    try {
        await channel.setArchived(false, reason);
        console.log(`[BotMessage] 已临时解除子区归档：${channel.id}（${channel.name || '未知'}）`);
        return { wasArchived: true, ok: true, channel };
    } catch (err) {
        console.error(`[BotMessage] 解除子区归档失败 channel=${channel.id}:`, err.message);
        return { wasArchived: true, ok: false, error: `解除子区归档失败：${err.message}`, channel };
    }
}

/**
 * 把先前临时解除归档的子区重新归档
 *
 * 只在确实由我们解除过归档时才还原；失败只记日志，不影响主流程结果。
 * @returns {Promise<boolean>} 是否成功还原
 */
async function restoreArchiveState(state, reason) {
    if (!state?.wasArchived || !state.ok || !state.channel) return false;

    try {
        await state.channel.setArchived(true, reason);
        console.log(`[BotMessage] 已恢复子区归档状态：${state.channel.id}`);
        return true;
    } catch (err) {
        console.error(`[BotMessage] 恢复子区归档失败 channel=${state.channel.id}:`, err.message);
        return false;
    }
}

module.exports = {
    isArchivedThread,
    canUnarchive,
    describeUnarchiveBlock,
    unarchiveIfNeeded,
    restoreArchiveState,
};
