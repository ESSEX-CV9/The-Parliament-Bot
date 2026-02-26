const {
    getGuildMemberPresence,
    upsertGuildMemberPresence,
} = require('../utils/roleSyncDatabase');
const { withRetry } = require('../utils/networkRetry');

/**
 * 校验用户是否在目标服务器（交集成员规则）。
 * 策略：优先查本地状态，再通过 API 实时确认。
 */
async function ensureMemberExistsInGuild(client, guildId, userId) {
    const local = getGuildMemberPresence(guildId, userId);

    // 如果本地明确标记为离开，也做一次轻量校验，避免脏数据长期存在。
    if (local && local.is_active === 0) {
        const guild = await withRetry(
            () => client.guilds.fetch(guildId),
            { retries: 2, baseDelayMs: 300, label: `eligibility_guild_${guildId}` }
        ).catch(() => null);
        if (!guild) {
            return false;
        }

        const member = await withRetry(
            () => guild.members.fetch(userId),
            { retries: 2, baseDelayMs: 280, label: `eligibility_member_${userId}` }
        ).catch(() => null);
        if (!member) {
            return false;
        }

        upsertGuildMemberPresence(guildId, userId, {
            isActive: true,
            joinedAt: member.joinedAt ? member.joinedAt.toISOString() : null,
            leftAt: null,
        });

        return true;
    }

    const guild = await withRetry(
        () => client.guilds.fetch(guildId),
        { retries: 2, baseDelayMs: 300, label: `eligibility_guild_${guildId}` }
    ).catch(() => null);
    if (!guild) {
        return false;
    }

    const member = await withRetry(
        () => guild.members.fetch(userId),
        { retries: 2, baseDelayMs: 280, label: `eligibility_member_${userId}` }
    ).catch(() => null);
    if (!member) {
        upsertGuildMemberPresence(guildId, userId, {
            isActive: false,
            joinedAt: local?.joined_at || null,
            leftAt: new Date().toISOString(),
        });
        return false;
    }

    upsertGuildMemberPresence(guildId, userId, {
        isActive: true,
        joinedAt: local?.joined_at || (member.joinedAt ? member.joinedAt.toISOString() : null),
        leftAt: null,
    });

    return true;
}

module.exports = {
    ensureMemberExistsInGuild,
};
