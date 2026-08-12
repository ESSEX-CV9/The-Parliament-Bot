const { randomUUID } = require('node:crypto');
const { MessageFlags } = require('discord.js');
const gameManager = require('./mysteryGameManager');
const panels = require('./pressureRoulettePanels');
const {
    applyCowardPenalty,
    settleCowardPenalties,
    redeemCowardPenalties,
    cowardPenaltyMinutes,
    cowardPenaltyRemainingMs,
} = require('./cowardPenalty');
const { invalidatePanel, deleteMessageAfter } = require('./panelLifecycle');
const {
    createPressureStats,
    recordShot,
    recordChoice,
    recordElimination,
    recordQuit,
    recordUnload,
    recordRiposte,
    recordRiposteKill,
    finalizePressureStats,
} = require('./pressureStatsRecorder');
const { recordPressureGame } = require('../utils/mysteryStatsDatabase');
const gameStore = require('../utils/pressureGameStore');

const GAME_TYPE = 'pressure';
const CUSTOM_ID_PREFIX = 'mystery_pressure_';
const CHAMBER_COUNT = 6;
const MIN_PARTICIPANTS = 3;
const MAX_PARTICIPANTS = 6;
const RECRUITMENT_DURATION_MS = 3 * 60 * 1000;
const TURN_DURATION_MS = 60 * 1000;
// 挂机超时阶梯（方案 B：整局累计、只增不减）：
// 同一局里第一次挂满等 TURN_DURATION_MS（默认 60 秒），
// 第二次挂满只等 30 秒，第三次起只等 15 秒。
const SHORT_TURN_DURATION_MS = 30 * 1000;
const MIN_TURN_DURATION_MS = 15 * 1000;
const HIT_PAUSE_MS = 3 * 1000;
const BASE_TIMEOUT_MINUTES = 3;
// 每加压一发赌注涨 0.5 分钟（Discord 禁言最短 1 分钟，基础赌注 3 分钟起，
// 3.5 / 4 / 4.5 … 都是合法时长，永远不会低于下限）。
const MINUTES_PER_PRESSURE = 0.5;
const TIMEOUT_REASON = '神秘指令：加压俄罗斯轮盘';

// ---------- 加压的强制开枪档位 ----------
// 加压塞几发子弹由蓄力决定（1 + 蓄力），但「下家这个回合要连开几枪」是另一套账：
// 上家再开 0~2 次 → 下家只开 1 枪（就是普通回合）；
// 上家再开 3 次以上 → 下家要连开 2 枪，封顶两枪，再怎么连开也不会更多。
// 欠着枪的人拿不到传枪 / 加压 / 反手，只能继续开、退弹或者当胆小鬼。
const FORCED_SHOTS_TIER2_CHARGE = 2;
const FORCED_SHOTS_TIER2 = 1;

// ---------- 待发子弹池 ----------
// 每一轮准备一池 POOL_SIZE 发，其中随机 POOL_DUD_MIN~POOL_DUD_MAX 发是哑弹。
// 枪里的每一发都是从这里抽的，
// 池子没空之前游戏不会因为「子弹打光」而收场：枪打空就自动补 1 发接着打。
//
// 公开的只有「池里还剩几发」和「本轮一共几发哑弹」。哪一发是哑弹、
// 枪里当前这几发的真假构成，全场都不知道（包括加压的人自己）。
// 打出去的哑弹会当众播报，想推构成就自己数——面板不替玩家记账。
const POOL_SIZE = 9;
const POOL_DUD_MIN = 1;
const POOL_DUD_MAX = 3;
// 枪打空且池里还有弹时，系统自动补进去的发数。系统补的不算加压，不抬赌注。
const AUTO_RELOAD_BULLETS = 1;
// 池子也空了之后的和局判定：存活的人投票，超时算同意，一人反对就重开一轮。
const DRAW_VOTE_DURATION_MS = 35 * 1000;

// 弹巢格子的三种内容：实弹 / 哑弹 / null（空巢）。
// 哑弹和实弹在弹巢里完全同构 —— 占一格、被击发就消耗掉、弹数 -1，
// 唯一的区别是它不淘汰人。
const LIVE = 'live';
const DUD = 'dud';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
// 游戏进行中保留的消息数（含当前这条）。超出窗口的旧消息才删。
const PANEL_HISTORY_LIMIT = 3;
// 测试用虚拟玩家。真实 Discord ID 全是数字，不会撞。
const VIRTUAL_PREFIX = 'testbot-';
const VIRTUAL_THINK_MS = 2500;
// 和局判定里，整场机器人合起来有多大概率派一个出来掀桌。
// 只是为了让测试局能覆盖到「重开一轮」，调高了会让测试局打不完。
const VIRTUAL_OBJECT_CHANCE = 0.35;
const TEST_MIN_PARTICIPANTS = 2;
const MAX_TEST_BOTS = 5;
const TURN_ACTIONS = Object.freeze({
    fire: 'fire',
    quit: 'fire',
    unload: 'fire',
    pass: 'choice',
    again: 'choice',
    load: 'choice',
    riposte: 'choice',
});
// 和局判定的两个按钮。它们不看「枪在谁手里」，只要还活着就能点，
// 所以不走 TURN_ACTIONS 那套当前持枪者校验。
const VOTE_ACTIONS = Object.freeze({ agree: 'agree', object: 'object' });

const PLAYER_BUSY_MESSAGE = '🚫 **一心不能二用。**\n你现在已经在一场神秘游戏里，先把那边活着玩完再说。';
const CHANNEL_BUSY_MESSAGE = '🎮 **这里已经有一场游戏在进行了。**\n等当前游戏结束后再开新的吧。';
const TIMEOUT_BLOCKED_MESSAGE = '🔫 **左轮拒绝了你。**\n你当前还在禁言，暂时无法参加。';

// 名字上挂着 🤡 的人可以上桌，但这局没有退路 —— 逃生机会你已经用掉一次了。
const NO_ESCAPE_MESSAGE = [
    '🤡 **你是戴罪上桌的，没有第二次。**',
    '这局的逃生按钮对你不开放，枪已经在你手里了。',
].join('\n');
const INVALID_MEMBER_MESSAGE = '⚠️ **你现在无法参加这场加压俄罗斯轮盘。**';
const EXPIRED_MESSAGE = '⌛ **这场加压俄罗斯轮盘已经结束或失效了。**';
const FULL_MESSAGE = '🔫 **这局已经满员了。**';
const DUPLICATE_MESSAGE = '👀 **你已经报过名了。**\n再点也不会多给你一条命。';
const JOINED_MESSAGE = '🔫 **报名成功。**\n\n枪里有一发子弹，位置没人知道。';
const NOT_YOUR_TURN_MESSAGE = '✋ **枪不在你手里。**\n等轮到你再说。';
const STALE_ACTION_MESSAGE = '⌛ **这个操作已经过时了。**\n请看频道里最新的那条面板。';
const VOTE_OUTSIDER_MESSAGE = '🪑 **你不在这场投票里。**\n只有还活着的人才有资格决定要不要收场。';
const VOTE_DUPLICATE_MESSAGE = '🗳️ **你已经投过了。**\n改不了主意，这一票算数。';
const VOTE_AGREE_ACK = '🤝 **你同意就此收场。**\n只要有一个人不同意，枪就会重新装满。';
const VOTE_OBJECT_ACK = '🔫 **你不同意。**\n新的一池子弹马上就来，这是你自己要的。';
const PANEL_FAILURE_MESSAGE = '❌ **开局失败了。**\n我没能在这个频道发出游戏面板，请检查我的发言权限。';
const START_ACK_MESSAGE = '🔫 **加压俄罗斯轮盘已开启。**\n招募面板已发在频道里。';
const START_TEST_ACK_MESSAGE = '🧪 **测试局已开启。**\n测试机器人会自动行动，真人也可以点「参加」加入。';

function logDiscordFailure(game, action, error, userId = 'system') {
    console.error(
        `[MysteryPressure] Discord API 失败 (guild=${game?.guildId || 'unknown'}, game=${game?.id || 'unknown'}, user=${userId}, action=${action}):`,
        error
    );
}

function randomFor(game) {
    return typeof game?.random === 'function' ? game.random() : Math.random();
}

function isVirtualPlayer(userId) {
    return typeof userId === 'string' && userId.startsWith(VIRTUAL_PREFIX);
}

function minParticipantsFor(game) {
    return game.testConfig ? TEST_MIN_PARTICIPANTS : MIN_PARTICIPANTS;
}

function turnDurationFor(game) {
    return game.turnDurationMs || TURN_DURATION_MS;
}

// 某个玩家这次等待多少秒（60 / 30 / 15 阶梯，方案 B：整局累计、只增不减）：
// tier 0 从没挂满过 → 基础等待（默认 60 秒，测试可自定义）；
// tier 1 挂满过 1 次 → 30 秒；tier ≥2 挂满过 2 次以上 → 15 秒。
// 管理员把基础回合改得比 30/15 还短时，按更短的基础值来，不能越等越长。
function turnTimeoutMsFor(game, userId) {
    const base = turnDurationFor(game);
    const tier = Math.min(2, (game.timeoutTiers && game.timeoutTiers[userId]) || 0);
    if (tier >= 2) return Math.min(base, MIN_TURN_DURATION_MS);
    if (tier === 1) return Math.min(base, SHORT_TURN_DURATION_MS);
    return base;
}

// 系统等到点替他行动 → 挂满次数 +1。虚拟机器人是「思考后自动行动」，不算挂机。
function bumpTimeoutTier(game, userId) {
    if (!game || isVirtualPlayer(userId)) return;
    const tiers = game.timeoutTiers || (game.timeoutTiers = {});
    tiers[userId] = Math.min(2, (tiers[userId] || 0) + 1);
}

function nameFor(game, userId) {
    return panels.nameOf({ labels: game.labels || {} }, userId);
}

// 机器人偏激进：不加压就不会有人被淘汰，测试时局面推不动。
// 攒了蓄力就更倾向于兑现，否则测试局里几乎看不到一次塞好几发的情况。
// 决策需要看到 choice 面板的按钮状态（有没有反手权），否则测试局覆盖不到反手分支。
function pickVirtualAction(game, view) {
    const roll = randomFor(game);
    const charge = chargeFor(game, game.alive[game.turnIndex]);
    // 有反手权就有一半以上的概率把加压者拉下水——派对游戏，同归于尽很有吸引力。
    if (view?.canRiposte && roll < 0.7) return 'riposte';
    if (game.bullets < CHAMBER_COUNT && roll < 0.35 + (charge * 0.2)) return 'load';
    if (roll < 0.7) return 'again';
    return 'pass';
}

function shuffleInPlace(items, game) {
    for (let index = items.length - 1; index > 0; index -= 1) {
        const target = Math.min(index, Math.floor(randomFor(game) * (index + 1)));
        [items[index], items[target]] = [items[target], items[index]];
    }
    return items;
}

// 把枪里现有的 bullets 发（其中 gunDuds 发是哑弹）重新随机撒进 6 个弹巢。
// positions 是均匀洗牌，所以「前 gunDuds 个位置放哑弹」就是均匀分配，
// 玩家看到的弹巢视图（全部未验）不会泄露任何真假信息。
function spinCylinder(game) {
    const positions = shuffleInPlace(
        Array.from({ length: CHAMBER_COUNT }, (_, index) => index),
        game
    );
    game.chambers = new Array(CHAMBER_COUNT).fill(null);
    const total = Math.min(game.bullets, CHAMBER_COUNT);
    const duds = Math.min(game.gunDuds || 0, total);
    for (let index = 0; index < total; index += 1) {
        game.chambers[positions[index]] = index < duds ? DUD : LIVE;
    }
    game.revealed = new Array(CHAMBER_COUNT).fill(false);
    game.hitChambers = new Array(CHAMBER_COUNT).fill(false);
    game.dudChambers = new Array(CHAMBER_COUNT).fill(false);
    game.pointer = 0;
}

// 备一轮新的待发子弹池：POOL_SIZE 发，其中随机 POOL_DUD_MIN~POOL_DUD_MAX 发哑弹，洗匀。
// 哑弹总数本轮固定且公开，具体是哪几发不公开。
function preparePool(game) {
    const span = POOL_DUD_MAX - POOL_DUD_MIN + 1;
    const dudCount = POOL_DUD_MIN + Math.floor(randomFor(game) * span);
    const pool = [];
    for (let index = 0; index < POOL_SIZE; index += 1) {
        pool.push(index < dudCount ? DUD : LIVE);
    }
    shuffleInPlace(pool, game);
    game.pool = pool;
    game.poolDudTotal = dudCount;
    game.wave = (game.wave || 0) + 1;
}

// 从池顶抽 count 发装进枪。池不够就有多少抽多少。
// 池已经洗过了，所以从头抽和随机抽是一回事。
function drawIntoGun(game, count) {
    const drawn = { total: 0, duds: 0 };
    for (let index = 0; index < count && game.pool.length > 0; index += 1) {
        const round = game.pool.shift();
        drawn.total += 1;
        if (round === DUD) drawn.duds += 1;
    }
    game.bullets += drawn.total;
    game.gunDuds += drawn.duds;
    return drawn;
}

// 系统自动补弹：只往「还没验过」的格子里随机补，已验格子的历史原样保留。
// 弹巢被打穿一整轮（6 格全验过、没有可补的未知格）时才回退到整巢重转。
function reloadIntoUnknownChambers(game, count) {
    const unknownIndexes = [];
    for (let index = 0; index < CHAMBER_COUNT; index += 1) {
        if (!game.revealed[index]) unknownIndexes.push(index);
    }
    if (unknownIndexes.length === 0) {
        drawIntoGun(game, count);
        spinCylinder(game);
        return { mode: 'spin', filled: 0, unknownBefore: 0 };
    }
    const drawn = drawIntoGun(game, Math.min(count, unknownIndexes.length));
    const positions = shuffleInPlace([...unknownIndexes], game);
    for (let index = 0; index < drawn.total; index += 1) {
        game.chambers[positions[index]] = index < drawn.duds ? DUD : LIVE;
    }
    // 弹巢历史不动：revealed / hitChambers / dudChambers / pointer 全保留。
    return { mode: 'fill', filled: drawn.total, unknownBefore: unknownIndexes.length };
}

// 存活名单按接下来的行动顺序排：当前持枪的人排第一，后面依次是排在他之后的人。
// 中弹 / 退出时 turnIndex 已经被挪到了下一个人身上，所以这里直接从它起转一圈就对。
// 反手序列的「target 阶段」当前持枪的是被反手的加压者，这一枪之后发起人被跳过，
// 所以名单要把发起人挪到队尾，之后才回到正常轮转。
function turnOrderIds(game) {
    const alive = game.alive || [];
    if (alive.length <= 1) return [...alive];
    const rip = game.riposte;
    if (rip?.stage === 'target') {
        const targetIndex = alive.indexOf(rip.targetId);
        if (targetIndex !== -1 && alive.includes(rip.initiatorId)) {
            // 加压者这一枪之后发起人被跳过，直接轮到发起人后面的人：
            // 从加压者起按原顺序列队，把发起人挪到队尾。
            const rest = alive.filter(id => id !== rip.initiatorId);
            const restTargetPos = rest.indexOf(rip.targetId);
            return [...rest.slice(restTargetPos), ...rest.slice(0, restTargetPos), rip.initiatorId];
        }
    }
    const start = ((game.turnIndex % alive.length) + alive.length) % alive.length;
    return [...alive.slice(start), ...alive.slice(0, start)];
}

function unknownChamberCount(game) {
    return game.revealed.reduce((total, revealed) => (revealed ? total : total + 1), 0);
}

// 赌注按「一共往枪里塞了几发」算，而不是按加压次数：
// 蓄力兑现时一次塞 3 发，赌注就要涨 3 分钟。
function currentStakeMinutes(game) {
    return BASE_TIMEOUT_MINUTES + ((game.pressureBullets || 0) * MINUTES_PER_PRESSURE);
}

// 戴罪上桌：开局那一刻名字上还挂着 🤡 的人。名单在 beginGame 里快照一次，
// 之后整局不再重算 —— 结算时 game.alive 已经不含中弹的人了，而他们照样算打完了这局。
function isRedeemer(game, userId) {
    return Boolean(userId) && (game.redeemers || []).includes(userId);
}

// 他没挂完的 🤡 还剩几分钟。中弹时按这个数折进禁言，等于把逃掉的那份还上。
function redeemerRemainingMinutes(game, userId) {
    if (!isRedeemer(game, userId)) return 0;
    const remainingMs = cowardPenaltyRemainingMs(game.guildId, userId);
    return remainingMs > 0 ? Math.ceil(remainingMs / 60000) : 0;
}

// 中途退服 / 被管理员禁言而出局的，不算把这局打完，摘牌资格一并取消。
function dropRedeemer(game, userId) {
    if (!Array.isArray(game.redeemers)) return;
    const index = game.redeemers.indexOf(userId);
    if (index !== -1) game.redeemers.splice(index, 1);
}

// 连开蓄力：连续对自己开枪，每撑过一枪攒 1 层，加压时兑现成额外子弹。
// 蓄力连着持有人一起记，这样有人中途退出导致轮次错位时，
// 攒下的层数也不会被别人捡走，枪一离手自然失效。
function chargeFor(game, userId) {
    if (!userId || game.chargeOwnerId !== userId) return 0;
    return game.charge || 0;
}

function setCharge(game, userId, value) {
    const next = Math.max(0, value);
    game.charge = next;
    game.chargeOwnerId = next > 0 ? userId : null;
}

// ---------- 加压逼出来的强制开枪债 ----------
// 债跟着欠债的人记（和蓄力同一个思路）：中途有人出局导致轮次错位时，
// 别人不会替他背这笔债，欠债的人一走债就跟着消失。
// 只有第二档（连开 3 次以上再加压）才会真正记债，第一档就是普通回合，不记。

function forcedShotsForCharge(charge) {
    return charge >= FORCED_SHOTS_TIER2_CHARGE ? FORCED_SHOTS_TIER2 : 1;
}

// 这个人这个回合还欠几枪（含即将开的这一枪）。0 = 没欠债，走普通回合。
function debtFor(game, userId) {
    const debt = game?.pressureDebt;
    if (!userId || !debt || debt.ownerId !== userId) return 0;
    return Math.max(0, debt.remaining || 0);
}

// sourceId 是把这笔债压过来的加压者，面板上要指名道姓，不然没人知道该恨谁。
function setPressureDebt(game, userId, shots, sourceId) {
    game.pressureDebt = userId && shots > 1
        ? { ownerId: userId, remaining: shots, total: shots, sourceId: sourceId || null }
        : null;
}

function clearPressureDebt(game, userId) {
    if (game?.pressureDebt?.ownerId === userId) game.pressureDebt = null;
}

// 扣掉一枪，返回扣完还欠几枪。还欠着就继续留在 fire 阶段接着开。
function consumePressureDebt(game, userId) {
    const debt = game.pressureDebt;
    if (!debt || debt.ownerId !== userId) return 0;
    const remaining = Math.max(0, (debt.remaining || 0) - 1);
    if (remaining === 0) game.pressureDebt = null;
    else debt.remaining = remaining;
    return remaining;
}

// 这次加压实际能塞进去几发：基础 1 发 + 蓄力层数，
// 塞不下就按弹巢剩余空位截断，池里不够就按池余量截断。
function loadBulletsFor(game, userId) {
    return Math.min(
        1 + chargeFor(game, userId),
        CHAMBER_COUNT - game.bullets,
        (game.pool || []).length
    );
}

// 反手打完之后枪会不会留在加压者自己手里：跳过发起人绕一圈，下一个接枪的
// 正好又是加压者本人（2 人残局，或反手权顺延到队尾之后）。面板要按这个说清楚
// 枪的去向 —— 这种局面下反手等于「传枪 + 剥夺他这一枪的逃跑 / 退弹权」。
function riposteKeepsGun(game, initiatorId, targetId) {
    const alive = game.alive || [];
    const index = alive.indexOf(initiatorId);
    if (index === -1 || !targetId) return false;
    return alive[(index + 1) % alive.length] === targetId;
}

function chamberView(game) {
    return game.revealed.map((revealed, index) => {
        if (game.state === 'playing' && index === game.pointer && !revealed) return 'next';
        if (revealed) {
            if (game.hitChambers?.[index]) return 'hit';
            if (game.dudChambers?.[index]) return 'dud';
            return 'spent';
        }
        return 'unknown';
    });
}

function buildView(game) {
    const unknownCount = unknownChamberCount(game);
    const shooterId = game.alive[game.turnIndex];
    // 强制开枪债：remaining 含即将开的这一枪，所以「这是第几枪」= total - remaining + 1。
    const debtRemaining = debtFor(game, shooterId);
    const debtTotal = debtRemaining > 0 ? (game.pressureDebt?.total || debtRemaining) : 0;
    return {
        gameId: game.id,
        turnToken: game.turnToken,
        chambers: chamberView(game),
        chamberCount: CHAMBER_COUNT,
        bullets: game.bullets,
        // 待发子弹池的公开口径：还剩几发、本轮一共几发哑弹、这是第几轮。
        // 打出去几发哑弹不给数，玩家自己记。
        poolRemaining: (game.pool || []).length,
        poolDudTotal: game.poolDudTotal || 0,
        poolSize: POOL_SIZE,
        poolDudMin: POOL_DUD_MIN,
        poolDudMax: POOL_DUD_MAX,
        wave: game.wave || 1,
        pressure: game.pressure,
        pressureBullets: game.pressureBullets || 0,
        charge: chargeFor(game, game.alive[game.turnIndex]),
        // 现在这个蓄力层数去加压，能逼下家连开几枪（1 或 2）。
        chargeForcedShots: forcedShotsForCharge(chargeFor(game, game.alive[game.turnIndex])),
        unknownCount,
        hitChance: unknownCount > 0 ? game.bullets / unknownCount : 0,
        stakeMinutes: currentStakeMinutes(game),
        aliveIds: turnOrderIds(game),
        eliminated: game.eliminated.map(entry => ({ ...entry })),
        cowards: game.cowards.map(entry => ({ ...entry })),
        shooterId,
        shooterName: panels.nameOf({ labels: game.labels || {} }, shooterId),
        // 名单里给戴罪的人挂上 🤡，否则「他这局跑不掉」这件事全场看不见。
        redeemerIds: [...(game.redeemers || [])],
        // 戴罪上桌的人没有逃生按钮：逃生机会他已经用掉一次了。
        // 反手序列中的强制开枪同样不能逃，由 performShot 按阶段驱动。
        canQuit: !game.riposte && !isRedeemer(game, shooterId),
        // 🔧 退弹开枪：fire 阶段、本局没用过、且不在反手序列里。
        // 弹数门槛已经取消 —— 任何时候都能抽，包括枪里只剩 1 发的时候。
        canUnload: !game.riposte
            && game.phase === 'fire'
            && !(game.unloadUsed || []).includes(shooterId),
        unloadUsed: [...(game.unloadUsed || [])],
        // 退弹后立刻重转弹巢再开枪，打到子弹的概率按「卸掉 1 发后的满巢」算。
        unloadChance: Math.max(0, game.bullets - 1) / CHAMBER_COUNT,
        // 加压逼出的强制开枪：这个回合总共要开几枪、还剩几枪（含当前这枪）。
        forcedShots: debtRemaining > 0
            ? {
                remaining: debtRemaining,
                total: debtTotal,
                index: debtTotal - debtRemaining + 1,
                sourceName: game.pressureDebt?.sourceId
                    ? panels.nameOf({ labels: game.labels || {} }, game.pressureDebt.sourceId)
                    : null,
            }
            : null,
        // 撑过第 1 枪后才退弹的话，这一枪直接抵消掉，连扳机都不用扣。
        unloadSkipsShot: debtRemaining === 1 && debtTotal > 1,
        // 反手序列上下文：fire 面板要用它标注「这是被反手逼出来的一枪」。
        riposte: game.riposte
            ? {
                ...game.riposte,
                initiatorName: panels.nameOf({ labels: game.labels || {} }, game.riposte.initiatorId),
                targetName: panels.nameOf({ labels: game.labels || {} }, game.riposte.targetId),
            }
            : null,
        shotNumber: game.shotNumber + 1,
        // 面板上如实显示「这次等多少秒」：挂过机的玩家会看到 30 / 15 秒。
        turnTimeoutMs: turnTimeoutMsFor(game, shooterId),
        // 当前持枪者挂满过几次（0/1/2）。面板据此补一句「等你只剩 X 秒」的小字。
        timeoutTier: Math.min(2, (game.timeoutTiers && game.timeoutTiers[shooterId]) || 0),
        labels: game.labels || {},
        testMode: Boolean(game.testConfig),
        autoPlay: isVirtualPlayer(shooterId),
    };
}

function buildChoiceView(game) {
    const view = buildView(game);
    const shooterId = game.alive[game.turnIndex];
    const loadBullets = loadBulletsFor(game, shooterId);
    view.passUnknownCount = view.unknownCount;
    view.passChance = view.unknownCount > 0 ? game.bullets / view.unknownCount : 0;
    // 弹巢塞满、或者待发池已经见底，都没法再加压。
    view.canLoad = game.bullets < CHAMBER_COUNT && (game.pool || []).length > 0;
    view.loadBullets = loadBullets;
    view.loadChance = (game.bullets + loadBullets) / CHAMBER_COUNT;
    view.loadStakeMinutes = currentStakeMinutes(game) + (loadBullets * MINUTES_PER_PRESSURE);
    // 再撑一枪之后加压能逼到几枪 ——「再开到第 3 层就能压两枪」这件事必须写在面板上，
    // 否则没人看得出档位（现在这层能压几枪由 chargeForcedShots 给）。
    view.againForcedShots = forcedShotsForCharge((view.charge || 0) + 1);
    view.shotNumber = game.shotNumber;
    // 🔙 反手还击：当前持枪者持有反手权，且加压者还活着、没有进行中的反手序列。
    view.canRiposte = !game.riposte
        && game.riposteHolderId === shooterId
        && Boolean(game.riposteTargetId)
        && game.alive.includes(game.riposteTargetId);
    view.riposteTargetId = game.riposteTargetId || null;
    view.riposteTargetName = game.riposteTargetId
        ? panels.nameOf({ labels: game.labels || {} }, game.riposteTargetId)
        : null;
    // 反手不开新枪也不重转：加压者面对的正是当前这个弹巢。
    view.riposteTargetChance = view.unknownCount > 0 ? game.bullets / view.unknownCount : 0;
    view.riposteKeepsGun = view.canRiposte
        && riposteKeepsGun(game, shooterId, game.riposteTargetId);
    return view;
}

// 这个定时器被 await 依赖，不能 unref：否则事件循环里没有别的 ref'd handle 时
// Node 会在暂停期间直接退出，后续结算全部丢失。
function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

function queuePanel(game, factory) {
    const previous = game.panelQueue || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => factory());
    game.panelQueue = operation.catch(() => {});
    return operation;
}

// 每次刷新都是「发新的」，保证面板永远停在频道最底部，不会被聊天顶上去；
// 但旧面板不立刻删，留一个滚动窗口，免得中弹那一瞬间还没看清就没了。
// 真正的清场放到游戏结束时做，只留最后一条结算消息。
function renderPanel(game, payload) {
    return queuePanel(game, async () => {
        if (!game.channel || typeof game.channel.send !== 'function') return null;

        const stale = game.panels.filter(entry => entry.interactive);
        let next = null;
        try {
            next = await game.channel.send(payload);
        } catch (error) {
            logDiscordFailure(game, 'send-panel', error);
            return null;
        }

        game.panels.push({
            message: next,
            interactive: (payload.components || []).length > 0,
        });

        // 把窗口里所有旧按钮摘掉，只留最新那条可以点。
        // turnToken 仍然是兜底，摘按钮只是免得玩家点了个寂寞。
        for (const entry of stale) {
            entry.interactive = false;
            if (typeof entry.message?.edit !== 'function') continue;
            try {
                await entry.message.edit({ components: [] });
            } catch (error) {
                // 摘按钮失败无所谓，turnToken 会挡住过期点击。
            }
        }

        // 测试调试模式（保留消息）不删旧面板，方便看整局回放。
        //
        // 超出历史窗口的旧面板立刻删掉，不走 invalidatePanel 的默认 5 秒延迟：
        // 这是个滚动窗口，延迟删除会让「频道里最多 3 条」的约束直接失效 ——
        // 玩家手快的时候一个回合能连发 4 张面板，5 秒内挤出去的那些还没消失，
        // 于是同时可见 6、7 条。别的游戏用 invalidatePanel 是删一次性面板，没这个问题。
        //
        // 也不需要先 edit 摘按钮：上面那个 stale 循环已经摘过了，
        // 删之前再 edit 一遍纯属多跑一次 API，还会把删除串成串行。
        while (game.panels.length > PANEL_HISTORY_LIMIT) {
            const entry = game.panels.shift();
            if (!game.keepMessages) {
                deleteMessageAfter(entry?.message, 0, { action: 'pressure-history-trim' });
            }
        }
        return next;
    });
}

// 结算后清场：只留最后一条结果消息。
function pruneToFinalPanel(game) {
    return queuePanel(game, async () => {
        // 测试调试模式保留整局消息，跳过清场。
        if (game.keepMessages) return;
        const keep = game.panels.at(-1);
        const doomed = game.panels.slice(0, -1);
        game.panels = keep ? [keep] : [];
        for (const entry of doomed) {
            await invalidatePanel(entry?.message, { context: { action: 'pressure-prune' } });
        }
    });
}

function clearTurnTimer(game) {
    if (!game.turnTimer) return;
    clearTimeout(game.turnTimer);
    game.timers.delete(game.turnTimer);
    game.turnTimer = null;
}

function armTurnTimer(game, expectedToken, handler, delayMs = turnDurationFor(game)) {
    clearTurnTimer(game);
    const timer = setTimeout(() => {
        if (game.turnTimer === timer) game.turnTimer = null;
        game.timers.delete(timer);
        Promise.resolve(handler())
            .catch(error => logDiscordFailure(game, 'turn-timer', error));
    }, delayMs);
    timer.unref?.();
    game.timers.add(timer);
    game.turnTimer = timer;
    game.turnTimerToken = expectedToken;
}

function clearRecruitmentTimer(game) {
    if (!game.recruitmentTimer) return;
    clearTimeout(game.recruitmentTimer);
    game.timers.delete(game.recruitmentTimer);
    game.recruitmentTimer = null;
}

function isActivelyTimedOut(member, now = Date.now()) {
    return Number(member?.communicationDisabledUntilTimestamp) > now;
}

function isValidHumanMember(member) {
    return Boolean(member?.id && member.user && !member.user.bot);
}

async function fetchMember(game, userId) {
    try {
        return await game.guild?.members?.fetch(userId) || null;
    } catch (error) {
        logDiscordFailure(game, 'fetch-member', error, userId);
        return null;
    }
}

// 40060 = 这个 interaction 已被应答，10062 = token 已失效。
// 两者都已经无法挽回（常见于同一个 token 跑了第二份实例，或响应超过 3 秒），
// 记一行就够了，打整条堆栈只会把真正的错误淹掉。
const UNRECOVERABLE_INTERACTION_CODES = new Set([40060, 10062]);

function logInteractionFailure(action, interaction, error) {
    const context = `user=${interaction?.user?.id || 'unknown'}`;
    if (UNRECOVERABLE_INTERACTION_CODES.has(error?.code)) {
        console.warn(`[MysteryPressure] ${action} 放弃（${context}）：${error.code} ${error.rawError?.message || error.message}`);
        return;
    }
    console.error(`[MysteryPressure] ${action} 失败（${context}）:`, error);
}

async function replyEphemeral(interaction, content) {
    try {
        if (interaction.deferred && !interaction.replied) {
            await interaction.editReply({ content });
        } else if (interaction.replied) {
            await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
        } else {
            await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }
        return true;
    } catch (error) {
        logInteractionFailure('私密回复', interaction, error);
        return false;
    }
}

async function acknowledge(interaction) {
    if (interaction.deferred || interaction.replied) return true;
    try {
        await interaction.deferUpdate();
        return true;
    } catch (error) {
        logInteractionFailure('deferUpdate', interaction, error);
        return false;
    }
}

async function cleanupPressureGame(game) {
    clearTurnTimer(game);
    clearRecruitmentTimer(game);
    // 这一局到此为止，快照不能留 —— 否则下次启动会把已经结算完的局又拉起来。
    forgetGame(game);
    await gameManager.cleanupGame(game);
}

// 整局的统计数据一直攒在 game.stats 里，到结算才一次性落库。
// 统计永远不该影响游戏本身：这里任何失败都只记一行日志，不往上抛。
function flushPressureStats(game, outcome, finalAliveIds) {
    const stats = game.stats;
    if (!stats) return;
    // 先摘掉引用，保证任何重入路径都不会把同一局写两次。
    game.stats = null;

    try {
        const rows = finalizePressureStats(stats, { outcome, aliveIds: finalAliveIds });
        recordPressureGame(game.guildId, rows);
    } catch (error) {
        logDiscordFailure(game, 'record-stats', error);
    }
}

async function settleGame(game, outcome) {
    let claimed = false;
    // 存活名单必须在临界区里就地快照：下面还有 await，
    // 期间成员退服会触发 handleMemberInvalidated 继续 splice game.alive。
    let finalAliveIds = [];
    await gameManager.runExclusive(game, () => {
        if (game.settled || game.state === 'ended') return;
        game.settled = true;
        game.state = 'ended';
        finalAliveIds = [...game.alive];
        claimed = true;
    });
    if (!claimed) return;

    clearTurnTimer(game);
    clearRecruitmentTimer(game);

    const view = buildView(game);
    let payload;
    if (outcome === 'champion') {
        payload = panels.championPanel({ ...view, winnerId: game.alive[0] });
    } else if (outcome === 'draw') {
        payload = panels.drawPanel(view);
    } else if (outcome === 'cancelled') {
        payload = panels.cancellationPanel(view, minParticipantsFor(game));
    } else {
        payload = panels.abortPanel(view, '已经没有足够的人能继续这场游戏了。');
    }

    await renderPanel(game, payload);
    // 游戏正式结束，清掉过程消息，频道里只留这条结算。
    await pruneToFinalPanel(game);
    await settleCowardPenalties(game.guildId, game.cowards);
    // 落库排在摘牌前面：摘牌要等 Discord 改昵称，慢的时候不该拖着这一局的数据。
    flushPressureStats(game, outcome, finalAliveIds);
    // 戴罪上桌的人只要把这局打完就摘牌，中弹倒下的也算。
    // 两个名单不会相交：戴罪的人没有逃生按钮，当不了这局的新胆小鬼。
    await redeemCowardPenalties(game.guildId, game.redeemers);
    await cleanupPressureGame(game);
}

function evaluateOutcome(game) {
    if (game.alive.length === 0) return 'aborted';
    if (game.alive.length === 1) return 'champion';
    // 子弹打光不再直接判平局：先自动补弹，等待发池也空了才由所有人投票决定收不收场。
    return null;
}

async function continueOrSettle(game) {
    let outcome = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') return;
        outcome = evaluateOutcome(game);
    });

    if (outcome) {
        await settleGame(game, outcome);
        return;
    }

    // 枪空了先补弹 / 进和局判定，补完才轮到下一个人。
    if (game.bullets === 0 && await resolveEmptyGun(game, 'fire') !== 'continue') return;

    let advance = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') return;
        game.phase = 'fire';
        game.turnToken += 1;
        advance = true;
    });
    if (advance) await startTurn(game);
}

async function startTurn(game) {
    if (game.ended || game.state !== 'playing') return;
    const view = buildView(game);
    await renderPanel(game, panels.firePanel(view));

    // 检查点：停在「轮到某人开枪」，重启后能原样接上。
    persistGame(game);

    // 虚拟玩家没有按钮可点，短暂"思考"后自动行动。
    if (view.autoPlay) {
        if (view.canUnload && randomFor(game) < 0.3) {
            // 枪里高压时，测试机器人也会用退弹保命，否则这个分支测试局覆盖不到。
            armTurnTimer(game, view.turnToken, () => handleUnload(game, view.turnToken), VIRTUAL_THINK_MS);
            return;
        }
        armTurnTimer(game, view.turnToken, () => performShot(game, view.turnToken), VIRTUAL_THINK_MS);
        return;
    }

    // 真人：等多久看他的挂机档位（60 / 30 / 15 秒），挂满就系统替他开枪。
    armTurnTimer(
        game,
        view.turnToken,
        () => performShot(game, view.turnToken, { timedOut: true }),
        turnTimeoutMsFor(game, view.shooterId)
    );
}

async function renderChoice(game) {
    if (game.ended || game.state !== 'playing') return;
    const view = buildChoiceView(game);
    await renderPanel(game, panels.choicePanel(view));

    // 检查点：停在「活下来了，接下来怎么办」。
    persistGame(game);

    if (view.autoPlay) {
        armTurnTimer(
            game,
            view.turnToken,
            () => {
                const action = pickVirtualAction(game, view);
                if (action === 'riposte') return handleRiposte(game, view.turnToken);
                return handleChoice(game, action, view.turnToken);
            },
            VIRTUAL_THINK_MS
        );
        return;
    }
    // 真人：等多久看他的挂机档位（60 / 30 / 15 秒），挂满就系统替他默认传枪。
    armTurnTimer(
        game,
        view.turnToken,
        () => handleChoice(game, 'pass', view.turnToken, { timedOut: true }),
        turnTimeoutMsFor(game, view.shooterId)
    );
}

async function resolveHit(game, victimId) {
    const stakeMinutes = currentStakeMinutes(game);
    // 戴罪上桌的人中弹时，把他没挂完的 🤡 折成禁言一起还上。
    // 必须在结算摘牌之前读，此刻记录还在。折进去的部分照样计入「牢底坐穿」——
    // 他确实被禁言了那么久。
    const foldedMinutes = redeemerRemainingMinutes(game, victimId);
    const minutes = stakeMinutes + foldedMinutes;
    const virtual = isVirtualPlayer(victimId);
    const member = virtual ? null : await fetchMember(game, victimId);

    // 必须先解除玩家锁再禁言：否则我们自己打出的这次 timeout 会触发
    // mysteryGameManager 的成员失效回调，把整局还在进行的游戏直接判死。
    await gameManager.runExclusive(game, () => {
        const index = game.alive.indexOf(victimId);
        if (index !== -1) game.alive.splice(index, 1);
        if (game.turnIndex >= game.alive.length) game.turnIndex = 0;
        gameManager.removePlayer(game, victimId);
        game.eliminated.push({ userId: victimId, minutes, timeoutFailed: false, virtual });
        recordElimination(game.stats, victimId, minutes);
        // 出局会连带作废他身上的反手权和强制开枪债，统一在这里收尾。
        releaseOnExit(game, victimId);
    });

    let timeoutFailed = !virtual;
    if (member) {
        try {
            await member.timeout(minutes * 60 * 1000, TIMEOUT_REASON);
            timeoutFailed = false;
        } catch (error) {
            logDiscordFailure(game, 'apply-timeout', error, victimId);
        }
    }

    const entry = game.eliminated.find(record => record.userId === victimId);
    if (entry) entry.timeoutFailed = timeoutFailed;

    const view = buildView(game);
    await renderPanel(game, panels.hitAnnouncement({
        ...view,
        victimId,
        victimName: nameFor(game, victimId),
        victimMinutes: minutes,
        victimStakeMinutes: stakeMinutes,
        victimFoldedMinutes: foldedMinutes,
        timeoutFailed,
        victimVirtual: virtual,
    }));

    await sleep(HIT_PAUSE_MS);
    if (game.ended) return;
    await continueOrSettle(game);
}

async function performShot(game, expectedToken, options = {}) {
    const { timedOut = false } = options;
    let result = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') return;
        if (game.phase !== 'fire' || game.turnToken !== expectedToken) return;

        const shooterId = game.alive[game.turnIndex];
        if (!shooterId) return;

        // 系统等到点替他扣扳机 → 挂满次数 +1（虚拟机器人由 bump 内部过滤）。
        if (timedOut) bumpTimeoutTier(game, shooterId);

        const index = game.pointer;
        const round = game.chambers[index];
        const hit = round === LIVE;
        const dud = round === DUD;
        // 统计要的是「扣扳机那一刻」的局面，所以必须在验巢、扣子弹之前取。
        // bulletsBefore 是公开弹数（含哑弹），liveBefore 是只有系统知道的实弹数——
        // 运气值要用后者算，勇气类数据（max_bullets_faced）要用前者，别混。
        const bulletsBefore = game.bullets;
        const liveBefore = Math.max(0, bulletsBefore - (game.gunDuds || 0));
        const unknownBefore = unknownChamberCount(game);
        game.revealed[index] = true;
        // 哑弹和实弹一样被消耗掉：弹巢清空、弹数 -1。唯一的区别是不淘汰人。
        if (hit || dud) {
            game.chambers[index] = null;
            game.bullets = Math.max(0, game.bullets - 1);
            if (dud) {
                game.gunDuds = Math.max(0, game.gunDuds - 1);
                game.dudChambers[index] = true;
            } else {
                game.hitChambers[index] = true;
                // 人没了，攒下的蓄力跟着一起没。
                setCharge(game, shooterId, 0);
            }
        }
        game.pointer = (index + 1) % CHAMBER_COUNT;
        game.shotNumber += 1;
        game.turnToken += 1;

        // 退弹枪：一次性标记，开枪后立刻消费掉，避免残留影响下一轮。
        const unloadShot = game.unloadShotOwner === shooterId;
        if (unloadShot) game.unloadShotOwner = null;

        // 反手序列的驱动：加压者被迫开的那一枪落到这里，开完序列即止。
        const riposteStage = game.riposte?.stage || null;
        let riposteKeptGun = false;
        // 加压逼出来的强制开枪：这一枪扣掉一笔债，还欠着就继续留在 fire 阶段接着开，
        // 债清完（或者中弹）才轮得到他选怎么处理这把枪。
        // 反手序列里加压者那一枪不碰这套账 —— 债记在发起人身上，跟他无关。
        let debtLeft = 0;
        if (riposteStage === 'target') {
            const initiatorId = game.riposte.initiatorId;
            if (hit) {
                // 加压者被这一枪送走 = 反手成功。
                recordRiposteKill(game.stats, initiatorId);
            }
            // 加压者这一枪结束，反手到此为止：不再让发起人补枪，
            // 直接顺延到发起人后面的玩家（发起人已经开过自己那枪了）。
            game.riposte = null;
            const initiatorIndex = game.alive.indexOf(initiatorId);
            if (initiatorIndex === -1) {
                // 发起人已不在场（理论上只可能由并发移除造成），序列作废。
                game.phase = hit ? 'resolving' : 'choice';
            } else {
                const targetIndex = game.alive.indexOf(shooterId);
                // 空枪：alive 不变，下一个持枪者 = 发起人后面的人。
                // 中弹：加压者即将被 resolveHit splice 掉，若加压者排在目标之前，
                //       目标索引会因前移而 -1。
                let nextIndex = (initiatorIndex + 1) % game.alive.length;
                if (hit && targetIndex !== -1 && targetIndex < nextIndex) {
                    nextIndex -= 1;
                }
                game.turnIndex = nextIndex;
                // 跳过发起人绕一圈，下一个接枪的正好又是刚开完这枪的加压者自己
                // （2 人残局，或反手权顺延到队尾之后）。这时不能再逼他连开第二枪 ——
                // 那一枪就算作他这个回合的枪，直接让他选传枪 / 再来一枪 / 加压。
                riposteKeptGun = !hit && game.alive[nextIndex] === shooterId;
                game.phase = hit ? 'resolving' : (riposteKeptGun ? 'choice' : 'fire');
            }
        } else {
            debtLeft = consumePressureDebt(game, shooterId);
            if (hit) {
                // 人没了，欠的枪跟着一笔勾销，下家不用替他补。
                clearPressureDebt(game, shooterId);
                debtLeft = 0;
            }
            game.phase = hit ? 'resolving' : (debtLeft > 0 ? 'fire' : 'choice');
        }

        recordShot(game.stats, shooterId, { hit, dud, bulletsBefore, liveBefore, unknownBefore });
        result = { shooterId, hit, dud, unloadShot, riposteStage, riposteKeptGun, debtLeft };
    });

    if (!result) return;
    clearTurnTimer(game);

    if (result.hit) {
        await resolveHit(game, result.shooterId);
        return;
    }

    // 先播报刚才那一枪的结果，再决定下一步，让全场都看清发生了什么。
    // 哑弹必须当众说出来：否则弹数凭空少一发，全场只会以为有人中弹了。
    const shotView = {
        ...buildView(game),
        shooterId: result.shooterId,
        shooterName: nameFor(game, result.shooterId),
    };
    await renderPanel(game, result.dud
        ? panels.dudAnnouncement(shotView)
        : panels.missAnnouncement(shotView));

    // 这一枪把哑弹也算进去地打空了枪 —— 先补弹或进和局判定，再谈接下来怎么走。
    const resumeMode = result.riposteStage === 'target'
        ? (result.riposteKeptGun ? 'choice' : 'fire')
        // 还欠着强制开枪的话，投票结束后要接着让同一个人开下一枪，而不是让他选。
        : (result.debtLeft > 0 ? 'fire' : (result.unloadShot ? 'forcedPass' : 'choice'));
    if (game.bullets === 0 && await resolveEmptyGun(game, resumeMode) !== 'continue') return;

    if (result.riposteStage === 'target') {
        // 加压者没倒下：反手序列已结束。
        // 轮次顺延回他自己时，这一枪就是他的回合枪，接着让他选怎么处理；
        // 否则直接进下一个人（发起人后面的人）的回合。
        if (result.riposteKeptGun) await renderChoice(game);
        else await startTurn(game);
        return;
    }
    if (result.debtLeft > 0) {
        // 加压欠的枪还没还完：枪不离手，同一个人接着开下一枪。
        await startTurn(game);
        return;
    }
    if (result.unloadShot) {
        // 退弹活下来后强制传枪：不能连开、不能加压、不能反手。
        // 走 handleChoice('pass')，顺带触发「活着传枪 → 反手权作废」的规则。
        await handleChoice(game, 'pass', game.turnToken);
        return;
    }
    await renderChoice(game);
}

// ---------- 弹药耗尽：自动补弹 / 和局判定 ----------

// 枪打空时的分岔。返回 'continue' 表示调用方照常往下走，
// 'halted' 表示后续流程已经被接管（进了投票，或者这一局已经结束）。
//
// resumeMode 记的是「投票通过继续打之后，本来该发生什么」：
//   choice     — 开枪的人活下来了，该轮到他选传枪 / 再来一枪 / 加压
//   forcedPass — 退弹活下来后的强制传枪
//   fire       — 直接进下一枪（反手序列加压者那枪之后，或上一枪淘汰了人之后轮到下一个人）
async function resolveEmptyGun(game, resumeMode = 'fire') {
    let mode = 'halted';
    let outcome = null;
    let reloadInfo = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') return;
        if (game.bullets > 0) {
            mode = 'continue';
            return;
        }
        // 只剩一个人 / 没人了，轮不到补弹，直接收场。
        // 正常流程里 continueOrSettle 已经先结算过了，这里是兜底：
        // 少了这一手，调用方会静默停住，整局挂在半路。
        if (game.alive.length <= 1) {
            outcome = evaluateOutcome(game);
            return;
        }

        if (game.pool.length > 0) {
            // 自动补弹：优先补进剩余未验格（保留弹巢历史），
            // 弹巢被打穿一整轮（没有可补的未知格）时才整巢重转。
            reloadInfo = reloadIntoUnknownChambers(game, AUTO_RELOAD_BULLETS);
            mode = 'reload';
            return;
        }

        // 池子也空了：停下来问所有还活着的人愿不愿意就此收场。
        game.phase = 'vote';
        game.votes = new Map();
        game.resumeAfterVote = resumeMode;
        game.turnToken += 1;
        mode = 'vote';
    });

    if (outcome) {
        await settleGame(game, outcome);
        return 'halted';
    }
    if (mode === 'reload') {
        const view = buildView(game);
        view.reloadMode = reloadInfo?.mode || 'spin';
        view.reloadCount = reloadInfo?.filled || 0;
        view.reloadUnknownBefore = reloadInfo?.unknownBefore || 0;
        await renderPanel(game, panels.reloadAnnouncement(view));
        return 'continue';
    }
    if (mode === 'vote') {
        await startDrawVote(game);
        return 'halted';
    }
    return mode === 'continue' ? 'continue' : 'halted';
}

// 一人反对就立刻掀桌，不等剩下的人；全员同意才收场。没投够就返回 null。
function tallyVotes(game) {
    const votes = game.votes || new Map();
    for (const userId of game.alive) {
        if (votes.get(userId) === 'object') return { outcome: 'object', objectorId: userId };
    }
    if (game.alive.every(userId => votes.get(userId) === 'agree')) return { outcome: 'agreed' };
    return null;
}

function buildVoteView(game) {
    const view = buildView(game);
    const votes = game.votes || new Map();
    view.votedIds = game.alive.filter(userId => votes.has(userId));
    view.pendingIds = game.alive.filter(userId => !votes.has(userId));
    view.voteSeconds = Math.round(DRAW_VOTE_DURATION_MS / 1000);
    return view;
}

async function startDrawVote(game) {
    // 虚拟玩家没有按钮可点，开票时就替它们投掉。
    // 整场只掷一次「有没有机器人掀桌」，而不是每个机器人各掷一次：
    // 后者在 5 机器人的测试局里几乎必然有人反对，一轮接一轮永远打不完。
    let settled = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.phase !== 'vote') return;
        const bots = game.alive.filter(
            userId => isVirtualPlayer(userId) && !game.votes.has(userId)
        );
        const objector = bots.length > 0 && randomFor(game) < VIRTUAL_OBJECT_CHANCE
            ? bots[Math.floor(randomFor(game) * bots.length)]
            : null;
        for (const userId of bots) {
            game.votes.set(userId, userId === objector ? 'object' : 'agree');
        }
        settled = tallyVotes(game);
    });

    if (settled) {
        await concludeDrawVote(game, settled);
        return;
    }

    const view = buildVoteView(game);
    await renderPanel(game, panels.drawVotePanel(view));

    // 检查点：停在和局判定。恢复时会清空已投的票，让大家重新投一轮。
    persistGame(game);

    armTurnTimer(
        game,
        view.turnToken,
        () => finishDrawVoteByTimeout(game, view.turnToken),
        DRAW_VOTE_DURATION_MS
    );
}

// 每一票只给投票的人一条私密回执，不重新渲染面板 —— 否则 5 个人投票就要刷 5 条。
async function handleVote(game, interaction, choice, expectedToken) {
    const userId = interaction.user?.id;
    let rejection = null;
    let settled = null;

    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') {
            rejection = EXPIRED_MESSAGE;
            return;
        }
        if (game.phase !== 'vote' || game.turnToken !== expectedToken) {
            rejection = STALE_ACTION_MESSAGE;
            return;
        }
        if (!game.alive.includes(userId)) {
            rejection = VOTE_OUTSIDER_MESSAGE;
            return;
        }
        if (game.votes.has(userId)) {
            rejection = VOTE_DUPLICATE_MESSAGE;
            return;
        }
        game.votes.set(userId, choice);
        settled = tallyVotes(game);
    });

    if (rejection) {
        await replyEphemeral(interaction, rejection);
        return;
    }
    await replyEphemeral(interaction, choice === 'object' ? VOTE_OBJECT_ACK : VOTE_AGREE_ACK);
    if (settled) await concludeDrawVote(game, settled);
}

// 35 秒到点：没点的人一律算同意。
async function finishDrawVoteByTimeout(game, expectedToken) {
    let settled = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') return;
        if (game.phase !== 'vote' || game.turnToken !== expectedToken) return;
        for (const userId of game.alive) {
            if (!game.votes.has(userId)) game.votes.set(userId, 'agree');
        }
        settled = tallyVotes(game);
    });
    if (settled) await concludeDrawVote(game, settled);
}

async function concludeDrawVote(game, settled) {
    clearTurnTimer(game);

    // 投票期间可能有人退服 / 被管理员禁言而出局，胜负也许已经分出来了。
    // 少了这一步，两人局里对手中途掉线会把本该到手的冠军判成平局。
    let outcome = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') return;
        outcome = evaluateOutcome(game);
    });
    if (outcome) {
        await settleGame(game, outcome);
        return;
    }

    if (settled.outcome === 'agreed') {
        await settleGame(game, 'draw');
        return;
    }

    // 有人不同意收场：重新备一池 12 发（依旧 3~6 发哑弹），补 1 发进枪，接着打。
    let ready = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing' || game.phase !== 'vote') return;
        game.votes = null;
        // 先挪出 vote 阶段，免得投票按钮在重开的这一瞬间还能点。
        game.phase = 'resolving';
        preparePool(game);
        drawIntoGun(game, AUTO_RELOAD_BULLETS);
        spinCylinder(game);
        game.turnToken += 1;
        ready = true;
    });
    if (!ready) return;

    await renderPanel(game, panels.newWaveAnnouncement({
        ...buildView(game),
        objectorName: nameFor(game, settled.objectorId),
    }));
    await resumeAfterVote(game);
}

// 投票之前被打断的那一步，现在接着走完。
async function resumeAfterVote(game) {
    let mode = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') return;
        mode = game.resumeAfterVote || 'fire';
        game.resumeAfterVote = null;
        game.phase = mode === 'fire' ? 'fire' : 'choice';
        game.turnToken += 1;
    });

    if (!mode) return;
    if (mode === 'choice') {
        await renderChoice(game);
        return;
    }
    if (mode === 'forcedPass') {
        await handleChoice(game, 'pass', game.turnToken);
        return;
    }
    await startTurn(game);
}

async function handleChoice(game, action, expectedToken, options = {}) {
    const { timedOut = false } = options;
    let accepted = false;
    let actorId = null;
    let resolvedAction = action;
    let loadedBullets = 0;
    let clearedCharge = 0;
    let forcedShots = 1;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') return;
        if (game.phase !== 'choice' || game.turnToken !== expectedToken) return;
        if (game.alive.length === 0) return;

        actorId = game.alive[game.turnIndex];
        // 系统等到点替他默认传枪 → 挂满次数 +1（虚拟机器人由 bump 内部过滤）。
        if (timedOut) bumpTimeoutTier(game, actorId);
        let effectiveAction = action;
        // 弹巢塞满、或者待发池已经见底，加压就退化成传枪。
        if (effectiveAction === 'load' && loadBulletsFor(game, actorId) <= 0) {
            effectiveAction = 'pass';
        }
        resolvedAction = effectiveAction;

        const charge = chargeFor(game, actorId);
        if (effectiveAction === 'load') {
            // 子弹从待发池里抽，抽到什么算什么 —— 加压的人自己也不知道
            // 塞进去的是实弹还是哑弹。
            const drawn = drawIntoGun(game, loadBulletsFor(game, actorId));
            loadedBullets = drawn.total;
            game.pressure += 1;
            game.pressureBullets = (game.pressureBullets || 0) + loadedBullets;
            spinCylinder(game);
        }

        // 蓄力只在连开时累积，枪一离手（传枪 / 加压）立刻作废。
        if (effectiveAction === 'again') {
            setCharge(game, actorId, charge + 1);
        } else {
            clearedCharge = charge;
            setCharge(game, actorId, 0);
        }

        recordChoice(game.stats, actorId, {
            action: effectiveAction,
            loadedBullets,
            // 记的是这次选择之后达到的层数，「连开狂魔」看的就是这个峰值。
            chargeAfter: effectiveAction === 'again' ? charge + 1 : charge,
        });

        if (effectiveAction !== 'again') {
            game.turnIndex = (game.turnIndex + 1) % game.alive.length;
        }

        // 反手权归属随选择联动：
        // - 加压 → 加压者成为新目标，反手权转授给下一个接枪的人。
        // - 传枪 → 活着把枪传出去（含退弹后的强制传枪），反手权当场作废。
        // - 再来一枪 → 枪没离手，反手权保留，什么都不用动。
        if (effectiveAction === 'load') {
            game.riposteTargetId = actorId;
            game.riposteHolderId = game.alive[game.turnIndex];
            // 强制开枪债一并挂到下家头上：连开攒到 3 层再加压，他这个回合要连开两枪。
            forcedShots = forcedShotsForCharge(charge);
            setPressureDebt(game, game.alive[game.turnIndex], forcedShots, actorId);
        } else if (effectiveAction === 'pass' && game.riposteHolderId === actorId) {
            game.riposteHolderId = null;
            game.riposteTargetId = null;
        }

        game.phase = 'fire';
        game.turnToken += 1;
        accepted = true;
    });

    if (!accepted) return;
    clearTurnTimer(game);

    // 播报他选了什么、局面变成了什么样，否则其他人只会看到轮次莫名其妙地跳走。
    const view = buildView(game);
    await renderPanel(game, panels.actionAnnouncement({
        ...view,
        action: resolvedAction,
        actorName: nameFor(game, actorId),
        nextShooterName: view.shooterName,
        loadedBullets,
        clearedCharge,
        forcedShots,
    }));

    await startTurn(game);
}

// ---------- 反制机制：🔧 退弹开枪 / 🔙 反手还击 ----------

// 出局 / 退出 / 退服时，统一收尾这个人身上挂着的两样东西：反手权和强制开枪债。
// - 进行中的反手序列：发起人消失，或加压者在被迫开枪前消失 → 序列作废。
//   加压者在 target 阶段中弹的情况由 performShot 先把序列清空再 resolveHit，
//   所以这里不会误伤那条本要顺延给发起人后面玩家的序列。
// - 待命的反手权：持有者或加压者任意一方消失 → 整体作废，**不再顺延**给别人。
//   反手是「谁被压谁还手」，被压的人自己都不在了，这笔账没有理由转给下一个人。
// - 强制开枪债：欠债的人一走，债跟着一笔勾销，他的下家不用替他补枪。
function releaseOnExit(game, userId) {
    if (!game || !userId) return;

    const rip = game.riposte;
    if (rip) {
        if (rip.initiatorId === userId) {
            game.riposte = null;
        } else if (rip.targetId === userId && rip.stage === 'target') {
            game.riposte = null;
        }
    }

    if (game.riposteHolderId === userId || game.riposteTargetId === userId) {
        game.riposteHolderId = null;
        game.riposteTargetId = null;
    }

    clearPressureDebt(game, userId);
}

// 🔧 退弹开枪：fire 阶段的纯防守动作。
// 卸掉 1 发子弹 → 重转弹巢 → 立刻扣扳机。赌注一分不降。
// 活下来就强制传枪（走 handleChoice('pass')），这轮不能再开 / 加压 / 反手。
//
// 被加压逼着连开两枪时，退弹额外抵掉一枪，抵在哪一枪由玩家自己挑：
//   · 第 1 枪就退（debtBefore ≥ 2）：退一发 + 重转 + 照常扣扳机，第 2 枪一笔勾销。
//     等于把两枪压缩成一枪，代价是这一枪还是得开。
//   · 撑过第 1 枪再退（debtBefore === 1）：退一发 + 重转，这一枪直接跳过，扳机都不用扣。
//     代价是第 1 枪得硬扛。
// 两种都还是「退弹后强制传枪」，拿不到加压和反手。
async function handleUnload(game, expectedToken) {
    let accepted = false;
    let actorId = null;
    let unloadedBullets = 0;
    let skipShot = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') return;
        if (game.phase !== 'fire' || game.turnToken !== expectedToken) return;
        if (game.alive.length === 0) return;

        const shooterId = game.alive[game.turnIndex];
        if (!shooterId) return;
        // 反手序列中的强制开枪不能退弹（设计：加压者与发起人的那两枪都不给选项）。
        if (game.riposte) return;
        if ((game.unloadUsed || []).includes(shooterId)) return;

        actorId = shooterId;
        // 抵哪一枪：还欠 1 枪 = 已经硬扛过第 1 枪，这次跳过不开；
        // 还欠 2 枪 = 抵掉后面那一枪，这一枪照开。没欠债就是普通退弹。
        skipShot = debtFor(game, shooterId) === 1;
        clearPressureDebt(game, shooterId);
        // 从枪里随便抓一发出来扔掉，抓到什么是什么，谁也不知道扔掉的是实弹还是哑弹。
        // 抽出来的弹直接销毁，不回待发池。
        if (game.bullets > 0) {
            const removedDud = randomFor(game) < ((game.gunDuds || 0) / game.bullets);
            unloadedBullets = 1;
            game.bullets -= 1;
            if (removedDud) game.gunDuds = Math.max(0, game.gunDuds - 1);
        }
        spinCylinder(game);
        game.unloadUsed = [...(game.unloadUsed || []), actorId];
        // 蓄力清零：枪马上要离手。
        setCharge(game, actorId, 0);
        if (skipShot) {
            // 这一枪被抵消掉了，不扣扳机，直接跳到「开枪后」的强制传枪。
            game.phase = 'choice';
        } else {
            // 标记这一枪是退弹枪：performShot 里消费掉，空枪存活 → 强制传枪。
            game.unloadShotOwner = actorId;
            game.phase = 'fire';
        }
        game.turnToken += 1;
        recordUnload(game.stats, actorId);
        accepted = true;
    });

    if (!accepted) return;
    clearTurnTimer(game);

    const view = buildView(game);
    await renderPanel(game, panels.unloadAnnouncement({
        ...view,
        actorName: nameFor(game, actorId),
        unloadedBullets,
        skippedShot: skipShot,
    }));

    if (!skipShot) {
        await performShot(game, game.turnToken);
        return;
    }

    // 跳过开枪的这条路没有 performShot 兜底，扔掉的要是最后一发，
    // 得自己先把「枪空了」处理掉（补弹 / 和局判定），再走强制传枪。
    if (game.bullets === 0 && await resolveEmptyGun(game, 'forcedPass') !== 'continue') return;
    await handleChoice(game, 'pass', game.turnToken);
}

// 🔙 反手还击：choice 阶段的复仇 / 威慑。
// 把枪扔回给加压者，他必须开 1 枪；这一枪结束反手就到此为止，
// 发起人不用补枪，直接顺延到发起人后面的玩家。
async function handleRiposte(game, expectedToken) {
    let accepted = false;
    let actorId = null;
    let targetId = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') return;
        if (game.phase !== 'choice' || game.turnToken !== expectedToken) return;
        if (game.alive.length === 0) return;

        const shooterId = game.alive[game.turnIndex];
        if (!shooterId) return;
        // 反手权已经被用过 / 有序列在跑时，按钮不会渲染，这里是兜底。
        if (game.riposte) return;
        if (game.riposteHolderId !== shooterId) return;
        if (!game.riposteTargetId || !game.alive.includes(game.riposteTargetId)) return;

        actorId = shooterId;
        targetId = game.riposteTargetId;

        game.riposte = { initiatorId: actorId, targetId, stage: 'target' };
        // 反手权当场消费：用过之后不再顺延（无论后续死活）。
        game.riposteHolderId = null;
        game.riposteTargetId = null;
        // 蓄力清零：枪离手了（现有规则）。
        setCharge(game, actorId, 0);
        // 枪交给加压者，他必须开这一枪。
        game.turnIndex = game.alive.indexOf(targetId);
        game.phase = 'fire';
        game.turnToken += 1;
        recordRiposte(game.stats, actorId, targetId);
        accepted = true;
    });

    if (!accepted) return;
    clearTurnTimer(game);

    const view = buildView(game);
    await renderPanel(game, panels.riposteAnnouncement({
        ...view,
        actorName: nameFor(game, actorId),
        targetName: nameFor(game, targetId),
        // alive 在上面那个临界区里没动过，所以这里算出来的去向和开枪后一致。
        keepsGun: riposteKeepsGun(game, actorId, targetId),
    }));

    await startTurn(game);
}

async function handleQuit(game, userId, expectedToken) {
    let accepted = false;
    let penaltyMinutes = 0;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') return;
        if (game.phase !== 'fire' || game.turnToken !== expectedToken) return;
        if (game.alive[game.turnIndex] !== userId) return;
        // 戴罪上桌的人没有退路。按钮压根不会渲染给他，这里是兜底。
        if (isRedeemer(game, userId)) return;
        // 反手序列中的强制开枪不能逃，按钮不会渲染，这里是兜底。
        if (game.riposte) return;

        const index = game.alive.indexOf(userId);
        if (index !== -1) game.alive.splice(index, 1);
        if (game.turnIndex >= game.alive.length) game.turnIndex = 0;
        gameManager.removePlayer(game, userId);
        // 赌注按他退出这一刻算：后面别人再怎么加压都不连坐。
        const stakeMinutes = currentStakeMinutes(game);
        penaltyMinutes = cowardPenaltyMinutes(stakeMinutes);
        game.cowards.push({ userId, stakeMinutes, penaltyMinutes });
        recordQuit(game.stats, userId, penaltyMinutes);
        game.turnToken += 1;
        releaseOnExit(game, userId);
        accepted = true;
    });

    if (!accepted) return;
    clearTurnTimer(game);

    const member = await fetchMember(game, userId);
    let penalty = { applied: false, taunt: `🤡 <@${userId}> 退出了这局。` };
    if (member) {
        try {
            penalty = await applyCowardPenalty({ member, channel: game.channel });
        } catch (error) {
            logDiscordFailure(game, 'apply-coward-penalty', error, userId);
        }
    }

    await renderPanel(game, panels.cowardAnnouncement({
        ...buildView(game),
        taunt: penalty.taunt,
        nicknameApplied: penalty.applied === true,
        penaltyMinutes,
    }));

    await continueOrSettle(game);
}

async function handleMemberInvalidated(game, userId) {
    let wasCurrent = false;
    let removed = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended) return;
        const index = game.alive.indexOf(userId);
        if (index === -1) {
            gameManager.removePlayer(game, userId);
            return;
        }
        wasCurrent = index === game.turnIndex;
        game.alive.splice(index, 1);
        if (game.turnIndex >= game.alive.length) game.turnIndex = 0;
        gameManager.removePlayer(game, userId);
        // 退服 / 被管理员禁言不算把这局打完，摘牌资格取消，🤡 计时器照原样走完。
        dropRedeemer(game, userId);
        removed = true;
        if (wasCurrent) game.turnToken += 1;
        releaseOnExit(game, userId);
    });

    if (!removed) return;
    if (game.state === 'recruiting') return;

    // 和局判定进行中：少一个人只是少一张票，不能去推轮次。
    // 走的人可能正好是最后一个没投的，所以要重新点一次票。
    if (game.phase === 'vote') {
        let settled = null;
        await gameManager.runExclusive(game, () => {
            if (game.ended || game.phase !== 'vote') return;
            game.votes?.delete(userId);
            settled = tallyVotes(game);
        });
        if (settled) await concludeDrawVote(game, settled);
        return;
    }

    if (wasCurrent) {
        clearTurnTimer(game);
        await continueOrSettle(game);
        return;
    }

    const outcome = evaluateOutcome(game);
    if (outcome) await settleGame(game, outcome);
}

function recruitmentView(game) {
    return {
        gameId: game.id,
        initiatorId: game.initiatorId,
        labels: game.labels || {},
        testMode: Boolean(game.testConfig),
        botCount: game.testConfig?.botCount || 0,
        participantCount: game.participantIds.length,
        maxParticipants: MAX_PARTICIPANTS,
        minParticipants: minParticipantsFor(game),
        baseMinutes: BASE_TIMEOUT_MINUTES,
        minutesPerPressure: MINUTES_PER_PRESSURE,
        // 规则清单里要写「一盒几发、其中几发哑弹」，招募阶段还没建池，
        // 所以这几个数直接取常量。
        poolSize: POOL_SIZE,
        poolDudMin: POOL_DUD_MIN,
        poolDudMax: POOL_DUD_MAX,
        startsAtSeconds: Math.floor(game.recruitmentEndsAt / 1000),
    };
}

// 常驻招募消息：第一次发一条，之后有人报名时原地 edit 更新人数，
// 不再像游戏面板那样每次都另发一条新的。
async function renderRecruitment(game) {
    return queuePanel(game, async () => {
        if (!game.channel || typeof game.channel.send !== 'function') return null;

        const payload = panels.recruitmentPanel(recruitmentView(game));
        const existing = game.recruitmentEntry;

        if (existing && typeof existing.message?.edit === 'function') {
            try {
                await existing.message.edit(payload);
                return existing.message;
            } catch (error) {
                // 原消息可能被手动删了或已失效，回收这条记录，落到下面重发一条。
                logDiscordFailure(game, 'edit-recruitment', error);
                const index = game.panels.indexOf(existing);
                if (index !== -1) game.panels.splice(index, 1);
            }
        }

        let next = null;
        try {
            next = await game.channel.send(payload);
        } catch (error) {
            logDiscordFailure(game, 'send-recruitment', error);
            return null;
        }

        const entry = {
            message: next,
            interactive: (payload.components || []).length > 0,
        };
        game.panels.push(entry);
        game.recruitmentEntry = entry;
        return next;
    });
}

// 真正开局时，招募卡片已经没用，从频道里删掉，别让它混在游戏面板中间。
function deleteRecruitmentPanel(game) {
    return queuePanel(game, async () => {
        // 测试调试模式保留招募消息，一并保留。
        if (game.keepMessages) return;
        const entry = game.recruitmentEntry;
        if (!entry) return;
        game.recruitmentEntry = null;
        const index = game.panels.indexOf(entry);
        if (index !== -1) game.panels.splice(index, 1);
        await invalidatePanel(entry?.message, { context: { action: 'pressure-recruitment' } });
    });
}

async function beginGame(game) {
    const participantIds = [...game.participantIds];
    const validIds = [];
    for (const userId of participantIds) {
        if (isVirtualPlayer(userId)) {
            validIds.push(userId);
            continue;
        }
        const member = await fetchMember(game, userId);
        if (isValidHumanMember(member) && !isActivelyTimedOut(member)) {
            validIds.push(userId);
        }
    }

    let ready = false;
    let cancelled = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'recruiting') return;
        if (validIds.length < minParticipantsFor(game)) {
            cancelled = true;
            return;
        }
        game.state = 'playing';
        game.alive = shuffleInPlace([...validIds], game);
        // 戴罪上桌名单：开局这一刻名字上还挂着 🤡 的人。快照一次，整局不再重算。
        // 只有真正开局才有这份名单，招募人数不足被取消的局压根不该给人摘牌。
        game.redeemers = validIds.filter(
            id => !isVirtualPlayer(id) && cowardPenaltyRemainingMs(game.guildId, id) > 0
        );
        // 数据只从这里开始记：招募人数不足被取消的局压根不该进榜单。
        // 测试局（含虚拟机器人，且真人可以混进来一起玩）整局跳过，避免污染正式数据。
        game.stats = game.testConfig ? null : createPressureStats(validIds);
        game.turnIndex = 0;
        game.bullets = 0;
        game.gunDuds = 0;
        game.pressure = 0;
        game.pressureBullets = 0;
        game.shotNumber = 0;
        setCharge(game, null, 0);
        // 备第一轮的待发池，再从里面抽 1 发装进枪。开局那一发也可能是哑弹 ——
        // 打掉之后枪空了会自动补，所以不会出现「一枪没人倒就收场」的死局。
        preparePool(game);
        drawIntoGun(game, AUTO_RELOAD_BULLETS);
        spinCylinder(game);

        // 测试模式可以把开局那发子弹钉在指定弹巢，方便复现「第 N 枪必中」。
        // 钉的是实弹，否则这个工具就失去意义了。
        const forcedChamber = game.testConfig?.bulletChamber;
        if (forcedChamber >= 1 && forcedChamber <= CHAMBER_COUNT) {
            game.chambers = new Array(CHAMBER_COUNT).fill(null);
            game.chambers[forcedChamber - 1] = LIVE;
            game.bullets = 1;
            game.gunDuds = 0;
            game.revealed = new Array(CHAMBER_COUNT).fill(false);
            game.hitChambers = new Array(CHAMBER_COUNT).fill(false);
            game.dudChambers = new Array(CHAMBER_COUNT).fill(false);
            game.pointer = 0;
        }

        game.phase = 'fire';
        game.turnToken += 1;
        ready = true;
    });

    clearRecruitmentTimer(game);
    if (cancelled) {
        await settleGame(game, 'cancelled');
        return;
    }
    if (!ready) return;

    // 招募结束，常驻招募消息下岗，频道从这一秒起只出现游戏进行中的面板。
    await deleteRecruitmentPanel(game);

    // 只有真正开局才通知调用方扣冷却：招募人数不足被取消时，
    // 发起人不该白白损失一次使用机会。
    try {
        game.onGameStarted?.();
    } catch (error) {
        logDiscordFailure(game, 'on-game-started', error, game.initiatorId);
    }

    await startTurn(game);
}

async function handleJoin(game, interaction) {
    const userId = interaction.user?.id;
    const member = await fetchMember(game, userId);

    if (!isValidHumanMember(member)) {
        await replyEphemeral(interaction, INVALID_MEMBER_MESSAGE);
        return;
    }
    if (isActivelyTimedOut(member)) {
        await replyEphemeral(interaction, TIMEOUT_BLOCKED_MESSAGE);
        return;
    }
    // 名字上还挂着 🤡 的人照样能上桌，代价是戴罪：这局没有逃生按钮，
    // 中弹时没挂完的耻辱会折成禁言。名单在 beginGame 里快照。

    let rejection = null;
    let shouldStart = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'recruiting') {
            rejection = EXPIRED_MESSAGE;
            return;
        }
        if (game.participantIds.includes(userId)) {
            rejection = DUPLICATE_MESSAGE;
            return;
        }
        if (game.participantIds.length >= MAX_PARTICIPANTS) {
            rejection = FULL_MESSAGE;
            return;
        }
        if (!gameManager.addPlayer(game, userId)) {
            rejection = PLAYER_BUSY_MESSAGE;
            return;
        }
        shouldStart = game.participantIds.length >= MAX_PARTICIPANTS;
    });

    if (rejection) {
        await replyEphemeral(interaction, rejection);
        return;
    }

    await replyEphemeral(interaction, JOINED_MESSAGE);
    if (shouldStart) {
        await beginGame(game);
        return;
    }
    await renderRecruitment(game);
}

async function handleTurnInteraction(game, interaction, parsed) {
    const userId = interaction.user?.id;
    const expectedPhase = TURN_ACTIONS[parsed.action];

    let rejection = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') {
            rejection = EXPIRED_MESSAGE;
            return;
        }
        if (game.alive[game.turnIndex] !== userId) {
            rejection = NOT_YOUR_TURN_MESSAGE;
            return;
        }
        if (game.phase !== expectedPhase || game.turnToken !== parsed.turnToken) {
            rejection = STALE_ACTION_MESSAGE;
            return;
        }
        // 按钮不会渲染给戴罪的人，但旧面板上的可能还留着，给他一句明话。
        if (parsed.action === 'quit' && isRedeemer(game, userId)) {
            rejection = NO_ESCAPE_MESSAGE;
        }
    });

    if (rejection) {
        await replyEphemeral(interaction, rejection);
        return;
    }
    if (!await acknowledge(interaction)) return;

    if (parsed.action === 'fire') {
        await performShot(game, parsed.turnToken);
        return;
    }
    if (parsed.action === 'quit') {
         await handleQuit(game, userId, parsed.turnToken);
        return;
    }
    if (parsed.action === 'unload') {
        await handleUnload(game, parsed.turnToken);
        return;
    }
    if (parsed.action === 'riposte') {
        await handleRiposte(game, parsed.turnToken);
        return;
    }
    await handleChoice(game, parsed.action, parsed.turnToken);
}

function parsePressureCustomId(customId) {
    if (typeof customId !== 'string' || !customId.startsWith(CUSTOM_ID_PREFIX)) return null;

    const parts = customId.split(':');
    const action = parts[0].slice(CUSTOM_ID_PREFIX.length);
    const gameId = parts[1];
    if (!ID_PATTERN.test(gameId || '')) return null;

    if (action === 'join') {
        return parts.length === 2 ? { action, gameId } : null;
    }
    if (!Object.hasOwn(TURN_ACTIONS, action) && !Object.hasOwn(VOTE_ACTIONS, action)) return null;
    if (parts.length !== 3 || !/^\d+$/.test(parts[2])) return null;

    return { action, gameId, turnToken: Number(parts[2]) };
}

async function handlePressureInteraction(interaction) {
    if (!interaction?.isButton?.()) return false;

    const parsed = parsePressureCustomId(interaction.customId);
    const game = parsed && gameManager.getGame(parsed.gameId);
    if (!parsed || !game || game.type !== GAME_TYPE) {
        await replyEphemeral(interaction, EXPIRED_MESSAGE);
        return true;
    }

    try {
        if (parsed.action === 'join') {
            await handleJoin(game, interaction);
        } else if (Object.hasOwn(VOTE_ACTIONS, parsed.action)) {
            await handleVote(game, interaction, parsed.action, parsed.turnToken);
        } else {
            await handleTurnInteraction(game, interaction, parsed);
        }
    } catch (error) {
        logDiscordFailure(game, `handle-${parsed.action}`, error, interaction.user?.id);
        await replyEphemeral(interaction, '❌ **处理这次操作时出了点问题，请稍后再试。**');
    }
    return true;
}

function buildTestSetup(options) {
    const test = options.test;
    if (!test) return { testConfig: null, virtualIds: [], labels: {} };

    const botCount = Math.max(1, Math.min(MAX_TEST_BOTS, Number(test.botCount) || 1));
    const virtualIds = Array.from({ length: botCount }, (_, index) => `${VIRTUAL_PREFIX}${index + 1}`);
    const labels = Object.fromEntries(
        virtualIds.map((id, index) => [id, `🤖 **测试机器人${index + 1}**`])
    );

    return {
        testConfig: {
            botCount,
            immediate: test.immediate !== false,
            bulletChamber: Number(test.bulletChamber) || 0,
            keepMessages: test.keepMessages === true,
        },
        virtualIds,
        labels,
    };
}

// ---------- 断点续玩：进行中对局的快照与恢复 ----------

// 快照只在**稳定检查点**写：fire / choice / vote 这三个「停下来等玩家动作」的状态。
// resolving（正在结算中弹）这种过渡状态一律不写 —— 崩在那里就回退到上一个检查点，
// 顶多重来一个动作，绝不会写出「淘汰到一半」的残缺状态。
//
// 招募中的局不存：它的冷却是靠 onGameStarted 闭包扣的，那个闭包重建不了，
// 恢复它等于开了「开局后重启就不扣冷却」的口子；而招募局本来也没人投入什么。
function persistGame(game) {
    if (!game || game.ended || game.settled) return;
    // 测试局全是虚拟机器人，恢复它没意义，还会白占频道锁。
    if (game.testConfig) return;
    if (game.state !== 'playing') return;

    try {
        gameStore.saveSnapshot(game.id, serializeGame(game));
    } catch (error) {
        // 存盘失败最多是这一局不能续玩，绝不能反过来影响正在进行的游戏。
        logDiscordFailure(game, 'persist-game', error);
    }
}

function forgetGame(game) {
    if (!game?.id) return;
    try {
        gameStore.deleteSnapshot(game.id);
    } catch (error) {
        logDiscordFailure(game, 'forget-game', error);
    }
}

function serializeGame(game) {
    return {
        savedAt: Date.now(),
        id: game.id,
        guildId: game.guildId,
        channelId: game.channelId,
        initiatorId: game.initiatorId,
        participantIds: [...game.participantIds],
        labels: game.labels || {},
        turnDurationMs: game.turnDurationMs,
        state: game.state,
        phase: game.phase,
        turnToken: game.turnToken,
        turnIndex: game.turnIndex,
        // 弹巢 + 子弹盒。真假构成也在里面 —— 快照落在服务器磁盘上，玩家看不到。
        chambers: [...game.chambers],
        revealed: [...game.revealed],
        hitChambers: [...game.hitChambers],
        dudChambers: [...(game.dudChambers || [])],
        pointer: game.pointer,
        bullets: game.bullets,
        gunDuds: game.gunDuds || 0,
        pool: [...(game.pool || [])],
        poolDudTotal: game.poolDudTotal || 0,
        wave: game.wave || 0,
        // 局面
        pressure: game.pressure,
        pressureBullets: game.pressureBullets || 0,
        charge: game.charge || 0,
        chargeOwnerId: game.chargeOwnerId || null,
        shotNumber: game.shotNumber,
        unloadUsed: [...(game.unloadUsed || [])],
        // 挂机档位也要进快照，否则重启后挂机者白捡回 60 秒。
        timeoutTiers: { ...(game.timeoutTiers || {}) },
        unloadShotOwner: game.unloadShotOwner || null,
        riposteHolderId: game.riposteHolderId || null,
        riposteTargetId: game.riposteTargetId || null,
        riposte: game.riposte ? { ...game.riposte } : null,
        // 欠着的强制开枪要跟着走，否则重启一次就能白赖掉加压压过来的那一枪。
        pressureDebt: game.pressureDebt ? { ...game.pressureDebt } : null,
        alive: [...game.alive],
        eliminated: game.eliminated.map(entry => ({ ...entry })),
        cowards: game.cowards.map(entry => ({ ...entry })),
        redeemers: [...(game.redeemers || [])],
        resumeAfterVote: game.resumeAfterVote || null,
        // 统计累加器：Map 进不了 JSON，摊平成数组，恢复时再装回去。
        stats: game.stats
            ? { startedAt: game.stats.startedAt, players: [...game.stats.players.values()] }
            : null,
        // 恢复时要把这些旧面板删掉，否则频道里会留一堆过期按钮。
        panelMessageIds: (game.panels || [])
            .map(entry => entry.message?.id)
            .filter(Boolean),
    };
}

// 把快照还原成一个可运行的对局对象。Discord 的活对象（channel / guild）
// 由调用方取好传进来，定时器和 Promise 一律重建。
function deserializeGame(snapshot, { guild, channel }) {
    return {
        id: snapshot.id,
        type: GAME_TYPE,
        guildId: snapshot.guildId,
        channelId: snapshot.channelId,
        channel,
        guild,
        initiatorId: snapshot.initiatorId,
        participantIds: [...snapshot.participantIds],
        testConfig: null,
        keepMessages: false,
        labels: snapshot.labels || {},
        turnDurationMs: snapshot.turnDurationMs || TURN_DURATION_MS,
        state: 'playing',
        settled: false,
        chambers: [...snapshot.chambers],
        revealed: [...snapshot.revealed],
        hitChambers: [...snapshot.hitChambers],
        dudChambers: [...(snapshot.dudChambers || new Array(CHAMBER_COUNT).fill(false))],
        pointer: snapshot.pointer,
        bullets: snapshot.bullets,
        gunDuds: snapshot.gunDuds || 0,
        pool: [...(snapshot.pool || [])],
        poolDudTotal: snapshot.poolDudTotal || 0,
        wave: snapshot.wave || 1,
        // 投票不沿用重启前的票：面板是新发的、token 也换了，
        // 让点过的人收到「你已经投过了」只会莫名其妙。重新投一轮。
        votes: null,
        resumeAfterVote: snapshot.resumeAfterVote || null,
        pressure: snapshot.pressure,
        pressureBullets: snapshot.pressureBullets || 0,
        charge: snapshot.charge || 0,
        chargeOwnerId: snapshot.chargeOwnerId || null,
        shotNumber: snapshot.shotNumber,
        unloadUsed: [...(snapshot.unloadUsed || [])],
        // 旧快照没有这个字段时当全新一局处理（空对象）。
        timeoutTiers: { ...(snapshot.timeoutTiers || {}) },
        riposteHolderId: snapshot.riposteHolderId || null,
        riposteTargetId: snapshot.riposteTargetId || null,
        riposte: snapshot.riposte ? { ...snapshot.riposte } : null,
        // 旧快照没有这个字段时当没欠债处理。
        pressureDebt: snapshot.pressureDebt ? { ...snapshot.pressureDebt } : null,
        // 退弹枪标记不恢复：那一枪早就打完或者被回退了，留着只会误伤下一轮。
        unloadShotOwner: null,
        alive: [...snapshot.alive],
        eliminated: (snapshot.eliminated || []).map(entry => ({ ...entry })),
        cowards: (snapshot.cowards || []).map(entry => ({ ...entry })),
        redeemers: [...(snapshot.redeemers || [])],
        stats: snapshot.stats
            ? {
                startedAt: snapshot.stats.startedAt,
                players: new Map((snapshot.stats.players || []).map(row => [row.userId, row])),
            }
            : null,
        turnIndex: snapshot.turnIndex,
        // token 往前推一格，让重启前那些还挂在频道里的旧按钮彻底失效。
        turnToken: (Number(snapshot.turnToken) || 0) + 1,
        phase: snapshot.phase,
        panels: [],
        recruitmentEntry: null,
        panelQueue: Promise.resolve(),
        recruitmentEndsAt: Date.now(),
        random: Math.random,
        timers: new Set(),
        // 冷却在开局那一刻就已经扣过了，恢复的局不该再扣一次。
        onGameStarted: null,
    };
}

// 运行期才有的东西：成员失效回调、摘按钮、关停钩子。
// 新开的局和恢复的局都走这里，保证两条路径挂的是同一套行为。
function attachRuntime(game) {
    game.onMemberInvalidated = async invalidMember => {
        const invalidUserId = invalidMember?.id || invalidMember?.user?.id;
        if (invalidUserId) await handleMemberInvalidated(game, invalidUserId);
    };
    game.disableComponents = async () => {
        const entry = game.panels?.at(-1);
        if (!entry?.interactive || typeof entry.message?.edit !== 'function') return;
        entry.interactive = false;
        try {
            await entry.message.edit({ components: [] });
        } catch (error) {
            // 面板可能已被删除，忽略。
        }
    };
    game.onShutdown = () => handleShutdown(game);
    return game;
}

// 进程要退出了。已经开打的局存一份快照下次接着打；还在招募的局直接取消
// （见 persistGame 的说明）。两种情况都要先把按钮摘掉，别留下点了没反应的面板。
async function handleShutdown(game) {
    clearTurnTimer(game);
    clearRecruitmentTimer(game);

    const resumable = !game.testConfig && game.state === 'playing' && !game.settled && !game.ended;
    if (!resumable) {
        // 招募局 / 测试局：干净取消，释放频道锁和玩家锁。
        await settleGame(game, 'cancelled');
        return;
    }

    try {
        await game.disableComponents?.();
    } catch (error) {
        // 摘按钮是尽力而为，摘不掉也要把快照存下去。
    }

    // 先发公告再存快照：这样公告消息的 id 会被记进 panelMessageIds，
    // 恢复的时候一并删掉，频道里不会留着「正在重启」的僵尸消息。
    try {
        const sent = await game.channel?.send?.(panels.shutdownNotice(buildView(game)));
        if (sent) game.panels.push({ message: sent, interactive: false });
    } catch (error) {
        logDiscordFailure(game, 'shutdown-notice', error);
    }

    persistGame(game);
}

/**
 * 启动时把上次没打完的对局捞回来。应当在 client ready 之后调用。
 * @param {import('discord.js').Client} client
 */
async function restorePressureGames(client) {
    let snapshots = [];
    try {
        snapshots = gameStore.loadSnapshots();
    } catch (error) {
        console.error('[MysteryPressure] 读取对局快照失败:', error);
        return { restored: 0, dropped: 0 };
    }
    if (snapshots.length === 0) return { restored: 0, dropped: 0 };

    // 这一批快照无论成败都不留到下次启动再试：恢复成功的那些会在
    // 下一个检查点重新写入，失败的重试一百次也还是失败。
    gameStore.clearAll();

    let restored = 0;
    let dropped = 0;
    for (const snapshot of snapshots) {
        try {
            if (await restoreOneGame(client, snapshot)) restored += 1;
            else dropped += 1;
        } catch (error) {
            dropped += 1;
            console.error(`[MysteryPressure] 恢复对局失败 (game=${snapshot?.id}):`, error);
        }
    }

    console.log(
        `[MysteryPressure] 🔄 对局恢复完成：接上 ${restored} 场，放弃 ${dropped} 场。`
    );
    return { restored, dropped };
}

// 删掉重启前留在频道里的面板。拿不到就算了，不能让清理失败挡住恢复。
async function purgeStalePanels(channel, messageIds) {
    for (const messageId of messageIds || []) {
        try {
            const message = await channel.messages.fetch(messageId);
            await message.delete();
        } catch (error) {
            // 消息可能已经被删了、或者权限没了，忽略。
        }
    }
}

// 停机期间有人退服、或者被管理员禁言了，这些人不能再算在场上。
// 返回还站着的人。
async function reconcileAliveMembers(game) {
    const survivors = [];
    for (const userId of game.alive) {
        if (isVirtualPlayer(userId)) continue;
        const member = await fetchMember(game, userId);
        if (isValidHumanMember(member) && !isActivelyTimedOut(member)) {
            survivors.push(userId);
            continue;
        }
        // 没打完这一局，🤡 摘牌资格取消，和中途退服一个待遇。
        dropRedeemer(game, userId);
        gameManager.removePlayer(game, userId);
        releaseOnExit(game, userId);
    }
    game.alive = survivors;
    if (game.turnIndex >= game.alive.length) game.turnIndex = 0;
    return survivors;
}

async function restoreOneGame(client, snapshot) {
    if (!snapshot?.id || !snapshot.guildId || !snapshot.channelId) return false;
    if (snapshot.state !== 'playing') return false;

    const guild = await client.guilds.fetch(snapshot.guildId).catch(() => null);
    if (!guild) return false;
    const channel = await client.channels.fetch(snapshot.channelId).catch(() => null);
    if (!channel || typeof channel.send !== 'function') return false;

    const created = gameManager.createGame(deserializeGame(snapshot, { guild, channel }));
    if (!created.ok) {
        console.warn(
            `[MysteryPressure] 快照 ${snapshot.id} 无法注册（${created.reason}），放弃恢复。`
        );
        return false;
    }
    const game = attachRuntime(created.game);

    await purgeStalePanels(channel, snapshot.panelMessageIds);
    await reconcileAliveMembers(game);

    // 人不够就别硬接了，直接按当前局面收场。
    const outcome = evaluateOutcome(game);
    if (outcome) {
        await settleGame(game, outcome);
        return true;
    }

    await renderPanel(game, panels.restoredAnnouncement(buildView(game)));

    // 按停机时停在哪个检查点接着走。计时器全部重新计满 —— 玩家刚回来，
    // 不该让他背上重启前只剩几秒的那个回合。
    if (game.phase === 'choice') {
        await renderChoice(game);
    } else if (game.phase === 'vote') {
        game.votes = new Map();
        await startDrawVote(game);
    } else {
        // fire，以及任何对不上的过渡状态，一律回到「轮到你开枪」。
        game.phase = 'fire';
        await startTurn(game);
    }
    return true;
}

async function startPressureRoulette(interaction, options = {}) {
    const userId = interaction.user?.id;
    const guildId = interaction.guildId || interaction.guild?.id;
    const { testConfig, virtualIds, labels } = buildTestSetup(options);

    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (error) {
        console.error('[MysteryPressure] defer 开局回复失败:', error);
        return false;
    }

    const provisionalGame = {
        id: randomUUID(),
        type: GAME_TYPE,
        guildId,
        channelId: interaction.channelId,
        channel: interaction.channel,
        guild: interaction.guild,
        initiatorId: userId,
        participantIds: [userId, ...virtualIds],
        testConfig,
        keepMessages: testConfig?.keepMessages === true,
        labels,
        turnDurationMs: Number(options.turnDurationMs) || TURN_DURATION_MS,
        state: 'recruiting',
        settled: false,
        chambers: new Array(CHAMBER_COUNT).fill(null),
        revealed: new Array(CHAMBER_COUNT).fill(false),
        hitChambers: new Array(CHAMBER_COUNT).fill(false),
        dudChambers: new Array(CHAMBER_COUNT).fill(false),
        pointer: 0,
        bullets: 0,
        // 枪里这几发中有几发是哑弹。全场都不知道这个数，只有系统知道。
        gunDuds: 0,
        // 待发子弹池。beginGame 才真正备池，招募阶段恒为空。
        pool: [],
        poolDudTotal: 0,
        wave: 0,
        // 和局判定期间的投票记录（userId -> 'agree' | 'object'），平时为 null。
        votes: null,
        resumeAfterVote: null,
        pressure: 0,
        pressureBullets: 0,
        charge: 0,
        chargeOwnerId: null,
        shotNumber: 0,
        // 反制机制状态：退弹额度 + 反手权归属 + 进行中的反手序列。
        unloadUsed: [],
        // 挂机档位（方案 B）：整局累计、只增不减。真人被系统等到点一次 +1。
        timeoutTiers: {},
        riposteHolderId: null,
        riposteTargetId: null,
        riposte: null,
        // 加压逼出来的强制开枪债：{ ownerId, remaining, total }，没欠债时为 null。
        pressureDebt: null,
        // 退弹枪的一次性标记：扣完这一枪立刻消费掉。
        unloadShotOwner: null,
        alive: [],
        eliminated: [],
        cowards: [],
        // beginGame 快照，招募阶段恒为空。
        redeemers: [],
        // 真正开局（beginGame）时才创建，在那之前没有任何数据可记。
        stats: null,
        turnIndex: 0,
        turnToken: 0,
        phase: 'idle',
        panels: [],
        recruitmentEntry: null,
        panelQueue: Promise.resolve(),
        recruitmentEndsAt: Date.now() + RECRUITMENT_DURATION_MS,
        random: Math.random,
        timers: new Set(),
        onGameStarted: typeof options.onGameStarted === 'function' ? options.onGameStarted : null,
    };

    const member = await fetchMember(provisionalGame, userId);
    if (!isValidHumanMember(member)) {
        await replyEphemeral(interaction, INVALID_MEMBER_MESSAGE);
        return false;
    }
    if (isActivelyTimedOut(member)) {
        await replyEphemeral(interaction, TIMEOUT_BLOCKED_MESSAGE);
        return false;
    }

    const created = gameManager.createGame(provisionalGame);
    if (!created.ok) {
        await replyEphemeral(
            interaction,
            created.reason === 'player' ? PLAYER_BUSY_MESSAGE : CHANNEL_BUSY_MESSAGE
        );
        return false;
    }
    // 成员失效回调 / 摘按钮 / 关停钩子统一在这里挂，
    // 和从快照恢复出来的对局走的是同一套 —— 两条路径行为不会漂。
    const game = attachRuntime(created.game);

    await renderRecruitment(game);
    if (game.panels.length === 0) {
        await cleanupPressureGame(game);
        await replyEphemeral(interaction, PANEL_FAILURE_MESSAGE);
        return false;
    }

    await replyEphemeral(interaction, testConfig ? START_TEST_ACK_MESSAGE : START_ACK_MESSAGE);

    // 测试模式默认不等 3 分钟招募，直接开打。
    if (testConfig?.immediate) {
        await beginGame(game);
        return true;
    }

    game.recruitmentTimer = setTimeout(() => {
        beginGame(game).catch(error => logDiscordFailure(game, 'recruitment-timer', error));
    }, RECRUITMENT_DURATION_MS);
    game.recruitmentTimer.unref?.();
    game.timers.add(game.recruitmentTimer);
    return true;
}

module.exports = {
    CUSTOM_ID_PREFIX,
    GAME_TYPE,
    PANEL_HISTORY_LIMIT,
    CHAMBER_COUNT,
    MIN_PARTICIPANTS,
    MAX_PARTICIPANTS,
    BASE_TIMEOUT_MINUTES,
    MINUTES_PER_PRESSURE,
    POOL_SIZE,
    POOL_DUD_MIN,
    POOL_DUD_MAX,
    AUTO_RELOAD_BULLETS,
    DRAW_VOTE_DURATION_MS,
    startPressureRoulette,
    restorePressureGames,
    // 导出给测试用：验证「快照字段没漏」这件事必须能自动化，
    // 漏一个字段就是恢复后状态悄悄丢失，靠眼睛看是看不住的。
    serializeGame,
    deserializeGame,
    handlePressureInteraction,
    parsePressureCustomId,
    renderPanel,
    pruneToFinalPanel,
    deleteRecruitmentPanel,
};
