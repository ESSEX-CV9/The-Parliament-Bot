const gameManager = require('../services/mysteryGameManager');
const nicknameLock = require('../services/mysteryNicknameLock');

function getMemberIds(member) {
    const guildId = member?.guild?.id;
    const memberId = member?.id;
    const userId = member?.user?.id;

    if (
        typeof guildId !== 'string'
        || guildId.trim().length === 0
        || guildId !== guildId.trim()
        || typeof memberId !== 'string'
        || memberId.trim().length === 0
        || memberId !== memberId.trim()
        || typeof userId !== 'string'
        || userId.trim().length === 0
        || userId !== userId.trim()
        || memberId !== userId
    ) {
        return null;
    }

    return { guildId, userId };
}

async function mysteryGuildMemberRemoveHandler(member) {
    const ids = getMemberIds(member);
    if (!ids) {
        return;
    }

    // 成员离开：同时清理昵称锁（不可恢复）与游戏失效。
    try {
        await nicknameLock.service.handleGuildMemberRemove(member);
    } catch (error) {
        console.error(
            `[Mystery] nickname lock member-remove failed guildId=${ids.guildId} userId=${ids.userId}:`,
            error
        );
    }

    try {
        await gameManager.handleGuildMemberRemove(member);
    } catch (_) {
        console.error(
            `[Mystery] member invalidation failed guildId=${ids.guildId} userId=${ids.userId} reason=member-remove`
        );
    }
}

module.exports = { mysteryGuildMemberRemoveHandler };
