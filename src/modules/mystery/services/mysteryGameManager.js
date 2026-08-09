const gamesById = new Map();
const playerLocks = new Map();
const channelLocks = new Map();

// 频道锁分组：同一分组内一个频道只能有一场游戏，不同分组互不干扰。
// 运气轮盘 / 传炸弹 / 死斗 共用默认分组，维持原来的互斥行为；
// 想和它们并行的游戏（如加压轮盘）自己声明一个分组即可。
const DEFAULT_CHANNEL_LOCK_GROUP = 'default';

function buildPlayerKey(guildId, userId) {
    return `${guildId}:${userId}`;
}

function buildChannelKey(channelId, lockGroup = DEFAULT_CHANNEL_LOCK_GROUP) {
    return `${lockGroup}:${channelId}`;
}

function getGame(gameId) {
    return gamesById.get(gameId);
}

function getPlayerGame(guildId, userId) {
    return getGame(playerLocks.get(buildPlayerKey(guildId, userId)));
}

function getChannelGame(channelId, lockGroup = DEFAULT_CHANNEL_LOCK_GROUP) {
    return getGame(channelLocks.get(buildChannelKey(channelId, lockGroup)));
}

function createGame(input) {
    const participantIds = [...new Set([input.initiatorId, ...input.participantIds])];

    if (participantIds.some(userId => playerLocks.has(buildPlayerKey(input.guildId, userId)))) {
        return { ok: false, reason: 'player' };
    }

    const channelKey = buildChannelKey(input.channelId, input.channelLockGroup);
    if (channelLocks.has(channelKey)) {
        return { ok: false, reason: 'channel' };
    }

    const game = {
        ...input,
        participantIds,
        ended: false,
        timers: input.timers || new Set(),
    };
    gamesById.set(game.id, game);
    channelLocks.set(channelKey, game.id);
    participantIds.forEach(userId => {
        playerLocks.set(buildPlayerKey(game.guildId, userId), game.id);
    });

    return { ok: true, game };
}

function addPlayer(game, userId) {
    const playerKey = buildPlayerKey(game.guildId, userId);
    const ownerId = playerLocks.get(playerKey);

    if (game.ended || (ownerId !== undefined && ownerId !== game.id)) {
        return false;
    }

    if (!game.participantIds.includes(userId)) {
        game.participantIds.push(userId);
    }
    playerLocks.set(playerKey, game.id);
    return true;
}

function removePlayer(game, userId) {
    const playerKey = buildPlayerKey(game.guildId, userId);
    const index = game.participantIds.indexOf(userId);

    if (index === -1) {
        return false;
    }

    game.participantIds.splice(index, 1);
    if (playerLocks.get(playerKey) === game.id) {
        playerLocks.delete(playerKey);
    }
    return true;
}

function runExclusive(game, operation) {
    const previous = game.operationQueue || Promise.resolve();
    let releaseGate;
    const gate = new Promise(resolve => {
        releaseGate = resolve;
    });
    game.operationQueue = gate;

    return previous.then(async () => {
        try {
            return await operation();
        } finally {
            releaseGate();
            if (game.operationQueue === gate) {
                delete game.operationQueue;
            }
        }
    });
}

async function cleanupGame(game) {
    let ownsCleanup = false;
    await runExclusive(game, () => {
        if (game.ended) {
            return;
        }

        game.ended = true;
        ownsCleanup = true;
        for (const timer of game.timers) {
            clearTimeout(timer);
        }
        game.timers.clear?.();
    });

    if (!ownsCleanup) return;

    try {
        void Promise.resolve(game.disableComponents?.()).catch(() => {
            // Component cleanup is best effort; lock release must still occur.
        });
    } catch (error) {
        // Synchronous component cleanup failures are also best effort.
    }

    await runExclusive(game, () => {
        game.participantIds.forEach(userId => {
            const playerKey = buildPlayerKey(game.guildId, userId);
            if (playerLocks.get(playerKey) === game.id) {
                playerLocks.delete(playerKey);
            }
        });
        const channelKey = buildChannelKey(game.channelId, game.channelLockGroup);
        if (channelLocks.get(channelKey) === game.id) {
            channelLocks.delete(channelKey);
        }
        if (gamesById.get(game.id) === game) {
            gamesById.delete(game.id);
        }
    });
}

function getMemberIds(member) {
    return {
        guildId: member.guildId || member.guild?.id,
        userId: member.id || member.user?.id,
    };
}

function logInvalidationFailure(game, userId, action, error) {
    console.error(
        `[MysteryGameManager] ${action} (guild=${game?.guildId || 'unknown'}, user=${userId || 'unknown'}, game=${game?.id || 'unknown'}, type=${game?.type || 'unknown'}):`,
        error
    );
}

async function dispatchMemberInvalidation(member, ...args) {
    const { guildId, userId } = getMemberIds(member);
    if (!guildId || !userId) {
        return;
    }

    const game = getPlayerGame(guildId, userId);
    if (!game) {
        return;
    }

    game.invalidatedMemberIds ||= new Set();
    if (game.invalidatedMemberIds.has(userId)) {
        return;
    }
    game.invalidatedMemberIds.add(userId);

    try {
        await game.onMemberInvalidated?.(member, ...args);
    } catch (error) {
        logInvalidationFailure(game, userId, 'member invalidation callback failed', error);
        try {
            await cleanupGame(game);
        } catch (cleanupError) {
            logInvalidationFailure(game, userId, 'fallback cleanup failed', cleanupError);
        }
    }
}

function handleGuildMemberRemove(member) {
    return dispatchMemberInvalidation(member);
}

function handleGuildMemberUpdate(oldMember, newMember) {
    return dispatchMemberInvalidation(newMember, oldMember);
}

function resetForTests() {
    gamesById.clear();
    playerLocks.clear();
    channelLocks.clear();
}

module.exports = {
    DEFAULT_CHANNEL_LOCK_GROUP,
    buildChannelKey,
    createGame,
    getGame,
    getPlayerGame,
    getChannelGame,
    addPlayer,
    removePlayer,
    runExclusive,
    cleanupGame,
    handleGuildMemberRemove,
    handleGuildMemberUpdate,
    resetForTests,
};
