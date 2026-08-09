const gameManager = require('../services/mysteryGameManager');

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

    try {
        await gameManager.handleGuildMemberRemove(member);
    } catch (_) {
        console.error(
            `[Mystery] member invalidation failed guildId=${ids.guildId} userId=${ids.userId} reason=member-remove`
        );
    }
}

module.exports = { mysteryGuildMemberRemoveHandler };
