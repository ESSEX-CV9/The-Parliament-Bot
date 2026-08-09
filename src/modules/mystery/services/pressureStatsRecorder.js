// 加压轮盘的一局数据累加器。
//
// 设计取舍：整局过程只在内存里累加，等 settleGame 时一次性写库（单事务）。
// 好处是写库次数最少，而且「胜场 / 存活」这类只有终局才知道的数据天然和过程数据对齐；
// 代价是机器人在一局进行中崩溃，这一局的数据会丢。派对游戏，可以接受。
//
// 这里的所有函数都是纯内存操作、同步、不抛异常，可以安全地放进
// gameManager.runExclusive 的临界区里调用。

// 字段名直接对齐 pressure_player_stats 的列名，写库时不用再映射一次。
function createPlayerRow(userId) {
    return {
        userId,
        games_played: 1,
        wins: 0,
        survived: 0,
        shots_fired: 0,
        hits_taken: 0,
        blanks: 0,
        loads: 0,
        bullets_loaded: 0,
        again_count: 0,
        pass_count: 0,
        quits: 0,
        max_charge: 0,
        max_bullets_faced: 0,
        timeout_minutes: 0,
        coward_minutes: 0,
        expected_hits: 0,
    };
}

/**
 * 开局时创建累加器。只有真正开打（beginGame 把 state 置为 playing）才该调用，
 * 招募人数不足被取消的局不会产生任何数据。
 * @param {string[]} playerIds 实际上桌的玩家
 */
function createPressureStats(playerIds = []) {
    const players = new Map();
    for (const userId of playerIds) {
        if (typeof userId === 'string' && userId.length > 0 && !players.has(userId)) {
            players.set(userId, createPlayerRow(userId));
        }
    }
    return { players, startedAt: Date.now() };
}

function rowFor(stats, userId) {
    return stats?.players?.get(userId) || null;
}

/**
 * 记一次扣扳机。
 * @param {object} stats
 * @param {string} userId
 * @param {object} shot
 * @param {boolean} shot.hit 是否中弹
 * @param {number} shot.bulletsBefore 开枪前枪里有几发
 * @param {number} shot.unknownBefore 开枪前还有几个弹巢没验过
 * @param {number} [shot.hitChance] 这一枪的真实中弹概率。只有不走弹巢概率的枪
 *   （目前是全局第一枪）才需要传，传了就用它算期望，不再用弹巢推。
 */
function recordShot(stats, userId, { hit, bulletsBefore, unknownBefore, hitChance }) {
    const row = rowFor(stats, userId);
    if (!row) return;

    row.shots_fired += 1;
    if (hit) {
        row.hits_taken += 1;
    } else {
        row.blanks += 1;
    }

    // 敢在枪里有几发子弹的情况下扣扳机，取历史最高。用于「不怕死之人」。
    row.max_bullets_faced = Math.max(row.max_bullets_faced, Number(bulletsBefore) || 0);

    // 开枪那一刻的真实中弹概率累加起来，就是这个人「理论上该中几枪」。
    // expected_hits - hits_taken 即运气值：正数是欧皇，负数是非酋。
    // 这比单纯数空枪次数靠谱得多——后者只会选出玩得最多的人。
    //
    // 调用方显式给了概率就用它（全局第一枪不走弹巢概率），否则按
    // 剩余子弹 / 未验弹巢 推算。
    if (Number.isFinite(hitChance)) {
        row.expected_hits += hitChance;
        return;
    }
    const unknown = Number(unknownBefore) || 0;
    if (unknown > 0) {
        row.expected_hits += (Number(bulletsBefore) || 0) / unknown;
    }
}

/**
 * 记一次空枪后的选择。
 * @param {object} stats
 * @param {string} userId
 * @param {object} choice
 * @param {'again'|'pass'|'load'} choice.action 已经过 handleChoice 归一化的动作
 * @param {number} choice.loadedBullets 这次加压实际塞进去几发
 * @param {number} choice.chargeAfter 这次选择之后的连开蓄力层数
 */
function recordChoice(stats, userId, { action, loadedBullets = 0, chargeAfter = 0 }) {
    const row = rowFor(stats, userId);
    if (!row) return;

    if (action === 'load') {
        row.loads += 1;
        row.bullets_loaded += Number(loadedBullets) || 0;
    } else if (action === 'again') {
        row.again_count += 1;
    } else {
        row.pass_count += 1;
    }

    row.max_charge = Math.max(row.max_charge, Number(chargeAfter) || 0);
}

/** 记一次中弹淘汰带来的禁言时长。 */
function recordElimination(stats, userId, minutes) {
    const row = rowFor(stats, userId);
    if (!row) return;
    row.timeout_minutes += Number(minutes) || 0;
}

/** 记一次逃跑。被动退场（退服 / 被管理员禁言）不走这里，那不是玩家的选择。 */
function recordQuit(stats, userId, penaltyMinutes = 0) {
    const row = rowFor(stats, userId);
    if (!row) return;
    row.quits += 1;
    row.coward_minutes += Number(penaltyMinutes) || 0;
}

/**
 * 结算，产出待写库的行。
 * @param {object} stats
 * @param {object} result
 * @param {'champion'|'draw'|'aborted'|'cancelled'} result.outcome
 * @param {string[]} result.aliveIds 终局时仍然活着的人
 * @returns {Array<object>} 每个玩家一行
 */
function finalizePressureStats(stats, { outcome, aliveIds = [] } = {}) {
    if (!stats?.players || stats.players.size === 0) return [];

    // 冠军算一次胜场 + 一次存活；平局是「子弹打光，大家一起活下来」，
    // 只算存活不算胜场——否则平局会把胜场榜刷得毫无意义。
    for (const userId of aliveIds) {
        const row = rowFor(stats, userId);
        if (!row) continue;
        row.survived += 1;
        if (outcome === 'champion') row.wins += 1;
    }

    return [...stats.players.values()];
}

module.exports = {
    createPressureStats,
    recordShot,
    recordChoice,
    recordElimination,
    recordQuit,
    finalizePressureStats,
};
