const gamesById = new Map();
const playerLocks = new Map();
const channelLocks = new Map();

// 频道锁：运气轮盘 / 传炸弹 / 死斗 / 加压轮盘 共用同一把锁，
// 同一个频道里同时只能有其中一场游戏。
function buildPlayerKey(guildId, userId) {
    return `${guildId}:${userId}`;
}

function buildChannelKey(channelId) {
    return channelId;
}

function getGame(gameId) {
    return gamesById.get(gameId);
}

function getPlayerGame(guildId, userId) {
    return getGame(playerLocks.get(buildPlayerKey(guildId, userId)));
}

function getChannelGame(channelId) {
    return getGame(channelLocks.get(buildChannelKey(channelId)));
}

function createGame(input) {
    const participantIds = [...new Set([input.initiatorId, ...input.participantIds])];

    if (participantIds.some(userId => playerLocks.has(buildPlayerKey(input.guildId, userId)))) {
        return { ok: false, reason: 'player' };
    }

    const channelKey = buildChannelKey(input.channelId);
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
        const channelKey = buildChannelKey(game.channelId);
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

/** 当前还活着的所有对局。进程退出前要遍历它们收尾。 */
function listGames() {
    return [...gamesById.values()];
}

/**
 * 进程退出前把所有进行中的对局收干净。
 *
 * 每个游戏可以挂一个 onShutdown 自己决定怎么收尾：
 * - 加压轮盘会存一份快照，下次启动接着打
 * - 没挂钩子的游戏走 cleanupGame，至少把锁释放掉、按钮摘掉，
 *   不会在频道里留下一堆点了就报「已失效」的死按钮
 *
 * 单个游戏收尾失败不能拖累其他游戏，也不能让进程卡着不退出，所以全程
 * try/catch + 整体超时。
 */
async function shutdownAllGames({ timeoutMs = 8000 } = {}) {
    const games = listGames();
    if (games.length === 0) return { total: 0, done: 0 };

    let done = 0;
    const tasks = games.map(async game => {
        try {
            if (typeof game.onShutdown === 'function') {
                await game.onShutdown();
            } else {
                await cleanupGame(game);
            }
            done += 1;
        } catch (error) {
            console.error(
                `[MysteryGameManager] 关停对局失败 (game=${game?.id}, type=${game?.type}):`,
                error
            );
        }
    });

    // 到点就放弃，剩下的交给快照 / 下次启动，不能让进程退不掉。
    await Promise.race([
        Promise.allSettled(tasks),
        new Promise(resolve => setTimeout(resolve, timeoutMs).unref?.()),
    ]);

    return { total: games.length, done };
}

function resetForTests() {
    gamesById.clear();
    playerLocks.clear();
    channelLocks.clear();
}

module.exports = {
    buildChannelKey,
    createGame,
    getGame,
    getPlayerGame,
    getChannelGame,
    addPlayer,
    removePlayer,
    runExclusive,
    cleanupGame,
    listGames,
    shutdownAllGames,
    handleGuildMemberRemove,
    handleGuildMemberUpdate,
    resetForTests,
};
