const { upsertGuildMemberPresence } = require('../utils/roleSyncDatabase');

async function roleSyncGuildMemberAddHandler(member) {
    if (!member || !member.guild || !member.user) {
        return;
    }

    upsertGuildMemberPresence(member.guild.id, member.user.id, {
        isActive: true,
        joinedAt: member.joinedAt ? member.joinedAt.toISOString() : null,
        leftAt: null,
    });
}

module.exports = {
    roleSyncGuildMemberAddHandler,
};
