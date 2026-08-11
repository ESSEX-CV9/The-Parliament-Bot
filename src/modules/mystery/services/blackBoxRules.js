const MIN_PLAYERS = 4;
const MAX_PLAYERS = 8;
const INITIAL_CHIPS = 4;
const MAX_CHIPS = 6;

function assertPlayerCount(survivorCount) {
    if (
        !Number.isInteger(survivorCount)
        || survivorCount < 2
        || survivorCount > MAX_PLAYERS
    ) {
        throw new TypeError(`black box survivor count must be 2-${MAX_PLAYERS}`);
    }
}

function dangerousBoxCount(survivorCount, roundNumber) {
    assertPlayerCount(survivorCount);
    if (!Number.isInteger(roundNumber) || roundNumber < 1) {
        throw new TypeError('roundNumber must be a positive integer');
    }
    const base = survivorCount <= 5 ? 1 : 2;
    const extra = Math.floor((roundNumber - 1) / 2);
    return Math.min(survivorCount - 1, base + extra);
}

function buildNormalDeck(survivorCount, roundNumber) {
    const dangerous = dangerousBoxCount(survivorCount, roundNumber);
    return [
        ...Array.from({ length: dangerous }, () => 'dangerous'),
        ...Array.from({ length: survivorCount - dangerous }, () => 'safe'),
    ];
}

function buildFinalDeck() {
    return ['safe', 'safe', 'dangerous'];
}

function shuffle(items, randomInt) {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i -= 1) {
        const j = randomInt(i + 1);
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

function pairPlayers(playerIds, { previousByeId, randomInt }) {
    if (!Array.isArray(playerIds) || playerIds.length < 2) {
        throw new TypeError('pairPlayers requires at least two players');
    }
    const ordered = shuffle(playerIds, randomInt);
    let byeId = null;
    let paired = ordered;
    if (ordered.length % 2 === 1) {
        byeId = ordered[ordered.length - 1];
        // 避免连续轮空：只要还有别的可选轮空对象就换一个。
        if (byeId === previousByeId && ordered.length >= 4) {
            const swapIndex = ordered.findIndex(id => id !== previousByeId);
            [ordered[ordered.length - 1], ordered[swapIndex]] = [ordered[swapIndex], ordered[ordered.length - 1]];
            byeId = ordered[ordered.length - 1];
        }
        paired = ordered.slice(0, ordered.length - 1);
    }
    const pairs = [];
    for (let i = 0; i < paired.length; i += 2) {
        pairs.push([paired[i], paired[i + 1]]);
    }
    return { pairs, byeId };
}

function resolveExchange(actionA, actionB, counterDecision) {
    const validActions = ['keep', 'exchange'];
    if (!validActions.includes(actionA) || !validActions.includes(actionB)) {
        throw new TypeError('exchange actions must be keep or exchange');
    }
    if (actionA === 'exchange' && actionB === 'exchange') {
        return { swapped: true, lockCostUserId: null };
    }
    if (actionA === 'keep' && actionB === 'keep') {
        return { swapped: false, lockCostUserId: null };
    }
    const keeperId = actionA === 'keep' ? 'a' : 'b';
    if (counterDecision === 'lock') {
        return { swapped: false, lockCostUserId: keeperId };
    }
    if (counterDecision === 'allow' || counterDecision === null || counterDecision === undefined) {
        return { swapped: true, lockCostUserId: null };
    }
    throw new TypeError('counterDecision must be lock or allow');
}

function applyChipOutcome({ chips, wager, box }) {
    if (!['stable', 'wager'].includes(wager)) {
        throw new TypeError('wager must be stable or wager');
    }
    if (!['safe', 'dangerous'].includes(box)) {
        throw new TypeError('box must be safe or dangerous');
    }
    let delta;
    if (wager === 'stable') {
        delta = box === 'safe' ? 0 : -2;
    } else {
        delta = box === 'safe' ? 1 : -3;
    }
    return Math.min(MAX_CHIPS, chips + delta);
}

function eliminationTimeoutMs(batchNumber) {
    if (batchNumber <= 1) return 3 * 60_000;
    if (batchNumber === 2) return 4 * 60_000;
    return 5 * 60_000;
}

function finalTimeoutMs(wagerCount) {
    if (wagerCount === 0) return 5 * 60_000;
    if (wagerCount === 1) return 8 * 60_000;
    if (wagerCount === 2) return 10 * 60_000;
    throw new TypeError('wagerCount must be 0, 1, or 2');
}

module.exports = {
    MIN_PLAYERS,
    MAX_PLAYERS,
    INITIAL_CHIPS,
    MAX_CHIPS,
    dangerousBoxCount,
    buildNormalDeck,
    buildFinalDeck,
    shuffle,
    pairPlayers,
    resolveExchange,
    applyChipOutcome,
    eliminationTimeoutMs,
    finalTimeoutMs,
};
