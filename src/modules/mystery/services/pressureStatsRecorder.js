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
        duds_fired: 0,
        loads: 0,
        bullets_loaded: 0,
        peaceful_games: 0, // 终局时按本局 loads 是否为 0 填，见 finalizePressureStats

        again_count: 0,
        pass_count: 0,
        quits: 0,
        max_charge: 0,
        max_bullets_faced: 0,
        timeout_minutes: 0,
        coward_minutes: 0,
        expected_hits: 0,
     unloads: 0,
        ripostes: 0,
        riposte_kills: 0,
        riposted_count: 0,
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
 * @param {boolean} shot.hit 是否中弹（只有实弹才算）
 * @param {boolean} [shot.dud] 这一枪打到的是哑弹
 * @param {number} shot.bulletsBefore 开枪前枪里有几发（实弹 + 哑弹），公开口径
 * @param {number} [shot.liveBefore] 开枪前枪里有几发是实弹，全场都不知道的口径
 * @param {number} shot.unknownBefore 开枪前还有几个弹巢没验过
 */
function recordShot(stats, userId, { hit, dud = false, bulletsBefore, liveBefore, unknownBefore }) {
    const row = rowFor(stats, userId);
    if (!row) return;

    // 三种互斥结局：中弹 / 哑弹 / 空枪。shots_fired 恒等于三者之和。
    row.shots_fired += 1;
    if (hit) {
        row.hits_taken += 1;
    } else if (dud) {
        row.duds_fired += 1;
    } else {
        row.blanks += 1;
    }

    // 敢在枪里有几发子弹的情况下扣扳机，取历史最高。用于「不怕死之人」。
    // 这里的弹数是公开口径（含哑弹）—— 他扣扳机时看到的就是这个数。
    row.max_bullets_faced = Math.max(row.max_bullets_faced, Number(bulletsBefore) || 0);

    // 扣扳机那一刻真正会淘汰他的概率累加起来，就是这个人「理论上该中几枪」。
    // expected_hits - hits_taken 即运气值：正数是欧皇，负数是非酋。
    // 这比单纯数空枪次数靠谱得多——后者只会选出玩得最多的人。
    //
    // 两个必须守住的口径，否则运气值会系统性跑偏：
    // ① 分子只能用实弹数。哑弹占着弹巢但杀不了人，把它算进分子等于凭空发运气
    //    （开局那一发要是哑弹，真实中弹概率就是 0）。而 hits_taken 只数实弹，
    //    分子分母两边口径不一致，全服就会人均欧皇。
    // ② 每一枪都要记，包括打出哑弹的那一枪。扣扳机时他并不知道会是哑弹，
    //    承担的是同一份真实风险；按结果回头筛掉这些样本，就是拿结论去挑证据。
    // 守住这两条，luck 的期望才严格为 0，欧皇 / 非酋才是在比手气。
    const unknown = Number(unknownBefore) || 0;
    if (unknown > 0) {
        const live = Number.isFinite(liveBefore) ? Math.max(0, liveBefore) : (Number(bulletsBefore) || 0);
        row.expected_hits += live / unknown;
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

/** 记一次抽弹开枪（fire 阶段卸弹自救）。 */
function recordUnload(stats, userId) {
    const row = rowFor(stats, userId);
    if (!row) return;
    row.unloads += 1;
}

/**
 * 记一次反手还击。
 * @param {string} initiatorId 发起反手的人
 * @param {string} targetId 被反手（最后一次加压）的人
 */
function recordRiposte(stats, initiatorId, targetId) {
    const initiator = rowFor(stats, initiatorId);
    if (initiator) initiator.ripostes += 1;
    const target = rowFor(stats, targetId);
    if (target) target.riposted_count += 1;
}

/** 记一次反手成功送走加压者（加压者在被迫开枪时中弹）。 */
function recordRiposteKill(stats, userId) {
    const row = rowFor(stats, userId);
    if (!row) return;
    row.riposte_kills += 1;
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

    // 「这一局全程没往枪里加过子弹」是个只有终局才能下结论的判断，和胜场/存活一样放在这里。
    // 存成累加列而不是在称号里查 loads === 0，是为了让「和平主义者」这类成就单调只增：
    // 攒够的和平局数是既成事实，之后再怎么加压也抹不掉。
    for (const row of stats.players.values()) {
        row.peaceful_games = row.loads === 0 ? 1 : 0;
    }

    return [...stats.players.values()];
}

module.exports = {
    createPressureStats,
    recordShot,
    recordChoice,
    recordElimination,
    recordQuit,
    recordUnload,
    recordRiposte,
    recordRiposteKill,
    finalizePressureStats,
};
