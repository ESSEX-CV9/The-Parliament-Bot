const { upsertGuildMemberPresence } = require('../utils/roleSyncDatabase');

async function roleSyncGuildMemberRemoveHandler(member) {
    if (!member || !member.guild || !member.user) {
        return;
    }

    upsertGuildMemberPresence(member.guild.id, member.user.id, {
        isActive: false,
        joinedAt: member.joinedAt ? member.joinedAt.toISOString() : null,
        leftAt: new Date().toISOString(),
    });
}

module.exports = {
    roleSyncGuildMemberRemoveHandler,
};
