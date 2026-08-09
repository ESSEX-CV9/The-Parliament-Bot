// 加压轮盘的排行榜口径与称号定义。
//
// 称号一律在查询时现算，不入库：以后想调阈值、加称号、改文案都不用做数据迁移。
// 称号只是面板上的一行字，不会发身份组、不会改昵称、不影响任何游戏内规则。

// 「欧皇 / 非酋」需要足够的样本量，否则第一次上桌打了两枪没中的人会直接霸榜。
const MIN_LUCK_SHOTS = 10;

function luckOf(row) {
    return (Number(row.expected_hits) || 0) - (Number(row.hits_taken) || 0);
}

function formatMinutes(minutes) {
    const total = Math.max(0, Math.round(Number(minutes) || 0));
    if (total < 60) return `${total} 分钟`;
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}

function formatLuck(value) {
    const rounded = Number(value) || 0;
    return rounded >= 0 ? `+${rounded.toFixed(2)}` : rounded.toFixed(2);
}

// 排行榜可选口径。key 会直接进 Discord 的选项值，保持稳定别乱改。
const METRICS = Object.freeze([
    {
        key: 'wins',
        label: '👑 冠军次数',
        value: row => row.wins,
        format: value => `${value} 胜`,
    },
    {
        key: 'luck',
        label: '🍀 运气值',
        hint: `理论该中的枪数减去实际中弹数，正数是欧皇。需累计开枪 ${MIN_LUCK_SHOTS} 次以上才上榜。`,
        value: luckOf,
        format: formatLuck,
        eligible: row => row.shots_fired >= MIN_LUCK_SHOTS,
    },
    {
        key: 'games',
        label: '🎮 参与场次',
        value: row => row.games_played,
        format: value => `${value} 场`,
    },
    {
        key: 'shots',
        label: '🔫 开枪次数',
        value: row => row.shots_fired,
        format: value => `${value} 枪`,
    },
    {
        key: 'bullets_loaded',
        label: '💣 加压塞入子弹数',
        value: row => row.bullets_loaded,
        format: value => `${value} 发`,
    },
    {
        key: 'max_again',
        label: '🔥 单局最多连开',
        hint: '一局里最多连续选了几次「再来一枪」，中途传枪或加压就断。',
        value: row => row.max_charge,
        format: value => `${value} 连`,
    },
    {
        key: 'again_total',
        label: '🔁 累计连开次数',
        value: row => row.again_count,
        format: value => `${value} 次`,
    },
    {
        key: 'brave',
        label: '😤 最高直面子弹数',
        hint: '敢在枪里已经有几发子弹的情况下扣扳机。',
        value: row => row.max_bullets_faced,
        format: value => `${value} 发`,
    },
    {
        key: 'hits',
        label: '🎯 中弹次数',
        value: row => row.hits_taken,
        format: value => `${value} 次`,
    },
    {
        key: 'quits',
        label: '🤡 逃跑次数',
        value: row => row.quits,
        format: value => `${value} 次`,
    },
    {
        key: 'timeout',
        label: '⛓️ 累计禁言时长',
        value: row => row.timeout_minutes,
        format: formatMinutes,
    },
    {
        key: 'survived',
        label: '🛡️ 存活场次',
        hint: '包含冠军与平局。',
        value: row => row.survived,
        format: value => `${value} 场`,
    },
]);

const METRICS_BY_KEY = new Map(METRICS.map(metric => [metric.key, metric]));
const DEFAULT_METRIC_KEY = 'wins';

function getMetric(key) {
    return METRICS_BY_KEY.get(key) || METRICS_BY_KEY.get(DEFAULT_METRIC_KEY);
}

// 王座称号：全服独占，谁数据第一谁拿，会被人抢走。
// threshold 是最低门槛，防止「全服都是 0」时随便选一个人当榜首。
const THRONES = Object.freeze([
    {
        id: 'lucky',
        emoji: '🍀',
        name: '欧皇',
        blurb: '运气值全服第一，子弹见了他都要绕道。',
        rule: `运气值最高（需累计开枪 ${MIN_LUCK_SHOTS} 次以上，且运气值为正）`,
        value: luckOf,
        format: formatLuck,
        // 必须真的走运（运气值为正）才配当欧皇。只卡「最高」不卡正负的话，
        // 全服都倒霉的时候会把一个运气值 -3 的人捧成欧皇。
        eligible: row => row.shots_fired >= MIN_LUCK_SHOTS && luckOf(row) > 0,
        higherIsBetter: true,
    },
    {
        id: 'cursed',
        emoji: '🪦',
        name: '非酋',
        blurb: '理论上不该中这么多枪的，但他就是中了。',
        rule: `运气值最低（需累计开枪 ${MIN_LUCK_SHOTS} 次以上，且运气值为负）`,
        value: luckOf,
        format: formatLuck,
        // 同理：全服都走运的时候，「运气值最低」的那个人可能一枪没中过，
        // 把他叫非酋纯属冤枉。必须真的中得比该中的多才算。
        eligible: row => row.shots_fired >= MIN_LUCK_SHOTS && luckOf(row) < 0,
        higherIsBetter: false,
    },
    {
        id: 'gun_king',
        emoji: '👑',
        name: '枪王',
        blurb: '活到最后的次数最多的人。',
        rule: '冠军次数最多（至少 1 次）',
        value: row => row.wins,
        format: value => `${value} 胜`,
        eligible: row => row.wins >= 1,
        higherIsBetter: true,
    },
    {
        id: 'pressure_master',
        emoji: '💣',
        name: '压力大师',
        blurb: '往枪里塞子弹这件事，他做得比谁都熟练。',
        rule: '加压塞入的子弹总数最多（至少 1 发）',
        value: row => row.bullets_loaded,
        format: value => `${value} 发`,
        eligible: row => row.bullets_loaded >= 1,
        higherIsBetter: true,
    },
    {
        id: 'fearless',
        emoji: '😤',
        name: '不怕死之人',
        blurb: '枪里那么多发，他眼都不眨就扣了扳机。',
        rule: '直面过的子弹数最高（至少 2 发）',
        value: row => row.max_bullets_faced,
        format: value => `${value} 发`,
        eligible: row => row.max_bullets_faced >= 2,
        higherIsBetter: true,
    },
    {
        id: 'chain_maniac',
        emoji: '🔁',
        name: '连开狂魔',
        blurb: '枪就不肯从手里放下。',
        rule: '一局里连开次数最多（至少连开 2 次）',
        value: row => row.max_charge,
        format: value => `${value} 连`,
        eligible: row => row.max_charge >= 2,
        higherIsBetter: true,
    },
    {
        id: 'ironhead',
        emoji: '🎯',
        name: '铁头娃',
        blurb: '这把枪好像认得他。',
        rule: '中弹次数最多（至少 1 次）',
        value: row => row.hits_taken,
        format: value => `${value} 次`,
        eligible: row => row.hits_taken >= 1,
        higherIsBetter: true,
    },
    {
        id: 'jailbird',
        emoji: '⛓️',
        name: '牢底坐穿',
        blurb: '为这个游戏付出的时间，用小时算。',
        rule: '中弹累计禁言时长最长（至少 1 分钟）',
        value: row => row.timeout_minutes,
        format: formatMinutes,
        eligible: row => row.timeout_minutes >= 1,
        higherIsBetter: true,
    },
    {
        id: 'deserter',
        emoji: '🤡',
        name: '逃跑艺术家',
        blurb: '打不过就跑，跑得比谁都勤。',
        rule: '逃跑次数最多（至少 1 次）',
        value: row => row.quits,
        format: value => `${value} 次`,
        eligible: row => row.quits >= 1,
        higherIsBetter: true,
    },
]);

// 成就称号：达标即得，不会被抢走，人人可以同时拥有多个。
const ACHIEVEMENTS = Object.freeze([
    {
        id: 'first_load',
        emoji: '🔫',
        name: '初次上膛',
        rule: '完整打完 1 场加压轮盘',
        test: row => row.games_played >= 1,
    },
    {
        id: 'regular',
        emoji: '🎰',
        name: '常客',
        rule: '累计参与 10 场',
        test: row => row.games_played >= 10,
    },
    {
        id: 'veteran',
        emoji: '🎖️',
        name: '百枪老兵',
        rule: '累计开枪 100 次',
        test: row => row.shots_fired >= 100,
    },
    {
        id: 'pacifist',
        emoji: '🕊️',
        name: '和平主义者',
        rule: '打满 5 场，一发子弹都没往枪里加过',
        test: row => row.games_played >= 5 && row.loads === 0,
    },
    {
        id: 'full_cylinder',
        emoji: '🧨',
        name: '六发全满',
        rule: '在满弹巢（6 发）的枪口前扣下扳机',
        test: row => row.max_bullets_faced >= 6,
    },
    {
        id: 'triple_crown',
        emoji: '🏆',
        name: '三冠王',
        rule: '拿下 3 次冠军',
        test: row => row.wins >= 3,
    },
    {
        id: 'survivor',
        emoji: '🛡️',
        name: '老兵不死',
        rule: '存活收场 5 次（含平局）',
        test: row => row.survived >= 5,
    },
    {
        id: 'martyr',
        emoji: '💀',
        name: '向死而生',
        rule: '累计中弹 10 次',
        test: row => row.hits_taken >= 10,
    },
    {
        id: 'five_in_a_row',
        emoji: '🔥',
        name: '五连开',
        rule: '一局里连续 5 次选择「再来一枪」',
        test: row => row.max_charge >= 5,
    },
    {
        id: 'gambler',
        emoji: '🎲',
        name: '赌徒',
        rule: '累计加压 25 次',
        test: row => row.loads >= 25,
    },
    {
        id: 'hour_in_jail',
        emoji: '⏳',
        name: '一小时监禁',
        rule: '因中弹累计被禁言满 60 分钟',
        test: row => row.timeout_minutes >= 60,
    },
]);

// 同分时按参与场次多的优先，再按 user_id 兜底，保证榜单顺序稳定不跳。
function compareRows(a, b, valueOf, higherIsBetter) {
    const delta = valueOf(b.row) - valueOf(a.row);
    if (delta !== 0) return higherIsBetter ? delta : -delta;
    const games = (b.row.games_played || 0) - (a.row.games_played || 0);
    if (games !== 0) return games;
    return String(a.row.user_id).localeCompare(String(b.row.user_id));
}

/**
 * 按某个口径排名。
 * @returns {Array<{row: object, value: number, rank: number}>}
 */
function rankBy(rows, metric, { higherIsBetter = true } = {}) {
    const eligible = (rows || [])
        .filter(row => (typeof metric.eligible === 'function' ? metric.eligible(row) : true))
        .map(row => ({ row, value: metric.value(row) }));

    eligible.sort((a, b) => compareRows(a, b, metric.value, higherIsBetter));
    return eligible.map((entry, index) => ({ ...entry, rank: index + 1 }));
}

/**
 * 算出全服每个王座称号的当前持有者。
 * @param {Array<object>} rows 该服务器的全部玩家数据
 * @returns {Map<string, {userId: string, value: number, display: string}>}
 */
function computeThroneHolders(rows) {
    const holders = new Map();
    for (const throne of THRONES) {
        const ranked = rankBy(rows, throne, { higherIsBetter: throne.higherIsBetter });
        const top = ranked[0];
        if (!top) continue;
        holders.set(throne.id, {
            userId: top.row.user_id,
            value: top.value,
            display: throne.format(top.value),
        });
    }
    return holders;
}

/**
 * 某个玩家当前持有的称号。
 * @param {Array<object>} rows 该服务器的全部玩家数据
 * @param {string} userId
 */
function titlesForUser(rows, userId) {
    const holders = computeThroneHolders(rows);
    const own = (rows || []).find(row => row.user_id === userId) || null;

    const thrones = THRONES
        .filter(throne => holders.get(throne.id)?.userId === userId)
        .map(throne => ({ ...throne, holder: holders.get(throne.id) }));

    const achievements = own
        ? ACHIEVEMENTS.filter(achievement => achievement.test(own))
        : [];

    return { thrones, achievements, holders, row: own };
}

module.exports = {
    MIN_LUCK_SHOTS,
    METRICS,
    DEFAULT_METRIC_KEY,
    THRONES,
    ACHIEVEMENTS,
    getMetric,
    luckOf,
    formatMinutes,
    formatLuck,
    rankBy,
    computeThroneHolders,
    titlesForUser,
};
