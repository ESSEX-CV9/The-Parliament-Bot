const guildOperationTails = new Map();

async function withGuildOperationLock(guildId, operation) {
    const previous = guildOperationTails.get(guildId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate, () => gate);
    guildOperationTails.set(guildId, tail);

    await previous.catch(() => {});
    try {
        return await operation();
    } finally {
        release();
        if (guildOperationTails.get(guildId) === tail) {
            guildOperationTails.delete(guildId);
        }
    }
}

module.exports = { withGuildOperationLock };
