const gameManager = require('../services/mysteryGameManager');
const cowardPenalty = require('../services/cowardPenalty');

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

function isFiniteTimestamp(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

async function mysteryGuildMemberUpdateHandler(oldMember, newMember) {
    const oldIds = getMemberIds(oldMember);
    const newIds = getMemberIds(newMember);
    if (
        !oldIds
        || !newIds
        || oldIds.guildId !== newIds.guildId
        || oldIds.userId !== newIds.userId
    ) {
        return;
    }

    // 1) 昵称锁生命周期：改名重新强制 / 到期释放 / 胆小鬼嘲讽。
    try {
        await cowardPenalty.handleGuildMemberUpdate(oldMember, newMember);
    } catch (error) {
        console.error(
            `[Mystery] nickname lock member-update failed guildId=${newIds.guildId} userId=${newIds.userId}:`,
            error
        );
    }

    // 2) 游戏失效：只对新施加的 external Timeout 生效。
    const now = Date.now();
    const oldTimeout = oldMember.communicationDisabledUntilTimestamp;
    const newTimeout = newMember.communicationDisabledUntilTimestamp;
    const oldIsActive = isFiniteTimestamp(oldTimeout) && oldTimeout > now;
    const newIsActive = isFiniteTimestamp(newTimeout) && newTimeout > now;
    if (oldIsActive || !newIsActive) {
        return;
    }

    try {
        await gameManager.handleGuildMemberUpdate(oldMember, newMember);
    } catch (_) {
        console.error(
            `[Mystery] member invalidation failed guildId=${newIds.guildId} userId=${newIds.userId} reason=timeout`
        );
    }
}

module.exports = { mysteryGuildMemberUpdateHandler };
