'use strict';
/**
 * 恶魔轮盘交互层（PvP 挑战 / PvE 对庄家）。
 *
 * 面板/按钮/流程/文案：
 *   - ChallengeView：⚔️ 应战 / 接受挑战 / 拒绝 / 🛑 发起人取消
 *   - GameView：当前回合指示 + 🔫 打对手 + 💀 打自己 + 道具按钮 + 💉 肾上腺素选择器
 *              + 📜 我的情报 + ❓ 道具简介
 *   - 播报面板（开枪/装填）、🎁 道具使用聚合面板、仅你可见情报/道具简介（含认输）
 *   - 🏆 结算面板（胜者选惩罚：禁言 5 / 改名 10，认输口径 3/7，30s 未选自动禁言 5）
 *   - PvE 失败（庄家赢/认输）→ 自动改名「恶魔枪下的第 N 名亡魂」8 分钟（N=数据库永久累计）；PvE 胜 → 战绩+1
 *
 * 引擎状态机走 core/devilRouletteEngine（一局定胜负）；
 * 庄家决策走 core/devilSolverWorker（Worker 线程，预算/时间窗 env 可配）。
 * 走 mystery 骨架：gameManager 锁、custom-id 路由前缀 mystery_devil_roulette_、
 * mysteryNicknameLock 昵称锁（改名惩罚落地与到期恢复）。
 */

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');
const gameManager = require('./mysteryGameManager');
const nicknameLock = require('./mysteryNicknameLock');
const { ORDINARY_LOCK_TYPES } = require('./mysteryNicknameLockService');
const resumeStore = require('../utils/devilRouletteResumeStore');
const {
    recordDevilRoulettePveResult,
    getDevilRoulettePveStats,
    incrementDevilRouletteDeathCount,
} = require('../utils/mysteryStatsDatabase');
const {
    DevilState,
    InvalidAction,
    defaultRng,
    ITEM_DEFS,
    ITEM_KEYS,
    MAX_ITEM_SLOTS,
    GAME_CONFIG,
    SURRENDER_MIN_HP,
} = require('../core/devilRouletteEngine');

// ── 常量 ────────────────────────────────────────────────────────────────────

const CHALLENGE_SECONDS = 120; // 挑战 / 公屏擂台等待时长（无人应战自动取消）
const TURN_SECONDS = 60;
const GRACE_SECONDS = 2;
const AUTO_THINK_SECONDS = 0.5; // 庄家思考时长
const EPHEMERAL_TTL_MS = 60_000; // 仅自己可见的一次性窗口默认 TTL
const PANEL_HISTORY_LIMIT = 3; // 滚动窗口上限
const ITEM_LOG_LIMIT = 6; // 道具使用面板内最多保留的操作块数
const PRIVATE_PANEL_LABEL = '📜 我的情报';
const ITEM_HELP_LABEL = '❓ 道具简介';
const PENALTY_MUTE_MINUTES = 5;
const PENALTY_RENAME_MINUTES = 10;
const PENALTY_AUTO_MUTE_MINUTES = 5;
const PENALTY_SETTLEMENT_SECONDS = 30;
const SURRENDER_MUTE_MINUTES = 3;
const SURRENDER_RENAME_MINUTES = 7;
const PVE_GHOST_RENAME_MINUTES = 8; // PvE 庄家赢：改名「恶魔枪下的第 N 名亡魂」时长
const DEVIL_ROULETTE_PVE_GLOBAL_CAP = 10; // 与庄家对赌全局并发上限（每局占一个求解器 Worker，防并发饱和）
const PENALTY_NICKNAME = '🔒 恶魔轮盘输家';
const PENALTY_MUTE_REASON = '恶魔轮盘：败者惩罚';
const PENALTY_RENAME_APPLY_REASON = '恶魔轮盘：败者强制改名';
const PENALTY_RENAME_RESTORE_REASON = '恶魔轮盘：改名惩罚到期，恢复原昵称';
const PENALTY_RENAME_ENFORCE_REASON = '恶魔轮盘：败者强制改名';
const RENAME_LOCK_TYPE = 'devil_roulette_rename';
const RENAME_MODAL_PREFIX = 'mystery_devil_roulette_rename_modal';

// 道具简介的简化版文案（局内按钮弹窗用）。
const ITEM_HELP_SHORT = {
    magnifier: '看当前这一发是实弹还是空弹',
    cigarette: '回复 1 点血',
    beer: '弹出膛内当前那颗子弹',
    saw: '下一发实弹伤害翻倍（2 点）',
    handcuffs: '对手下一回合无法行动',
    phone: '预知往后某一发是什么弹',
    inverter: '把当前膛内子弹翻成相反类型',
    adrenaline: '偷走对手一件道具并立即使用',
    medicine: '40% 回复 2 点血，否则失去 1 点',
};

// 按钮配色语义：红=开枪/伤害；蓝=情报/查看；绿=治疗/恢复；灰=膛内工具/被动提示。
const ITEM_BUTTON_STYLE = {
    cigarette: 'success',
    medicine: 'success',
    magnifier: 'primary',
    phone: 'primary',
    beer: 'secondary',
    inverter: 'secondary',
    saw: 'danger',
    handcuffs: 'danger',
    adrenaline: 'secondary',
};

const STYLE_MAP = {
    primary: ButtonStyle.Primary,
    secondary: ButtonStyle.Secondary,
    success: ButtonStyle.Success,
    danger: ButtonStyle.Danger,
};

// 庄家风味文案：短、面无表情、带点荒诞。
const FLAVOR = {
    miss: [
        '……没响。',
        '空弹。',
        '它很安静。',
        '这次不是它。',
        '枪只发出空响。',
        '击针落了个空。',
        '这一发，命运提前走了。',
        '弹巢里安静得能听见心跳。',
    ],
    hit: [
        '砰。',
        '响了。',
        '……中了。',
        '弹孔没有偏。',
        '它这一枪没有失手。',
        '声音在房间里停留了一会儿。',
    ],
    self_hit: [
        '它咬的是自己。',
        '枪口对着自己，这次它没客气。',
        '镜子碎了，血是自己的。',
        '它向自己证明了一件事。',
    ],
    reload: [
        '弹壳用完了，重新装填。',
        '它又塞进去几发。',
        '弹巢重新转了起来。',
        '它给枪换了口气。',
        '又一轮，命运被重新洗牌。',
    ],
    round_end: [
        '这一轮，有人倒下了。',
        '枪口下，又少了一个回合。',
        '赌注又叠了一层。',
        '有人离开了这桌。',
    ],
    game_end: [
        '最后站着的人，拿着钱离开。',
        '门开了，外面是夜。',
        '枪放下了。尘埃也放下了。',
        '赢家收拾桌面，输家收拾自己。',
    ],
    saw: [
        '锯子咬过，这一枪更狠。',
        '它把伤口撕得更开。',
        '下一位客人会记住这把锯。',
        '子弹经过锯过的枪管，变得更急了。',
    ],
    beer: [
        '啤酒顶开了一发。',
        '它把危险的子弹吐了出来。',
        '咔嗒，一枚弹壳滚落。',
        '子弹掉在桌上，还带着余温。',
    ],
    handcuff: [
        '手铐锁上了。',
        '下一回合，对方动弹不得。',
        '锁链声很轻。',
        '它的对手被固定在椅子上。',
    ],
    heal: [
        '烟把命续了回来。',
        '它重新有了力气。',
        '血的颜色回来了。',
        '它又看了一眼自己的手。',
    ],
    surrender: [
        '它放下枪，走出了门。',
        '子弹没有输，是心先认了输。',
        '它比谁都想活着。',
        '枪还在桌上，人已经离席。',
        '勇气用完了，但命还在。',
        '它把枪还给命运，转身离开。',
    ],
};

const EXPIRED_MESSAGE = '这局已经结束了。';
const NOT_YOUR_TURN_MESSAGE = '现在还没轮到你。';
const ACT_FAILED_MESSAGE = '操作失败，请重试或刷新面板。';

// ── 求解器 Worker ────────────────────────────────────────────────────────────

const SOLVER_WORKER_PATH = path.join(__dirname, '..', 'core', 'devilSolverWorker.js');
const SOLVER_MAX_MS = Number(process.env.ROULETTE_SOLVER_MAX_MS || 10_000); // 庄家求解窗口（默认 10s：省算力、回合内留足余量；不追求极致最优）
const SOLVER_START_BUDGET = Number(process.env.ROULETTE_SOLVER_START_BUDGET || 50_000);
// 庄家最低行动窗口：面板至少展示这么久再行动（让人类有时间看），算完立即行动、不等满窗。
const DEALER_MIN_THINK_MS = Number(process.env.ROULETTE_DEALER_MIN_THINK_MS || 3_000);

// 求解器 Worker 池大小（通用自适应，不绑定特定服务器/容器）：
//   1. 核数优先读容器 cgroup 配额（v1/v2 都试，尊重 --cpus/CPU 配额），读不到才回退 os.cpus()；
//   2. 默认取 50% 核数（ROULETTE_SOLVER_CPU_RATIO 可调），并永远留出至少 1 核给主线程/Discord；
//   3. ROULETTE_SOLVER_WORKERS 可直接写死覆盖（>0 时完全忽略上面公式）。
// 池按需惰性扩容：单局只起 1 个 Worker（省内存），并发局多才补满到上限。
function detectCpuCount() {
    const os = require('node:os');
    const fs = require('node:fs');
    // cgroup v2：/sys/fs/cgroup/cpu.max → "quota period"，quota=-1 表示不限。
    try {
        const raw = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim();
        const [quotaStr, periodStr] = raw.split(/\s+/);
        const quota = Number(quotaStr);
        const period = Number(periodStr);
        if (Number.isFinite(quota) && Number.isFinite(period) && quota > 0 && period > 0) {
            return Math.max(1, Math.round(quota / period));
        }
    } catch { /* 无 cgroup 配额，走回退 */ }
    // cgroup v1：cpu.cfs_quota_us / cpu.cfs_period_us（-1 表示不限）。
    try {
        const quota = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8').trim());
        const period = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8').trim());
        if (Number.isFinite(quota) && Number.isFinite(period) && quota > 0 && period > 0) {
            return Math.max(1, Math.round(quota / period));
        }
    } catch { /* 走 os.cpus() 回退 */ }
    return Math.max(1, os.cpus().length);
}

const SOLVER_POOL_SIZE = (() => {
    const explicit = Number(process.env.ROULETTE_SOLVER_WORKERS || 0);
    if (explicit >= 1) return Math.floor(explicit);
    const cpus = detectCpuCount();
    const ratio = Number(process.env.ROULETTE_SOLVER_CPU_RATIO || 0.5);
    // 60% 上限 ∩ 永远留 1 核给主线程；至少 1（1 核机器也只能共挤一核）。
    return Math.max(1, Math.min(cpus - 1, Math.floor(cpus * ratio)));
})();

// ── 基础工具 ──────────────────────────────────────────────────────────────────

function logDiscordFailure(game, action, error, userId = 'system') {
    console.error(
        `[MysteryDevilRoulette] Discord API 失败 (guild=${game?.guildId || 'unknown'}, game=${game?.id || 'unknown'}, user=${userId}, action=${action}):`,
        error
    );
}

function mention(userId) {
    if (userId == null) return '（无人）';
    return `<@${userId}>`;
}

function pickRandom(arr) {
    if (!arr || !arr.length) return '';
    return arr[Math.floor(Math.random() * arr.length)];
}

function flavor(kind) {
    return pickRandom(FLAVOR[kind] || []);
}

function percent(value) {
    return `${(value * 100).toFixed(1)}%`;
}

function riskLabel(probability) {
    if (probability <= 0.0) return '必空弹';
    if (probability >= 1.0) return '必实弹';
    if (probability < 0.34) return '低风险';
    if (probability < 0.60) return '中风险';
    if (probability < 0.80) return '高风险';
    return '极高风险';
}

function sleep(ms, timers) {
    if (ms <= 0) return Promise.resolve();
    return new Promise(resolve => {
        const t = setTimeout(() => {
            timers?.delete(t);
            resolve();
        }, Math.min(ms, 2 ** 31 - 1));
        t.unref?.();
        timers?.add(t);
    });
}

function knownIntelFor(state, playerId) {
    const known = state.knownShells[playerId] || {};
    const out = [];
    for (const [idx, val] of Object.entries(known)) {
        const i = Number(idx);
        if (i >= state.pointer) out.push([i - state.pointer, val]);
    }
    out.sort((a, b) => a[0] - b[0]);
    return out;
}

// ── 网络健壮性工具 ────────────────────────────────────────────────────────────

async function deferComponent(interaction, { ephemeral }) {
    if (!interaction || interaction.replied || interaction.deferred) return true;
    try {
        if (ephemeral) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            interaction._ephemeralDeferred = true;
        } else {
            await interaction.deferUpdate();
        }
        return true;
    } catch (error) {
        logDiscordFailure(null, 'defer-component', error, interaction.user?.id);
        return false;
    }
}

function scheduleEphemeralDelete(message, delayMs = EPHEMERAL_TTL_MS) {
    if (!message || typeof message.delete !== 'function') return;
    const t = setTimeout(() => {
        message.delete().catch(() => {});
    }, delayMs);
    t.unref?.();
}

async function sendEphemeral(interaction, payload) {
    if (!interaction) return false;
    try {
        let message = null;
        if (interaction._ephemeralDeferred && typeof interaction.editReply === 'function') {
            await interaction.editReply(payload);
            message = await interaction.fetchReply?.() || null;
        } else if ((interaction.deferred || interaction.replied) && typeof interaction.followUp === 'function') {
            message = await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
        } else if (typeof interaction.reply === 'function') {
            await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
            message = await interaction.fetchReply?.() || null;
        }
        if (message) scheduleEphemeralDelete(message);
        return Boolean(message);
    } catch (error) {
        logDiscordFailure(null, 'ephemeral-reply', error, interaction.user?.id);
        return false;
    }
}

async function sendComponentError(interaction, content) {
    return sendEphemeral(interaction, { content });
}

async function confirmComponent(interaction, content) {
    return sendEphemeral(interaction, { content });
}

// ── 纯开枪子博弈（启发式兜底用） ────────────────────────────────────────────

const _roundWinCache = new Map();

function _roundWinProb(live, blank, myHp, oppHp, myTurn) {
    if (myHp <= 0) return 0.0;
    if (oppHp <= 0) return 1.0;
    const total = live + blank;
    if (total <= 0) {
        const advantage = Math.max(-4, Math.min(4, myHp - oppHp));
        return Math.max(0.05, Math.min(0.95, 0.5 + 0.1 * advantage));
    }
    const key = `${live},${blank},${myHp},${oppHp},${myTurn ? 1 : 0}`;
    const cached = _roundWinCache.get(key);
    if (cached !== undefined) return cached;
    let value;
    if (myTurn) {
        const [vSelf, vOpp] = _shootEv(live, blank, myHp, oppHp);
        value = Math.max(vSelf, vOpp);
    } else {
        const pLive = live / total;
        const pBlank = blank / total;
        const oppShootMe = pLive * _roundWinProb(live - 1, blank, myHp - 1, oppHp, true)
            + pBlank * _roundWinProb(live, blank - 1, myHp, oppHp, true);
        const oppShootSelf = pBlank * _roundWinProb(live, blank - 1, myHp, oppHp, false)
            + pLive * _roundWinProb(live - 1, blank, myHp, oppHp - 1, true);
        value = Math.min(oppShootMe, oppShootSelf);
    }
    _roundWinCache.set(key, value);
    return value;
}

function _shootEv(live, blank, myHp, oppHp) {
    const total = live + blank;
    if (total <= 0) return [0.0, 0.0];
    const pLive = live / total;
    const pBlank = blank / total;
    const vSelf = pBlank * _roundWinProb(live, blank - 1, myHp, oppHp, true)
        + pLive * _roundWinProb(live - 1, blank, myHp - 1, oppHp, false);
    const vOpp = pLive * _roundWinProb(live - 1, blank, myHp, oppHp - 1, false)
        + pBlank * _roundWinProb(live, blank - 1, myHp, oppHp, false);
    return [vSelf, vOpp];
}

function _bestShoot(live, blank, myHp, oppHp) {
    if (live + blank <= 0) return ['shoot_opponent', 0.5];
    const [vSelf, vOpp] = _shootEv(live, blank, myHp, oppHp);
    return vSelf >= vOpp ? ['shoot_self', vSelf] : ['shoot_opponent', vOpp];
}

// ── 庄家求解器（常驻 Worker 池） ──────────────────────────────────────────────

// 常驻求解器 Worker 池：memo（查表）跨回合常驻，同局面直接命中缓存。
// 池大小见 SOLVER_POOL_SIZE（50% 核数上限，自适应）；按需惰性扩容——
// 单局场景只用 1 个 Worker（省内存），并发解算（多局同时）才补满到上限分摊多核。
// 说明：求解器是 IDDFS+memo 顺序递归，单次硬解算的墙钟由最慢分支的深度需求决定，
// 核多不缩短单次解算——池的收益在「并发解算不排队」。
let dealerPool = []; // 存活的 worker 实例（dealerAlive / dealerInflight 挂在实例上）
let dealerWorkerSeq = 0;
const dealerPending = new Map(); // seq -> { resolve, worker, watchdog }
const dealerAffinity = new Map(); // gameId -> worker（按局黏着：同局复用同一 worker，memo 同局最热）

function spawnDealerWorker() {
    let worker;
    try {
        worker = new Worker(SOLVER_WORKER_PATH);
    } catch (error) {
        logDiscordFailure(null, 'dealer-solver-spawn', error);
        return null;
    }
    worker.dealerAlive = true;
    worker.dealerInflight = 0; // 该 worker 当前在途请求数（分发用）
    worker.on('message', msg => {
        if (!msg || typeof msg.seq !== 'number') return;
        worker.dealerInflight = Math.max(0, worker.dealerInflight - 1);
        const entry = dealerPending.get(msg.seq);
        if (entry) {
            dealerPending.delete(msg.seq);
            clearTimeout(entry.watchdog);
            entry.resolve(msg.result ?? null);
        }
    });
    worker.on('error', err => failDealerWorker(worker, err));
    worker.on('exit', code => {
        if (code !== 0) failDealerWorker(worker, new Error(`dealer solver worker exited (${code})`));
    });
    return worker;
}

function failDealerWorker(worker, error) {
    // 该 worker 的在途请求全部放行（fail-open：走启发式兜底），并从池中摘除；下次分发时惰性重建。
    worker.dealerAlive = false;
    dealerPool = dealerPool.filter(w => w !== worker);
    // 清除指向该 worker 的黏着记录（避免死引用）。
    for (const [gameId, w] of dealerAffinity) {
        if (w === worker) dealerAffinity.delete(gameId);
    }
    for (const [seq, entry] of dealerPending) {
        if (entry && entry.worker === worker) {
            dealerPending.delete(seq);
            clearTimeout(entry.watchdog);
            entry.resolve(null);
        }
    }
    worker.terminate().catch(() => {});
    if (error) logDiscordFailure(null, 'dealer-solver-worker', error);
}

function acquireDealerWorker(gameId) {
    // 按局黏着：同局优先复用它上次用的 worker（空闲时绝不换）——memo 跨回合/跨对局最热，
    // 避免并发多局时同一局在多个 worker 间跳动导致缓存打散。
    const preferred = gameId != null ? dealerAffinity.get(gameId) : null;
    if (preferred && preferred.dealerAlive && preferred.dealerInflight === 0) {
        return preferred;
    }
    // ① 优先空闲 worker：单局场景始终复用同一个。
    for (const w of dealerPool) {
        if (w.dealerAlive && w.dealerInflight === 0) return w;
    }
    // ② 全忙但池未满 → 惰性扩容一个。
    if (dealerPool.length < SOLVER_POOL_SIZE) {
        const w = spawnDealerWorker();
        if (w) {
            dealerPool.push(w);
            return w;
        }
    }
    // ③ 池已满 → 用最闲的排队。
    let best = null;
    for (const w of dealerPool) {
        if (w.dealerAlive && (best === null || w.dealerInflight < best.dealerInflight)) best = w;
    }
    return best;
}

function terminateDealerPool() {
    for (const w of dealerPool) {
        w.dealerAlive = false;
        w.terminate().catch(() => {});
    }
    dealerPool = [];
    dealerPending.clear();
    dealerAffinity.clear();
}

function solveDealer(state, gameId) {
    return new Promise(resolve => {
        const playerId = state.currentPlayerId;
        if (playerId == null) {
            resolve(null);
            return;
        }
        const opponent = state.other(playerId);
        const cfg = state.gameCfg();
        const workerData = {
            myHp: state.hp[playerId],
            oppHp: state.hp[opponent],
            myItems: [...state.items[playerId]].sort(),
            oppItems: [...state.items[opponent]].sort(),
            saw: state.sawArmed,
            myCuffed: state.handcuffed.has(playerId),
            oppCuffed: state.handcuffed.has(opponent),
            live: state.liveRemaining,
            blank: state.blankRemaining,
            known: knownIntelFor(state, playerId),
            // P3：对手私有情报带（人类用放大镜/手机看到的弹位，庄家看不到）。
            oppKnown: knownIntelFor(state, opponent),
            hpCap: cfg.hp,
            shellsLo: cfg.shells[0],
            shellsHi: cfg.shells[1],
            maxMs: SOLVER_MAX_MS,
            startBudget: SOLVER_START_BUDGET,
            depthLimit: 100,
        };
        const worker = acquireDealerWorker(gameId);
        if (!worker) {
            resolve(null);
            return;
        }
        if (gameId != null) dealerAffinity.set(gameId, worker);
        const seq = ++dealerWorkerSeq;
        // 看门狗：求解器僵死（线程卡死/消息丢失）时兜底放行，避免庄家回合永久悬挂；
        // 只处置这台 worker（其余 worker 的请求不受影响）。成功返回时随消息清理。
        const watchdog = setTimeout(() => {
            if (dealerPending.has(seq)) {
                logDiscordFailure(null, 'dealer-solver-watchdog', new Error('solver exceeded hard window'));
                failDealerWorker(worker, null);
            }
            resolve(null);
        }, (workerData.maxMs || 10_000) + 5_000);
        watchdog.unref?.();
        dealerPending.set(seq, { resolve, worker, watchdog });
        worker.dealerInflight += 1;
        worker.postMessage({ seq, ...workerData });
    });
}

// ── 会话 ──────────────────────────────────────────────────────────────────────

class DevilRouletteGame {
    constructor({
        mode,
        initiatorId,
        channel,
        guild,
        targetId = null,
        botOpponentId = null,
        rng = null,
    }) {
        this.type = 'devil_roulette';
        this.id = randomUUID().toString().replace(/-/g, '').slice(0, 12);
        this.mode = mode;
        this.initiatorId = initiatorId;
        this.targetId = targetId;
        this.botOpponentId = botOpponentId;
        this.channel = channel;
        this.guild = guild;
        this.guildId = guild?.id || null;
        this.channelId = channel?.id || null;
        this.autoIds = new Set();
        this.participants = [initiatorId];
        if (targetId != null) this.participants.push(targetId);
        if (botOpponentId != null) {
            this.participants.push(botOpponentId);
            this.autoIds.add(botOpponentId);
        }
        this.participantIds = [...this.participants];

        this.status = mode === 'pve' ? 'playing' : 'challenge';
        this.state = null;
        this.rng = rng || null;
        if (this.status === 'playing') {
            this.state = new DevilState(this.participants, {
                rng: this.rng || defaultRng(),
                alternateFirstTurn: mode === 'pvp',
            });
        }

        this.panels = [];
        this.timers = new Set();
        this.turnTimer = null;
        this.lastEvent = '';
        this.finalWinnerId = null;
        this.penaltyPending = false;
        this.penaltyApplied = false;
        // 结算自动施罚定时器是否已武装（防刷新无限重置）。
        this.settlementArmed = false;
        // 主交互面板是否已建立。PvE 开局先发「对局开始」播报面板，若主面板发送失败，
        // 不能再靠 panels.length===0 判断（播报面板占了一位）——必须据它 teardown，否则游戏隐形空转。
        this.mainPanelSent = false;
        // 断连接续标记：restore 恢复回来的首张主面板标题带「断连接续」提醒，下次新发面板时清除。
        this.resumed = false;
        // 连续「打自己空弹保回合」合并面板：同一开枪回合原地编辑新增（同道具聚合），避免连续空枪刷屏。
        this.selfShotPanel = null;
        this.selfShotBlocks = [];
        // 惩罚口径：normal（正常终局，禁言5/改名10）或 surrender（认输，禁言3/改名7）。
        this.penaltyScope = 'normal';
        // 已用 <@id> 提示过的行动者（用于回合切换只 ping 一次）。
        this.announcedPlayer = null;
        // 本次新面板是否处于回合切换（决定 allowed_mentions 是否 ping 当前行动者）。
        this.pingCurrentTurn = false;
        // 「道具使用」面板内容：同一开枪回合内逐块累积。
        this.itemUsageLog = [];
        // 当前开枪回合的「道具使用」面板。
        this.itemPanelEntry = null;
        // 面板颜色随上一动作变化。
        this.panelColor = 0xE67E22;
        this.closed = false;
        this.released = false;
        // 求解器选中的肾上腺素偷取目标。
        this.solverStealKey = null;
        // 庄家回合面板展示起点（最低行动窗口 DEALER_MIN_THINK_MS 用）。
        this.dealerPanelAt = 0;
        this.ended = false;
        if (this.state != null) this.lastEvent = this.openingEvent();
    }

    // ── 派生 ──

    get title() {
        return '😈 恶魔轮盘';
    }

    get isPve() {
        return this.mode === 'pve';
    }

    isAuto(userId) {
        return this.autoIds.has(userId);
    }

    shortName(userId) {
        return mention(userId);
    }

    plainName(userId) {
        const member = this.guild?.members?.cache?.get(userId);
        const name = member?.displayName;
        return name || `玩家${userId}`;
    }

    roleName(userId) {
        if (!this.isPve || !this.state) return '';
        return userId === this.state.players[1] ? '庄家' : '玩家';
    }

    modeText() {
        // 当前规则：一局定胜负（血量 4 / 弹巢 5-8 发）。
        return '一局定胜负';
    }

    openingEvent() {
        const current = this.state?.currentPlayerId;
        if (current == null) return '';
        return `🎲 随机先手：**${this.shortName(current)}**。`;
    }

    // ── 断连接续 ──

    serializeGame() {
        return {
            v: 1,
            id: this.id,
            guildId: this.guildId,
            channelId: this.channelId,
            mode: this.mode,
            initiatorId: this.initiatorId,
            targetId: this.targetId,
            botOpponentId: this.botOpponentId,
            participants: this.participants,
            autoIds: [...this.autoIds],
            status: this.status,
            lastEvent: this.lastEvent,
            panelColor: this.panelColor,
            finalWinnerId: this.finalWinnerId,
            penaltyPending: this.penaltyPending,
            penaltyApplied: this.penaltyApplied,
            panelIds: this.panels.map(entry => entry?.message?.id).filter(Boolean),
            state: this.state ? this.state.serialize() : null,
        };
    }

    persistNow() {
        // 对局快照落盘（断连接续）。写操作内部串行排队，异步完成，不阻塞渲染。
        if (this.released) return;
        try {
            resumeStore.save(this.id, this.serializeGame());
        } catch (error) {
            logDiscordFailure(this, 'resume-persist', error);
        }
    }

    deletePersisted() {
        try {
            resumeStore.remove(this.id);
        } catch (error) {
            logDiscordFailure(this, 'resume-delete', error);
        }
    }

    // 从快照重建对局实例（保留原 gameId，旧面板按钮仍能命中）。
    static restore(snapshot, { guild, channel }) {
        const game = new DevilRouletteGame({
            mode: snapshot.mode,
            initiatorId: snapshot.initiatorId,
            channel,
            guild,
            targetId: snapshot.targetId || null,
            botOpponentId: snapshot.botOpponentId || null,
        });
        game.id = snapshot.id;
        game.status = snapshot.status;
        game.lastEvent = snapshot.lastEvent || '';
        game.panelColor = snapshot.panelColor || 0x8E44AD;
        game.finalWinnerId = snapshot.finalWinnerId || null;
        game.penaltyPending = !!snapshot.penaltyPending;
        game.penaltyApplied = !!snapshot.penaltyApplied;
        game.settlementArmed = false;
        game.participants = Array.isArray(snapshot.participants) ? [...snapshot.participants] : game.participants;
        game.participantIds = [...game.participants];
        game.autoIds = new Set(snapshot.autoIds || []);
        game.state = snapshot.state ? DevilState.restore(snapshot.state) : null;
        game.resumed = true; // 断连接续标记：恢复后的首张主面板标题提醒。
        return game;
    }

    // ── 生命周期 ──

    async open() {
        // PvE 直接开局：随机先手单独发一张播报面板，主面板保持干净。
        if (this.mode === 'pve' && this.lastEvent) {
            await this.sendBroadcastLocked({ title: '🎲 对局开始' });
        }
        const ok = await this.renderLocked();
        return ok;
    }

    async acceptChallenge(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        let changed = false;
        let rejection = null;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'challenge') {
                rejection = '这个挑战已经结束了。';
                return;
            }
            if (interaction.user?.id === this.initiatorId) {
                rejection = '发起人不能自己应战。';
                return;
            }
            if (this.targetId != null && interaction.user?.id !== this.targetId) {
                rejection = '只有被挑战的人可以接受。';
                return;
            }
            if (interaction.user?.bot) {
                rejection = '机器人不能应战。';
                return;
            }
            const isPublic = this.targetId == null;
            // 公屏擂台：应战者第一次进来要占玩家锁，并补进参与者。
            if (isPublic) {
                if (!this.participants.includes(interaction.user.id)) {
                    if (!gameManager.addPlayer(this, interaction.user.id)) {
                        rejection = '你已经在另一场游戏里了。';
                        return;
                    }
                    this.participants.push(interaction.user.id);
                }
                this.targetId = interaction.user.id;
            }
            this.startLocked();
            this.lastEvent = `⚔️ **${this.shortName(interaction.user.id)}** ${
                isPublic ? '应战' : '接受了挑战'
            }，恶魔轮盘开始。\n${this.openingEvent()}`;
            changed = true;
        });
        if (rejection) {
            await sendComponentError(interaction, rejection);
            return;
        }
        if (!changed) {
            await sendComponentError(interaction, '这个挑战已经结束了。');
            return;
        }
        await this.sendBroadcastLocked({ title: '⚔️ 对局开始' });
        await this.renderLocked();
        try {
            // 冷却只记在发起人头上：接受者只是应约，不该被罚 30 分钟冷却。
            this.onGameStarted?.([this.initiatorId]);
        } catch (error) {
            logDiscordFailure(this, 'on-game-started', error, this.initiatorId);
        }
        await confirmComponent(interaction, '✅ 你应战了，恶魔轮盘开始。');
    }

    async declineChallenge(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        let changed = false;
        let rejection = null;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'challenge') {
                rejection = '这个挑战已经结束了。';
                return;
            }
            if (interaction.user?.id !== this.targetId) {
                rejection = '只有被挑战的人可以拒绝。';
                return;
            }
            this.status = 'ended';
            this.lastEvent = `🏳️ **${this.shortName(interaction.user.id)}** 拒绝了挑战。`;
            changed = true;
        });
        if (rejection) {
            await sendComponentError(interaction, rejection);
            return;
        }
        await this.renderLocked();
        await confirmComponent(interaction, '🏳️ 你拒绝了挑战。');
    }

    async cancelByInitiator(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        let changed = false;
        let rejection = null;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'challenge') {
                rejection = '这局已经开始，不能取消。';
                return;
            }
            if (interaction.user?.id !== this.initiatorId) {
                rejection = '只有发起人可以取消。';
                return;
            }
            this.status = 'ended';
            this.lastEvent = '🛑 发起人取消了这局游戏。';
            changed = true;
        });
        if (rejection) {
            await sendComponentError(interaction, rejection);
            return;
        }
        await this.renderLocked();
        await confirmComponent(interaction, '🛑 你取消了这局游戏。');
    }

    async act(interaction, action, expectedToken, { stealKey = null } = {}) {
        // 按钮立即完成（deferUpdate），不产生 thinking；反馈是公屏新面板。
        if (!await deferComponent(interaction, { ephemeral: false })) return;
        let result = null;
        let rejection = null;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'playing' || !this.state) {
                rejection = EXPIRED_MESSAGE;
                return;
            }
            if (!this.isAuto(interaction.user?.id) && interaction.user?.id !== this.state.currentPlayerId) {
                rejection = NOT_YOUR_TURN_MESSAGE;
                return;
            }
            try {
                result = this.state.apply(action, interaction.user.id, { expectedToken, stealKey });
            } catch (error) {
                if (error instanceof InvalidAction) {
                    rejection = error.message;
                    return;
                }
                logDiscordFailure(this, 'act', error, interaction.user?.id);
                rejection = ACT_FAILED_MESSAGE;
            }
        });
        if (rejection) {
            await sendComponentError(interaction, rejection);
            return;
        }
        if (!result) {
            await sendComponentError(interaction, ACT_FAILED_MESSAGE);
            return;
        }
        await this.afterActionLocked(result);
        if (result.reveal) {
            await this.sendPrivateIntel(interaction);
        }
    }

    async showPrivateState(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        let rejection = null;
        let embed = null;
        await gameManager.runExclusive(this, () => {
            if (!this.state || !['playing', 'ended'].includes(this.status)) {
                rejection = '这局还没有可查看的私有情报。';
                return;
            }
            if (!this.state.players.includes(interaction.user?.id)) {
                rejection = '私有情报只属于本局玩家。';
                return;
            }
            embed = this.privateEmbed(interaction.user.id);
        });
        if (rejection) {
            await sendComponentError(interaction, rejection);
            return;
        }
        await sendEphemeral(interaction, {
            embeds: [embed],
            components: this.privateIntelRefreshRows(),
        });
    }

    async showItemHelp(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        const embed = new EmbedBuilder()
            .setTitle('🎁 道具简介')
            .setColor(0x5865F2)
            .setAuthor({ name: `${this.title} · 仅你可见` });
        const lines = ITEM_KEYS.map(key =>
            `${ITEM_DEFS[key].emoji} **${ITEM_DEFS[key].name}**——${ITEM_HELP_SHORT[key]}`);
        embed.setDescription(lines.join('\n'));
        embed.setFooter({ text: `每人上限 ${MAX_ITEM_SLOTS} 件 · 轮到你时可先用道具再开枪，不消耗回合` });
        await sendEphemeral(interaction, {
            embeds: [embed],
            components: this.privateIntelViewRows(interaction.user?.id),
        });
    }

    async hintCurrentTurn(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        let hint = null;
        let rejection = null;
        await gameManager.runExclusive(this, () => {
            const state = this.state;
            if (!state || this.status !== 'playing') {
                rejection = '这局还没有开始或已经结束了。';
                return;
            }
            const current = state.currentPlayerId;
            if (current == null) {
                rejection = '还没有当前行动者。';
                return;
            }
            if (interaction.user?.id === current) {
                hint = `✅ 现在是你的回合，请在 ⏱ ${TURN_SECONDS + GRACE_SECONDS} 秒内行动：\n`
                    + '　🔫 **打对手** —— 实弹命中扣对方 1 血，空弹白白送回合；\n'
                    + '　💀 **打自己** —— 空弹保住回合，实弹自己挨枪；\n'
                    + '　🎁 道具按钮、📜 我的情报都在下方，按需使用。';
            } else {
                hint = `⏳ 现在轮到 **${this.plainName(current)}**，`
                    + '请等待 TA 行动；轮到你时会自动切换面板。';
            }
        });
        if (rejection) {
            await sendComponentError(interaction, rejection);
            return;
        }
        await sendEphemeral(interaction, { content: hint });
    }

    async sendPrivateIntel(interaction) {
        let embed = null;
        await gameManager.runExclusive(this, () => {
            if (!this.state || !this.state.players.includes(interaction.user?.id)) return;
            embed = this.privateEmbed(interaction.user.id);
        });
        if (embed) {
            await sendEphemeral(interaction, {
                embeds: [embed],
                components: this.privateIntelRefreshRows(),
            });
        }
    }

    // 手机只剩一发时的"被禁用"按钮点击：解释为什么不可用（仅自己可见）。
    // 只剩一发时实弹/空弹数在面板上明摆着，手机无从剧透——文案走庄家的荒诞俏皮调子，
    // 顺带说明手机机制：只能探测「往后」的未来弹位。
    async showPhoneBlocked(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        await sendComponentError(
            interaction,
            '📱 只剩最后一发——是什么子弹，弹巢已经不打自招。\n（手机只能探测「往后」的未来弹位，此刻已无未来可探。）'
        );
    }

    // 「📜 我的情报」附带的「🔄 刷新当前面板」：强制重渲染当前主面板。
    // 面板按钮异常/缺失时的恢复手段——点击后发一张带最新状态与按钮的新面板。
    privateIntelRefreshRows() {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_devil_roulette_refresh:${this.id}`)
                .setLabel('🔄 刷新当前面板')
                .setStyle(ButtonStyle.Secondary)
        );
        return [row];
    }

    async refreshPanel(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        let allowed = false;
        await gameManager.runExclusive(this, () => {
            if (['playing', 'ended'].includes(this.status) && this.state) allowed = true;
        });
        if (!allowed) {
            await sendComponentError(interaction, '这局还没有可刷新的活动面板。');
            return;
        }
        // 强制重渲染当前面板（人类回合会带上开枪按钮；旧面板按钮被禁用）。
        const ok = await this.renderLocked();
        await sendEphemeral(interaction, {
            content: ok ? '🔄 已刷新当前面板。' : '🔄 面板刷新失败，请稍后再试。',
        });
    }

    async surrender(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        let changed = false;
        let rejection = null;
        let loserId = null;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'playing' || !this.state) {
                rejection = '这局还没开始或已经结束了。';
                return;
            }
            if (!this.state.players.includes(interaction.user?.id) || this.isAuto(interaction.user?.id)) {
                rejection = '只有对局里的真人玩家可以认输。';
                return;
            }
            if ((this.state.hp[interaction.user.id] || 0) <= SURRENDER_MIN_HP) {
                rejection = `血量仅剩 ${SURRENDER_MIN_HP} 点，这一枪必须打完。`;
                return;
            }
            loserId = interaction.user.id;
            this.status = 'ended';
            this.finalWinnerId = this.state.other(loserId);
            this.penaltyScope = 'surrender';
            this.panelColor = 0x8E44AD;
            this.lastEvent = `🏳️ **${this.shortName(loserId)}** 认输了。\n${flavor('surrender')}`;
            changed = true;
        });
        if (rejection) {
            await sendComponentError(interaction, rejection);
            return;
        }
        if (!changed) {
            await sendComponentError(interaction, '这局还没开始或已经结束了。');
            return;
        }
        if (this.isAuto(this.finalWinnerId)) {
            // PvE 认输给庄家：判负，计入战绩 + 施亡魂改名惩罚（8 分钟）。
            this.recordPveResultIfHuman();
            const line = await this.applyPveGhostPenalty(loserId);
            this.penaltyApplied = true;
            this.lastEvent += `\n${line}`;
        } else {
            // PvP：胜者（真人）选 禁言 3 / 改名 7。
            this.penaltyPending = true;
        }
        await this.renderLocked();
        await confirmComponent(interaction, '🏳️ 你认输了，恶魔轮盘结束。');
    }

    async onGameEndedLocked() {
        // 终局统一处理：PvE 记录真人玩家战绩、庄家赢则自动施「亡魂」改名惩罚；PvP 由胜者自选。
        const state = this.state;
        const winnerId = this.finalWinnerId;
        if (!state || winnerId == null) {
            return;
        }
        if (this.mode === 'pve') {
            // PvE：记录战绩（真人玩家视角，胜/负全局累计）。
            this.recordPveResultIfHuman();
            // PvE 庄家赢：她直接定了，自动改名「恶魔枪下的第 N 名亡魂」（N=全局亡魂号，数据库永久累计）。
            if (this.isAuto(winnerId)) {
                const line = await this.applyPveGhostPenalty(state.other(winnerId));
                if (line) this.lastEvent += `\n${line}`;
            }
            return;
        }
        const loserId = state.other(winnerId);
        if (this.isAuto(loserId)) {
            return; // 输的是 bot/虚拟玩家，无惩罚
        }
        // PvP：胜者是真人，等他自己按按钮选择惩罚。
        this.penaltyPending = true;
    }

    armSettlementTimeoutLocked() {
        // 幂等：胜者 30 秒未选才自动禁言。刷新面板/重渲染会重复调用——
        // 若每次都重置，败者可用「🔄 刷新」无限拖延自动施罚。只武装一次。
        if (this.settlementArmed) return;
        this.settlementArmed = true;
        this.cancelTimerLocked();
        this.turnTimer = this.schedule(
            () => this.settlementTimeout().catch(error => logDiscordFailure(this, 'settlement-timeout', error)),
            PENALTY_SETTLEMENT_SECONDS * 1000
        );
    }

    async settlementTimeout() {
        let act = false;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'ended' || this.penaltyApplied || !this.penaltyPending) return;
            act = true;
        });
        if (act) await this.autoPenaltyLocked();
    }

    async autoPenaltyLocked() {
        // 胜者 30 秒未选择：自动禁言输家 5 分钟。
        const state = this.state;
        const winnerId = this.finalWinnerId;
        if (!state || winnerId == null) return;
        let proceed = false;
        // 在临界区内「认领」惩罚（先置位再做网络 I/O），否则与胜者手点 finalizePenalty 竞态，
        // 双方都通过检查 → 输家被同时禁言+改名。
        await gameManager.runExclusive(this, () => {
            if (this.penaltyApplied || !this.penaltyPending) return;
            this.penaltyApplied = true;
            this.penaltyPending = false;
            proceed = true;
        });
        if (!proceed) return;
        const loserId = state.other(winnerId);
        const [, line] = await this.applyPenaltyAndNarrate(loserId, 'mute', {
            minutes: PENALTY_AUTO_MUTE_MINUTES,
        });
        this.lastEvent += `\n${line}（胜者未在 ${PENALTY_SETTLEMENT_SECONDS} 秒内选择，自动施罚）`;
        await this.renderLocked();
    }

    async applyPenaltyAndNarrate(loserId, penaltyType, { nickname = null, minutes = null } = {}) {
        let ok = false;
        let message = '';
        try {
            [ok, message] = await this.applyPenalty(this.guild, loserId, penaltyType, { nickname, minutes });
        } catch (error) {
            logDiscordFailure(this, 'penalty', error, loserId);
            ok = false;
            message = '惩罚调用异常';
        }
        if (ok) return [true, `🔒 败者 **${this.shortName(loserId)}**：${message}`];
        return [false, `⚠️ 败者 **${this.shortName(loserId)}** 惩罚未生效：${message}`];
    }

    async applyPveGhostPenalty(loserId) {
        // PvE 失败惩罚：把败者改名为「恶魔枪下的第 N 名亡魂」（N=数据库永久累计的全局亡魂号），
        // 持续 PVE_GHOST_RENAME_MINUTES 分钟，到期由昵称锁自动改回（重启后也会按持久化记录恢复）。
        if (this.isAuto(loserId)) return null; // bot/虚拟玩家不受惩罚
        let deathNo = 0;
        try {
            deathNo = incrementDevilRouletteDeathCount();
        } catch (error) {
            logDiscordFailure(this, 'pve-death-counter', error, loserId);
        }
        const nickname = deathNo >= 1 ? `恶魔枪下的第 ${deathNo} 名亡魂` : PENALTY_NICKNAME;
        const [, line] = await this.applyPenaltyAndNarrate(loserId, 'rename', {
            nickname,
            minutes: PVE_GHOST_RENAME_MINUTES,
        });
        return line;
    }

    recordPveResultIfHuman() {
        // PvE 战绩记录（真人玩家视角，胜/负全局累计）。认输、庄家赢、玩家赢都走这里。
        const state = this.state;
        if (!state || this.finalWinnerId == null) return;
        const humanId = state.players.find(id => !this.isAuto(id));
        if (humanId == null) return;
        try {
            recordDevilRoulettePveResult(humanId, this.finalWinnerId === humanId);
        } catch (error) {
            logDiscordFailure(this, 'pve-stats-record', error, humanId);
        }
    }

    async finalizePenalty(interaction, penaltyType, nickname) {
        // 胜者点击惩罚按钮后执行（PvP）。网络 I/O + 面板刷新，异常不抛出。
        const deferred = await deferComponent(interaction, { ephemeral: true });
        // 交互无法确认（超 3s 或 Discord 拒收）→ 不施罚，避免静默生效且胜者无反馈。
        if (!deferred) return;
        let rejection = null;
        let ok = false;
        let loserId = null;
        await gameManager.runExclusive(this, () => {
            const state = this.state;
            const winnerId = this.finalWinnerId;
            if (this.status !== 'ended' || !state || winnerId == null) {
                rejection = '这局已经结束。';
                return;
            }
            if (this.penaltyApplied) {
                rejection = '败者惩罚已经处理过了。';
                return;
            }
            if (interaction.user?.id !== winnerId) {
                rejection = '只有胜利者可以决定败者的惩罚。';
                return;
            }
            // 临界区内认领惩罚，避免与 settlementTimeout 自动禁言竞态（同局被禁言+改名）。
            this.penaltyApplied = true;
            this.penaltyPending = false;
            loserId = state.other(winnerId);
        });
        if (rejection) {
            await sendComponentError(interaction, rejection);
            return;
        }
        if (loserId == null) {
            await sendComponentError(interaction, '这局已经结束。');
            return;
        }
        const [muteMin, renameMin] = this.penaltyMinutes();
        const minutes = penaltyType === 'mute' ? muteMin : renameMin;
        let line = null;
        [ok, line] = await this.applyPenaltyAndNarrate(loserId, penaltyType, { nickname, minutes });
        if (!ok) {
            // 惩罚未生效（如 Discord 拒收昵称）：放开认领，让 30s 自动禁言兜底或胜者重试，避免输家逃罚。
            await gameManager.runExclusive(this, () => {
                if (this.status === 'ended' && this.penaltyApplied) {
                    this.penaltyApplied = false;
                    this.penaltyPending = true;
                }
            });
        }
        // 惩罚结果拼进叙述（last_event += line，结算面板可见）。
        if (line) this.lastEvent += `\n${line}`;
        await this.renderLocked();
        await sendEphemeral(
            interaction,
            { content: ok ? '✅ 败者惩罚已施加。' : '❌ 败者惩罚未能施加，请稍后重试。' }
        );
    }

    async chooseMutePenalty(interaction) {
        await this.finalizePenalty(interaction, 'mute', null);
    }

    async chooseRenamePenalty(interaction, nickname) {
        await this.finalizePenalty(interaction, 'rename', nickname);
    }

    async openRenameModal(interaction) {
        // 改名按钮：校验胜者后弹出昵称输入对话框。
        // 纯读取校验不走 runExclusive——那是慢路径，交互超 3s 未响应会被 Discord 丢弃 Modal。
        // 真正变更在提交时 finalizePenalty 内再上锁复检（此处读到的是瞬间快照，竞态由复检兜底）。
        const state = this.state;
        const winnerId = this.finalWinnerId;
        if (this.status !== 'ended' || !state || winnerId == null) {
            await deferComponent(interaction, { ephemeral: true });
            await sendComponentError(interaction, '这局已经结束。');
            return;
        }
        if (this.penaltyApplied) {
            await deferComponent(interaction, { ephemeral: true });
            await sendComponentError(interaction, '败者惩罚已经处理过了。');
            return;
        }
        if (interaction.user?.id !== winnerId) {
            await deferComponent(interaction, { ephemeral: true });
            await sendComponentError(interaction, '只有胜利者可以决定败者的惩罚。');
            return;
        }
        const input = new TextInputBuilder()
            .setCustomId('devil_roulette_rename_input')
            .setLabel('要给败者改成的昵称（最多 32 字）')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(32)
            .setPlaceholder('例如：🔒 恶魔轮盘输家');
        const modal = new ModalBuilder()
            .setCustomId(`${RENAME_MODAL_PREFIX}:${this.id}`)
            .setTitle('✏️ 败者改名惩罚')
            .addComponents(new ActionRowBuilder().addComponents(input));
        try {
            await interaction.showModal(modal);
        } catch (error) {
            logDiscordFailure(this, 'show-rename-modal', error, interaction.user?.id);
        }
    }

    // ── 定时器 ──

    schedule(fn, ms) {
        const t = setTimeout(() => {
            this.timers.delete(t);
            fn();
        }, Math.min(ms, 2 ** 31 - 1));
        t.unref?.();
        this.timers.add(t);
        return t;
    }

    cancelTimerLocked() {
        if (this.turnTimer) {
            clearTimeout(this.turnTimer);
            this.timers.delete(this.turnTimer);
            this.turnTimer = null;
        }
    }

    async challengeTimeout() {
        let changed = false;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'challenge') return;
            this.status = 'ended';
            this.lastEvent = '⌛ 挑战超时，决斗面板已失效。';
            changed = true;
        });
        if (changed) await this.renderLocked();
    }

    async turnTimeout(armedToken, { auto }) {
        // 主延迟已由定时器承担（人类含 2s 宽限），此处直接执行。
        let actorId = null;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'playing' || !this.state) return;
            if (this.state.turnToken !== armedToken) return;
            actorId = this.state.currentPlayerId;
        });
        if (actorId == null) return;

        let action = 'shoot_opponent';
        if (auto) {
            // 庄家决策最多等 60s，超时兜底开枪。
            try {
                const solved = await Promise.race([
                    this.autoAction(this.state),
                    sleep(60_000, this.timers).then(() => null),
                ]);
                if (solved) action = solved;
            } catch (error) {
                logDiscordFailure(this, 'auto-action', error);
                action = 'shoot_opponent';
            }
            // 最低行动窗口：算完立即行动，但面板至少展示 DEALER_MIN_THINK_MS 再行动（让人类有时间看）。
            const minActAt = (this.dealerPanelAt || 0) + DEALER_MIN_THINK_MS;
            const holdMs = minActAt - Date.now();
            if (holdMs > 0) await sleep(holdMs, this.timers);
        }
        let stealKey = null;
        if (action === 'adrenaline') {
            stealKey = this.solverStealKey;
            this.solverStealKey = null;
        }
        let result = null;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'playing' || !this.state) return;
            if (this.state.turnToken !== armedToken) return;
            try {
                result = this.state.apply(action, actorId, { expectedToken: armedToken, stealKey });
            } catch (error) {
                if (!(error instanceof InvalidAction)) throw error;
                try {
                    result = this.state.apply('shoot_opponent', actorId, { expectedToken: armedToken });
                } catch (error2) {
                    if (!(error2 instanceof InvalidAction)) throw error2;
                }
            }
        });
        if (result) await this.afterActionLocked(result);
        else await this.armTimerLocked();
    }

    async autoAction(state) {
        // 庄家决策：求解器 Worker 取期望最优；失败回退启发式。
        let solved = null;
        try {
            solved = await solveDealer(state, this.id);
        } catch (error) {
            logDiscordFailure(this, 'auto-action-solver', error);
            solved = null;
        }
        if (solved && solved.action) {
            if (solved.action === 'adrenaline' && solved.steal) this.solverStealKey = solved.steal;
            return solved.action;
        }
        return this.autoActionHeuristic(state);
    }

    autoActionHeuristic(state) {
        // 启发式兜底：只在求解器不可用时用（阈值策略 + 纯开枪 minimax）。
        const actorId = state.currentPlayerId;
        if (actorId == null) return 'shoot_opponent';
        const opponent = state.other(actorId);
        const items = state.items[actorId];
        const maxHp = state.gameCfg().hp;
        const myHp = state.hp[actorId];
        const oppHp = state.hp[opponent];

        const known = state.knownShells[actorId] || {};
        const nextKnown = known[state.pointer];

        const total = state.totalRemaining;
        if (total <= 0) return 'shoot_opponent';
        const live = state.liveRemaining;
        const blank = state.blankRemaining;
        const pLive = live / total;

        // ① 当前弹已知：实弹必中打对手（先上锯翻倍）；空弹先回血/保锯再打自己。
        if (nextKnown !== undefined) {
            if (nextKnown) {
                if (items.includes('saw') && !state.sawArmed) return 'saw';
                return 'shoot_opponent';
            }
            if (myHp < maxHp) {
                if (items.includes('cigarette')) return 'cigarette';
                if (items.includes('medicine') && myHp <= maxHp - 2) return 'medicine';
            }
            if (state.sawArmed && items.includes('beer') && total > 1) return 'beer';
            return 'shoot_self';
        }

        // ② 情报推导（手机/放大镜的私有情报派上用场）。
        let futureLives = 0;
        let futureBlanks = 0;
        for (const [idx, shell] of Object.entries(known)) {
            if (Number(idx) > state.pointer && shell) futureLives++;
            else if (Number(idx) > state.pointer && !shell) futureBlanks++;
        }
        if (futureLives && futureLives === live) return 'shoot_self';
        if (futureBlanks && futureBlanks === blank) {
            if (items.includes('saw') && !state.sawArmed) return 'saw';
            return 'shoot_opponent';
        }

        // ③ 手锯已上膛：不再磨蹭，直接对对手开枪。
        if (state.sawArmed) return 'shoot_opponent';

        // ④ 放大镜：免费情报，先用。
        if (items.includes('magnifier')) return 'magnifier';

        // ⑤ 啤酒：顶掉高概率实弹。
        if (items.includes('beer') && pLive >= 0.6) return 'beer';

        // ⑥ 对手残血：终结优先（残 2 血且持锯 → 先锯，下一发实弹一击必杀）。
        if (oppHp <= 2) {
            if (items.includes('saw') && oppHp === 2 && !state.sawArmed) return 'saw';
            return _bestShoot(live, blank, myHp, oppHp)[0];
        }

        // ⑦ 高概率实弹：上锯强打。
        if (pLive >= 0.55) {
            if (items.includes('saw') && !state.sawArmed) return 'saw';
            return 'shoot_opponent';
        }

        // ⑧ 低概率实弹：走打自己路线（空弹保回合），先护航。
        if (items.includes('handcuffs') && !state.handcuffed.has(opponent)) return 'handcuffs';
        if (myHp < maxHp) {
            if (items.includes('cigarette')) return 'cigarette';
            if (items.includes('medicine') && myHp <= maxHp - 2) return 'medicine';
        }
        if (items.includes('inverter') && pLive <= 0.45) return 'inverter';
        if (items.includes('phone') && total > 1) return 'phone';
        if (items.includes('adrenaline') && state.items[opponent].some(i => i !== 'adrenaline')) {
            return 'adrenaline';
        }

        // ⑨ 纯开枪博弈：minimax 最优解。
        return _bestShoot(live, blank, myHp, oppHp)[0];
    }

    startLocked() {
        this.status = 'playing';
        this.state = new DevilState(this.participants, {
            rng: this.rng || defaultRng(),
            alternateFirstTurn: this.mode === 'pvp',
        });
    }

    armTimerLocked() {
        this.cancelTimerLocked();
        if (this.status === 'challenge') {
            this.turnTimer = this.schedule(
                () => this.challengeTimeout().catch(error => logDiscordFailure(this, 'challenge-timeout', error)),
                CHALLENGE_SECONDS * 1000
            );
        } else if (this.status === 'playing' && this.state) {
            const token = this.state.turnToken;
            const current = this.state.currentPlayerId;
            const auto = current != null && this.isAuto(current);
            if (auto) this.dealerPanelAt = Date.now(); // 庄家面板展示起点（最低行动窗口）
            const delayMs = (auto ? AUTO_THINK_SECONDS : TURN_SECONDS) * 1000 + (auto ? 0 : GRACE_SECONDS * 1000);
            this.turnTimer = this.schedule(
                () => this.turnTimeout(token, { auto }).catch(error => logDiscordFailure(this, 'turn-timeout', error)),
                delayMs
            );
        }
    }

    // ── 渲染 ──

    ensureReleased() {
        // 终局但胜者还没选惩罚（结算待定）：暂不释放，惩罚落定后再释放。
        if (this.status === 'ended' && this.penaltyPending && !this.penaltyApplied) return;
        if (this.released) return;
        this.released = true;
        this.disableAllComponents();
        activeGames.delete(this);
        this.settlementArmed = false;
        dealerAffinity.delete(this.id); // 对局结束：释放它占用的求解器 Worker 黏着记录
        this.deletePersisted();
        return gameManager.cleanupGame(this);
    }

    teardownNoSend() {
        this.status = 'ended';
        this.cancelTimerLocked();
        this.ensureReleased();
    }

    async afterActionLocked(result) {
        // 动作提交后的统一分流：终局→结算面板；道具→道具面板+主面板同步；开枪→播报+新面板。
        this.lastEvent = this.safeFormatResult(result);
        this.panelColor = this.resultColor(result);
        const boundary = result.action === 'shoot_self'
            || result.action === 'shoot_opponent'
            || result.reloaded
            || result.roundEnded;
        if (result.gameEnded) {
            this.resetItemPanel();
            this.status = 'ended';
            this.finalWinnerId = result.gameWinnerId;
            await this.onGameEndedLocked();
            await this.renderLocked();
        } else if (result.action in ITEM_DEFS) {
            // 道具使用：记录进「道具使用」面板（同一开枪回合内编辑更新）+ 主面板同步道具数。
            this.recordItemUse(result);
            await this.publishItemPanelLocked(result);
            await this.renderItemUseLocked();
            if (boundary) this.resetItemPanel();
        } else {
            if (result.action === 'shoot_self' || result.action === 'shoot_opponent') {
                // 打自己+空弹保回合：同一开枪回合的连续空枪合并进同一张播报面板（原地编辑新增），
                // 主面板也原地刷新不再新发；换手/中弹/轮次结束则断开合并、回到逐张播报。
                // 空枪恰好打空弹巢（reloaded）：重装通知已含在 lastEvent 里，随这发一并并入连击面板，随后断开合并。
                const selfBlank = result.action === 'shoot_self' && !result.hit && !result.roundEnded;
                if (selfBlank) {
                    const n = this.selfShotBlocks.length + 1;
                    this.selfShotBlocks.push(`**第 ${n} 发空枪**　${this.lastEvent}`);
                    await this.mergeSelfShotBroadcastLocked();
                    if (result.reloaded) {
                        this.selfShotBlocks = [];
                        this.selfShotPanel = null;
                    }
                } else {
                    this.selfShotBlocks = [];
                    this.selfShotPanel = null;
                    await this.sendBroadcastLocked({ title: this.broadcastTitle(result) });
                }
            }
            if (boundary) this.resetItemPanel();
            // 空枪保回合（含 PvE 空枪打空弹巢后仍保回合）：主面板原地编辑刷新（同道具使用聚合），不刷一张新面板。
            const keepsTurn = result.action === 'shoot_self' && !result.hit && !result.roundEnded
                && this.state != null && this.state.currentPlayerId === result.actorId;
            if (keepsTurn) {
                await this.refreshMainPanelLocked();
            } else {
                await this.renderLocked();
            }
        }
    }

    async mergeSelfShotBroadcastLocked() {
        // 连续空枪面板：author=游戏名，标题带连击数，正文=逐发叙述块（原地编辑新增）。
        if (!this.selfShotBlocks.length || typeof this.channel?.send !== 'function') return;
        const n = this.selfShotBlocks.length;
        let desc = this.selfShotBlocks.join('\n\n');
        if (this.state) {
            desc += `\n\n**🔫 枪里还剩 ${this.state.totalRemaining} 发**　实弹 ${this.state.liveRemaining} · 空弹 ${this.state.blankRemaining}`;
        }
        const embed = new EmbedBuilder()
            .setAuthor({ name: `${this.title} · ${this.modeText()}` })
            .setColor(this.panelColor)
            .setTitle(`😮‍💨 空枪连击 · 共 ${n} 发`)
            .setDescription(desc)
            .setFooter({ text: '连续打自己空弹保住回合 · 开枪/换手后刷新' });
        const entry = this.selfShotPanel;
        if (entry != null) {
            try {
                await entry.message.edit({
                    embeds: [embed],
                    allowedMentions: { parse: [], users: [], repliedUser: false },
                });
                return;
            } catch (error) {
                logDiscordFailure(this, 'selfshot-panel-edit', error);
                this.selfShotPanel = null;
            }
        }
        let message;
        try {
            message = await this.channel.send({
                embeds: [embed],
                allowedMentions: { parse: [], users: [], repliedUser: false },
            });
        } catch (error) {
            logDiscordFailure(this, 'selfshot-panel-send', error);
            return;
        }
        this.selfShotPanel = { message };
        this.panels.push({ message, interactive: false });
        await this.pruneWindowLocked();
    }

    // 空枪连击结束、新主面板发出后，把连击面板原封复制一份发到主面板下方，
    // 保住连击记录（否则 3 面板窗口滚动会把它挤出视野）。
    // 拷贝发出后 selfShotPanel 改指向拷贝：后续空枪直接编辑这份拷贝，不再另开新面板。
    async rebroadcastSelfShotCombo(sourceMessage) {
        const sourceEmbed = sourceMessage?.embeds?.[0];
        if (!sourceEmbed || typeof this.channel?.send !== 'function') return;
        try {
            const message = await this.channel.send({
                embeds: [EmbedBuilder.from(sourceEmbed)],
                allowedMentions: { parse: [], users: [], repliedUser: false },
            });
            this.selfShotPanel = { message };
            this.panels.push({ message, interactive: false });
            await this.pruneWindowLocked();
        } catch (error) {
            logDiscordFailure(this, 'selfshot-combo-recopy', error);
        }
    }

    broadcastTitle(result) {
        if (result.action === 'shoot_self' || result.action === 'shoot_opponent') {
            if (result.hit) return pickRandom(['💥 实弹命中！', '🔫 正中靶心', '💀 一枪见血']);
            return pickRandom(['😮‍💨 空枪……', '💨 打空了', '🤷 没响，有点尴尬']);
        }
        if (result.roundEnded) return '🔄 洗牌，下一轮';
        if (result.reloaded) return '🔁 重新装填';
        return '🎲 恶魔轮盘';
    }

    async sendBroadcastLocked({ title }) {
        // 把 last_event 的叙述单独发成一张「播报面板」：计入滚动窗口、无按钮、不 ping。
        if (!this.lastEvent) return;
        if (typeof this.channel?.send !== 'function') return;
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setColor(this.panelColor)
            .setAuthor({ name: `${this.title} · ${this.modeText()}` })
            .setDescription(this.lastEvent);
        let message;
        try {
            message = await this.channel.send({
                embeds: [embed],
                allowedMentions: { parse: [], users: [], repliedUser: false },
            });
        } catch (error) {
            logDiscordFailure(this, 'broadcast', error);
            return;
        }
        this.panels.push({ message, interactive: false });
        await this.pruneWindowLocked();
    }

    async disablePreviousButtonsLocked() {
        for (const entry of this.panels) {
            if (!entry.interactive) continue;
            entry.interactive = false;
            try {
                await entry.message.edit({
                    components: [],
                    allowedMentions: { parse: [], users: [], repliedUser: false },
                });
            } catch (error) {
                logDiscordFailure(this, 'disable-previous-buttons', error);
            }
        }
    }

    async pruneWindowLocked() {
        while (this.panels.length > PANEL_HISTORY_LIMIT) {
            const entry = this.panels.shift();
            if (entry === this.itemPanelEntry) this.itemPanelEntry = null;
            try {
                await entry.message.delete();
            } catch (error) {
                logDiscordFailure(this, 'prune-window', error);
            }
        }
    }

    async pruneToFinalLocked(keep) {
        const doomed = this.panels.filter(entry => entry !== keep);
        this.panels = [keep];
        for (const entry of doomed) {
            if (entry === this.itemPanelEntry) this.itemPanelEntry = null;
            try {
                await entry.message.delete();
            } catch (error) {
                logDiscordFailure(this, 'prune-to-final', error);
            }
        }
    }

    buildPanel() {
        if (this.status === 'challenge') {
            return { embed: this.challengeEmbed(), rows: this.challengeViewRows(), interactive: true };
        }
        if (this.status === 'playing' && this.state) {
            return { embed: this.playEmbed(), rows: this.gameViewRows(), interactive: true };
        }
        const rows = this.settlementViewRows();
        return { embed: this.settlementEmbed(), rows, interactive: rows.length > 0 };
    }

    async renderLocked({ armTimer = true } = {}) {
        // 断连接续：每次渲染前把当前对局状态落盘（renderLocked 是「状态变更后」的集中出口）。
        this.persistNow();
        const first = this.panels.length === 0;
        // 道具面板不在此重置：它跟「开枪回合」生命周期走。
        this.pingCurrentTurn = false;
        let entry = null;
        try {
            const { embed, rows, interactive } = this.buildPanel();
            // 软兜底：人类回合面板绝不能没按钮——空行强制换成最小可用按钮集。
            let finalRows = rows;
            const current = this.state?.currentPlayerId;
            if (this.status === 'playing' && this.state && current != null && !this.isAuto(current)) {
                if (!rows.length) {
                    logDiscordFailure(this, 'rows-fallback', new Error(`human turn got empty rows (rows=${rows.length})`), current);
                    finalRows = this.guaranteedTurnRows(this.state);
                }
            }
            const message = await this.channel.send({
                embeds: [embed],
                components: interactive ? finalRows : [],
                allowedMentions: this.panelMentions(),
            });
            entry = { message, interactive };
        } catch (error) {
            logDiscordFailure(this, 'render', error);
            // 软兜底：发送失败（如组件被 Discord 拒绝）时，用最小可用按钮集重试一次，
            // 保证人类回合面板永远弹得出（guaranteedTurnRows 的 customId 恒唯一，不会重蹈 50035）。
            if (this.status === 'playing' && this.state && this.state.currentPlayerId != null
                && !this.isAuto(this.state.currentPlayerId) && entry == null) {
                try {
                    const embed = this.playEmbed();
                    const fallbackRows = this.guaranteedTurnRows(this.state);
                    const message = await this.channel.send({
                        embeds: [embed],
                        components: fallbackRows,
                        allowedMentions: { parse: [], users: [], repliedUser: false },
                    });
                    entry = { message, interactive: true };
                } catch (error2) {
                    logDiscordFailure(this, 'render-fallback-retry', error2);
                }
                if (entry) this.mainPanelSent = true;
            }
            // 主面板从未成功建立（PvE 的「对局开始」播报面板不算）→ 彻底收尾，避免游戏隐形空转。
            if (!this.mainPanelSent) {
                this.teardownNoSend();
                return false;
            }
            if (armTimer && ['challenge', 'playing'].includes(this.status)) {
                this.armTimerLocked();
            } else if (this.status === 'ended') {
                this.cancelTimerLocked();
                this.ensureReleased();
            }
            return true;
        }

        try {
            if (!first) await this.disablePreviousButtonsLocked();
            this.panels.push(entry);
            this.mainPanelSent = true;
            // 面板已入列：再落盘一次，让快照 panelIds 包含刚发出的这张（开头那次 persist 在
            // 发送前、不含它）。否则非优雅退出时恢复兜底按 panelIds 删旧面板会漏掉当前主面板，
            // 频道里留下仍可点击的旧面板。
            this.persistNow();
            if (['challenge', 'playing'].includes(this.status)) {
                await this.pruneWindowLocked();
                if (armTimer) this.armTimerLocked();
            } else {
                this.cancelTimerLocked();
                await this.pruneToFinalLocked(entry);
                this.ensureReleased();
                // 结算面板挂起且胜者未选惩罚 → 启动 30 秒自动施罚倒计时。
                if (this.penaltyPending && !this.penaltyApplied) {
                    this.armSettlementTimeoutLocked();
                }
            }
        } catch (error) {
            logDiscordFailure(this, 'render-cleanup', error);
            if (['challenge', 'playing'].includes(this.status)) {
                try {
                    this.armTimerLocked();
                } catch (error2) {
                    this.teardownNoSend();
                }
            } else {
                this.ensureReleased();
                // 清理抛错也不能丢了 30s 自动施罚：结算挂起且胜者未选 → 补装定时器。
                if (this.penaltyPending && !this.penaltyApplied) {
                    try {
                        this.armSettlementTimeoutLocked();
                    } catch (error2) {
                        logDiscordFailure(this, 'render-cleanup-settlement', error2);
                    }
                }
            }
        }
        return true;
    }

    async refreshMainPanelLocked() {
        // 主面板原地编辑刷新（不新发消息）：道具使用、空枪保回合复用。
        // 找不到可编辑的主面板（如从未发送/被 3 窗口挤出）时退回新发。
        // 断连接续：状态已变（空枪/道具），先落盘再编辑。
        this.persistNow();
        if (!this.panels.length || this.status !== 'playing') {
            await this.renderLocked();
            return;
        }
        try {
            const { embed, rows, interactive } = this.buildPanel();
            // 软兜底：主面板编辑也绝不落成无按钮的人类回合面板。
            let finalRows = rows;
            const current = this.state?.currentPlayerId;
            if (this.state && current != null && !this.isAuto(current)) {
                if (!rows.length) {
                    logDiscordFailure(this, 'refresh-main-rows-fallback', new Error(`refresh edit got empty rows`), current);
                    finalRows = this.guaranteedTurnRows(this.state);
                }
            }
            // 主面板 = 最后一张交互面板（带按钮）；广播/道具面板 interactive=false 不会被选中。
            const entry = [...this.panels].reverse().find(e => e.interactive);
            if (!entry) {
                // 主面板已被连击/道具记录挤出窗口：重发一张，并把它下方的空枪连击面板原封复制一份，
                // 保住连击记录（仍处于空枪后的保留回合时）。
                await this.renderMainWithComboCopy();
                return;
            }
            await entry.message.edit({
                embeds: [embed],
                components: interactive ? finalRows : [],
                allowedMentions: this.panelMentions(),
            });
            entry.interactive = interactive;
        } catch (error) {
            logDiscordFailure(this, 'refresh-main', error);
            await this.renderMainWithComboCopy();
            return;
        }
        this.armTimerLocked();
    }

    // 重发主面板；若空枪连击面板仍存在（保留回合进行中），在其下方补一张原封拷贝，
    // 避免连击记录被 3 面板窗口滚动挤出视野。
    async renderMainWithComboCopy() {
        await this.renderLocked();
        if (this.selfShotPanel?.message?.embeds?.length) {
            await this.rebroadcastSelfShotCombo(this.selfShotPanel.message);
        }
    }

    async renderItemUseLocked() {
        // 道具使用后同步编辑主面板（道具详情已进专用道具面板）——复用主面板原地刷新。
        await this.refreshMainPanelLocked();
    }

    resetItemPanel() {
        // 刷新「道具使用」面板：清内容 + 释放指针（下一次道具操作开新面板）。
        this.itemPanelEntry = null;
        this.itemUsageLog = [];
    }

    async publishItemPanelLocked(result) {
        // 发布/更新「道具使用」面板：同开枪回合首条道具 → 发新面板；后续道具 → 原地编辑。
        if (!this.itemUsageLog.length || this.status !== 'playing' || !this.state) return;
        const embed = this.itemPanelEmbed(result.actorId);
        const entry = this.itemPanelEntry;
        if (entry != null) {
            try {
                await entry.message.edit({
                    embeds: [embed],
                    allowedMentions: { parse: [], users: [], repliedUser: false },
                });
                return;
            } catch (error) {
                logDiscordFailure(this, 'item-panel-edit', error);
                this.itemPanelEntry = null;
            }
        }
        if (typeof this.channel?.send !== 'function') return;
        let message;
        try {
            message = await this.channel.send({
                embeds: [embed],
                allowedMentions: { parse: [], users: [], repliedUser: false },
            });
        } catch (error) {
            logDiscordFailure(this, 'item-panel-send', error);
            return;
        }
        const newEntry = { message, interactive: false };
        this.itemPanelEntry = newEntry;
        this.panels.push(newEntry);
        await this.pruneWindowLocked();
    }

    itemPanelEmbed(actorId) {
        const embed = new EmbedBuilder()
            .setTitle('🎁 道具使用')
            .setColor(0xE67E22)
            .setAuthor({ name: `${this.title} · ${this.modeText()}` });
        let desc = this.itemUsageLog.join('\n\n');
        if (this.state) desc += `\n\n**剩余道具**：${this.itemsText(actorId)}`;
        embed.setDescription(desc);
        embed.setFooter({ text: '同一开枪回合的道具操作汇总在这里 · 开枪后刷新 · 主面板同步更新道具数量' });
        return embed;
    }

    recordItemUse(result) {
        this.itemUsageLog.push(this.itemUsageBlock(result));
        if (this.itemUsageLog.length > ITEM_LOG_LIMIT) this.itemUsageLog.shift();
    }

    itemUsageBlock(result) {
        const actor = this.shortName(result.actorId);
        let head;
        if (result.itemKey === 'adrenaline') {
            const stolen = ITEM_DEFS[result.stolenKey || ''];
            const victim = this.state ? this.shortName(this.state.other(result.actorId)) : '对手';
            const stolenLabel = stolen ? `${stolen.emoji} ${stolen.name}` : '道具';
            head = `💉 肾上腺素 → 偷取 ${victim} 的 ${stolenLabel} 并立即使用`;
        } else {
            const item = ITEM_DEFS[result.itemKey || ''];
            head = item ? `${item.emoji} ${item.name}` : '道具';
        }
        const lines = [`- **${actor} 使用 ${head}**`];
        for (const ln of this.itemEffectLines(result)) lines.push(`　${ln}`);
        return lines.join('\n');
    }

    resultColor(result) {
        if (result.gameEnded || result.roundEnded) return 0x8E44AD; // 紫 — 新一轮 / 终局
        if (result.action === 'shoot_self' || result.action === 'shoot_opponent') {
            return result.hit ? 0xE74C3C : 0x2ECC71; // 红 — 中弹 / 绿 — 空枪
        }
        return 0xE67E22; // 橙 — 道具使用等
    }

    panelMentions() {
        // 每个新面板该 ping 谁：挑战→被挑战者；回合切换→当前真人行动者；结算待选→胜者。
        const pingIds = [];
        if (this.status === 'challenge' && this.targetId != null) {
            pingIds.push(this.targetId);
        } else if (this.status === 'playing' && this.state && this.pingCurrentTurn) {
            const current = this.state.currentPlayerId;
            if (current != null && !this.isAuto(current)) pingIds.push(current);
        } else if (this.status === 'ended' && this.penaltyPending && !this.penaltyApplied) {
            const winner = this.finalWinnerId;
            if (winner != null && !this.isAuto(winner)) pingIds.push(winner);
        }
        this.pingCurrentTurn = false;
        return { parse: [], users: pingIds, repliedUser: false };
    }

    // ── 面板文案 ──

    challengeEmbed() {
        // 游戏名放 author 小字常驻，title 用动态大标题。
        const embed = new EmbedBuilder()
            .setTitle('🔫 决斗邀请')
            .setColor(0x5865F2)
            .setAuthor({ name: `${this.title} · ${this.modeText()}` });
        const cfg = GAME_CONFIG;
        const [lo, hi] = cfg.shells;
        const gameRule = `每人 **${cfg.hp}** 点血，弹巢 ${lo}-${hi} 发（一局定胜负）。`;
        let headline;
        if (this.targetId == null) {
            headline = `**${this.shortName(this.initiatorId)}** 摆下恶魔轮盘擂台，**等待一位勇士**……`
                + `\n（${this.modeText()}）\n\n`
                + '任何成员点下方 **⚔️ 应战** 即可入局。';
        } else {
            headline = `**${this.shortName(this.initiatorId)}** 向 ${mention(this.targetId)} 发起恶魔轮盘对决`
                + `（${this.modeText()}）。\n\n`;
        }
        const deadline = Math.floor(Date.now() / 1000) + CHALLENGE_SECONDS;
        embed.setDescription(
            `${headline}\n`
            + '**📖 规则**\n'
            + '**对局**：\n'
            + `${gameRule}\n\n`
            + '**装填**：庄家把实弹与空弹随机洗牌装进弹巢——总量与实弹数都是**真随机**，'
            + '实弹占比约 **40%-60%**，不会一边倒。开枪前不知道当前这发是实是空：\n'
            + '　• **打自己**：空弹不扣血并保住回合，实弹扣 1 点血；\n'
            + '　• **打对手**：实弹扣对方 1 点血，空弹白白送回合；\n'
            + '　• 手锯能让下一发实弹伤害翻倍（2 点）。\n\n'
            + `**道具（每人上限 ${MAX_ITEM_SLOTS} 件）**：开局**随机发 2-3 件**`
            + `（手锯/手铐/肾上腺素/逆转器/香烟/过期药每种至多 1 件，放大镜/手机/啤酒每种至多 2 件，`
            + '回复类合计至多 1 件）；弹巢打空重新装填时，'
            + '每人道具**在当前持有上再补 2-3 件**（总量上限 4）。轮到你时可以先（可选）用道具再开枪，道具不消耗回合：\n'
            + '🔍 放大镜——查看当前这一发是实弹还是空弹；\n'
            + '🚬 香烟——回复 1 点血；\n'
            + '🍺 啤酒——弹出当前膛内子弹（仅剩最后一发时结束回合）；\n'
            + '🪚 手锯——下一发实弹伤害翻倍；\n'
            + '🔗 手铐——对手下一回合无法行动；\n'
            + '📱 手机——预知往后某一发是什么弹；\n'
            + '🔄 逆转器——把当前膛内子弹翻转为相反类型；\n'
            + '💉 肾上腺素——偷走对手一件道具并立即使用；\n'
            + '💊 过期药——40% 回复 2 点血，否则失去 1 点。\n'
            + `（开局后局内点「${ITEM_HELP_LABEL}」可随时重看。）\n\n`
            + `**⏱ 回合**：每人每回合 ${TURN_SECONDS} 秒（含 ${GRACE_SECONDS} 秒宽限），超时自动开枪。`
            + `🔍/📱 的揭示结果仅你自己可见`
            + `（点「我的情报」随时查看）。\n\n`
            + `**🔨 败者惩罚**：对局结束后由**胜者**选择——🔇 禁言 ${PENALTY_MUTE_MINUTES} 分钟，`
            + `或 ✏️ 强制改名 ${PENALTY_RENAME_MINUTES} 分钟（胜者可自定义昵称，期间败者改回会被改回去）。`
            + `也可以中途**🏳️ 认输**（血量 3 以上可用）：判负，由胜者选 禁言 ${SURRENDER_MUTE_MINUTES} 分`
            + ` 或 改名 ${SURRENDER_RENAME_MINUTES} 分。\n\n`
            + `⏳ 擂台将在 <t:${deadline}:R> 后收摊。`
        );
        if (this.targetId == null) {
            embed.setFooter({ text: '任何成员都可以应战（发起人自己不行），发起人可随时收摊取消。' });
        } else {
            embed.setFooter({ text: '只有被挑战者可以接受或拒绝，发起人可以取消。' });
        }
        return embed;
    }

    playEmbed() {
        const state = this.state;
        if (!state) {
            return new EmbedBuilder()
                .setTitle(this.title)
                .setColor(0x8E44AD)
                .setDescription(this.lastEvent || '游戏尚未开始。');
        }

        const current = state.currentPlayerId;
        // 断连接续标记：恢复回来的首张主面板标题提醒，下一次新发面板时清除。
        const resumed = this.resumed;
        if (resumed) this.resumed = false;
        const title = resumed ? '🔁 断连接续 · 🎯 开枪回合' : '🎯 开枪回合';
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setColor(this.panelColor)
            .setAuthor({ name: `${this.title} · ${this.modeText()}` });

        const auto = current != null && this.isAuto(current);

        // 主体状态放 description，空行分节给呼吸感。
        const parts = [];

        // 回合切换的 ping 标记保留（新面板只 ping 新的行动者一次）。
        let isNewTurn = false;
        if (current != null) {
            isNewTurn = current !== this.announcedPlayer;
            if (isNewTurn) {
                this.announcedPlayer = current;
                this.pingCurrentTurn = true;
            }
        }

        // 实时倒计时：<t:deadline:R> 客户端滴答。
        if (current != null && !auto) {
            if (isNewTurn) parts.push(`⚡现在轮到${mention(current)}开枪了！`);
            parts.push(`⏳ <t:${Math.floor(Date.now() / 1000) + TURN_SECONDS + GRACE_SECONDS}:R> 自动行动`);
            parts.push('');
        }

        // 枪内状态：整行加粗 + 🔫 前缀。
        if (state.inverterObscured) {
            parts.push(`**🔫 枪内 ${state.totalRemaining} 发　实弹 ？？ · 空弹 ？？　中弹率 ？？**`);
        } else {
            const chance = state.totalRemaining ? state.liveRemaining / state.totalRemaining : 0.0;
            const risk = state.totalRemaining ? `（${riskLabel(chance)}）` : '';
            const pct = state.totalRemaining ? percent(chance) : '—';
            parts.push(
                `**🔫 枪内 ${state.totalRemaining} 发　实弹 ${state.liveRemaining} · `
                + `空弹 ${state.blankRemaining}　中弹率 ${pct}**${risk}`
            );
        }
        if (state.sawArmed) parts.push('　🪚 手锯已上膛：下一发实弹伤害翻倍。');
        parts.push('', '');

        embed.setDescription(parts.join('\n'));

        // 双方区块：整行宽字段，每人独立成块；<@id> 必须放 field.value。
        const ordered = current != null
            ? [current, ...state.players.filter(p => p !== current)]
            : state.players;
        for (let idx = 0; idx < ordered.length; idx++) {
            const playerId = ordered[idx];
            const role = this.roleName(playerId);
            let fname = playerId === current ? '🔥 行动中' : '💤 等待';
            if (role) fname += `｜${role}`;
            const lines = [
                `${mention(playerId)}　${state.hpText(playerId)}`,
                `道具：${this.itemsText(playerId)}`,
            ];
            if (state.handcuffed.has(playerId)) {
                lines.push('🔗 下一回合被铐住，跳过行动');
            }
            // 块尾一个 ZWSP 行 = 一行空行分隔下一玩家。
            if (idx < ordered.length - 1) lines.push('​');
            embed.addFields([{ name: fname, value: lines.join('\n'), inline: false }]);
        }
        return embed;
    }

    itemsText(playerId) {
        const state = this.state;
        if (!state) return '—';
        const items = state.items[playerId] || [];
        if (!items.length) return '（无）';
        const counts = new Map();
        for (const key of items) counts.set(key, (counts.get(key) || 0) + 1);
        const parts = [];
        for (const [key, n] of counts) {
            const item = ITEM_DEFS[key];
            const label = `${item.emoji} ${item.name}`;
            parts.push(n === 1 ? label : `${label}×${n}`);
        }
        return parts.join('　');
    }

    privateEmbed(userId) {
        const state = this.state;
        if (!state) throw new InvalidAction('这局还没有私有情报。');
        return new EmbedBuilder()
            .setTitle(`${this.title} · 仅你可见`)
            .setColor(0x5865F2)
            .addFields([
                { name: '⚡ 我的电量', value: state.hpText(userId), inline: true },
                { name: '🎁 我的道具', value: this.itemsText(userId), inline: true },
                { name: '📜 情报', value: state.privateIntelText(userId), inline: false },
            ]);
    }

    penaltyMinutes() {
        // 当前惩罚口径的 (禁言分钟, 改名分钟)。正常终局 8/10；认输 5/8。
        if (this.penaltyScope === 'surrender') {
            return [SURRENDER_MUTE_MINUTES, SURRENDER_RENAME_MINUTES];
        }
        return [PENALTY_MUTE_MINUTES, PENALTY_RENAME_MINUTES];
    }

    settlementEmbed() {
        const embed = new EmbedBuilder()
            .setTitle('🏆 结算')
            .setColor(0xF1C40F)
            .setAuthor({ name: this.title });
        const parts = [];
        if (this.finalWinnerId != null) {
            parts.push(`🏆 ${mention(this.finalWinnerId)} 赢下了这场恶魔轮盘。\n${flavor('game_end')}`);
        }
        if (this.mode === 'pve' && this.state) {
            // PvE：显示真人玩家的累计战绩（总胜利/总失败/胜利率）。
            const humanId = this.state.players.find(id => !this.isAuto(id));
            if (humanId != null) {
                try {
                    const stats = getDevilRoulettePveStats(humanId);
                    if (stats.total > 0) {
                        parts.push(
                            `📊 **你的恶魔轮盘战绩**：总胜利 **${stats.wins}** 场 · `
                            + `总失败 **${stats.losses}** 场 · 胜利率 **${(stats.winrate * 100).toFixed(1)}%**`
                        );
                    }
                } catch (error) {
                    logDiscordFailure(this, 'pve-stats-read', error, humanId);
                }
            }
        }
        if (this.lastEvent) parts.push(this.lastEvent);
        if (this.penaltyPending && !this.penaltyApplied) {
            const [muteMin, renameMin] = this.penaltyMinutes();
            parts.push(
                `🔨 **胜者请决定败者惩罚**：🔇 禁言 ${muteMin} 分钟，`
                + `或 ✏️ 改名 ${renameMin} 分钟（可自定义昵称）——点下方按钮。`
                + `${PENALTY_SETTLEMENT_SECONDS} 秒内不选择，将**自动禁言输家 `
                + `${PENALTY_AUTO_MUTE_MINUTES} 分钟**。`
            );
        }
        embed.setDescription(parts.join('\n\n'));
        return embed;
    }

    // ── 叙述 ──

    safeFormatResult(result) {
        try {
            return this.formatResult(result);
        } catch (error) {
            logDiscordFailure(this, 'format-result', error, result.actorId);
            return `⚠️ **${this.shortName(result.actorId)}** 的操作已完成，但事件描述生成失败。`;
        }
    }

    formatResult(result) {
        const actor = this.shortName(result.actorId);
        const lines = [];
        if (result.action === 'shoot_self' || result.action === 'shoot_opponent') {
            const targetSelf = result.action === 'shoot_self';
            if (result.hit) {
                const dmg = result.sawDoubled ? `（手锯翻倍 ${result.damage} 点）` : '（1 点）';
                if (targetSelf) {
                    lines.push(`💥 ${actor} 开枪打自己，中弹 ${dmg}。`);
                    lines.push(flavor('self_hit'));
                } else {
                    lines.push(`💥 ${actor} 开枪命中 **${this.shortName(result.targetId)}** ${dmg}。`);
                    lines.push(flavor('hit'));
                }
            } else {
                if (targetSelf) {
                    lines.push(`😮‍💨 ${actor} 开枪打自己，空弹，保住了回合。`);
                } else {
                    lines.push(`😮‍💨 ${actor} 开枪打 **${this.shortName(result.targetId)}**，空弹。`);
                }
                lines.push(flavor('miss'));
            }
            if (result.reloaded) {
                lines.push('（弹壳用完，重新装填。）');
                lines.push(flavor('reload'));
            }
        } else if (result.action === 'adrenaline') {
            const stolen = ITEM_DEFS[result.stolenKey || ''];
            const victim = this.state ? this.shortName(this.state.other(result.actorId)) : '对手';
            const stolenLabel = stolen ? `${stolen.emoji} ${stolen.name}` : '道具';
            lines.push(`💉 ${actor} 用肾上腺素偷走了 **${victim}** 的 ${stolenLabel}，并立即使用。`);
            lines.push(...this.itemEffectLines(result));
        } else {
            const item = ITEM_DEFS[result.itemKey || ''];
            const label = item ? `${item.emoji} ${item.name}` : result.itemKey;
            lines.push(`🎁 ${actor} 使用了 ${label}。`);
            lines.push(...this.itemEffectLines(result));
        }

        if (result.roundEnded && result.killedId === result.actorId && result.itemKey) {
            lines.push('💀 过期药连自己都带走了。');
        }
        return lines.join('\n');
    }

    itemEffectLines(result) {
        const lines = [];
        if (result.reveal) lines.push('🔍 探明了弹位（仅自己可见）。');
        if (result.healed) {
            lines.push(`❤️‍🩹 回复 ${result.healed} 点生命。`);
            lines.push(flavor('heal'));
        } else if (result.fullHp) {
            if (result.itemKey === 'cigarette') lines.push('🚬 血量已满，这口烟抽了个寂寞。');
            else if (result.itemKey === 'medicine') lines.push('💊 血量已满，过期药白吃了一粒。');
            else lines.push('❤️ 血量已满，没有回复效果。');
        }
        if (result.lostHp) lines.push(`💔 失去 ${result.lostHp} 点生命。`);
        if (result.ejected) {
            const shellType = result.ejectedLive ? '实弹' : '空弹';
            lines.push(`🍺 弹出当前膛内子弹（${shellType}）。`);
            lines.push(flavor('beer'));
        }
        if (result.flipped) lines.push('🔄 当前膛内子弹已翻转。');
        if (result.handcuffedId != null) {
            lines.push(`🔗 **${this.shortName(result.handcuffedId)}** 下一回合无法行动。`);
            lines.push(flavor('handcuff'));
        }
        if (result.itemKey === 'saw' || result.stolenKey === 'saw') {
            lines.push('🪚 手锯已上膛，下一发实弹翻倍。');
            lines.push(flavor('saw'));
        }
        return lines;
    }

    // ── 惩罚应用（改名复用 parliament 昵称锁） ──

    async applyPenalty(guild, loserId, penaltyType, { nickname = null, minutes = null } = {}) {
        if (penaltyType === 'mute') {
            return this.applyMute(guild, loserId, { minutes });
        }
        return this.applyRename(guild, loserId, { nickname, minutes });
    }

    async applyMute(guild, loserId, { minutes = null } = {}) {
        const member = await this.fetchMember(guild, loserId);
        if (!member) return [false, '找不到成员'];
        const mins = minutes || PENALTY_MUTE_MINUTES;
        try {
            await member.timeout(mins * 60_000, PENALTY_MUTE_REASON);
            return [true, `已禁言 ${mins} 分钟`];
        } catch (error) {
            logDiscordFailure(this, 'apply-mute', error, loserId);
            return [false, '禁言未生效'];
        }
    }

    async applyRename(guild, loserId, { nickname = null, minutes = null } = {}) {
        const member = await this.fetchMember(guild, loserId);
        if (!member) return [false, '找不到成员'];
        const enforced = (nickname || PENALTY_NICKNAME).trim();
        if (!enforced) return [false, '昵称不能为空'];
        const renameMinutes = minutes || PENALTY_RENAME_MINUTES;
        const result = await nicknameLock.service.replaceLock({
            member,
            type: RENAME_LOCK_TYPE,
            enforcedNickname: enforced,
            expiresAt: Date.now() + renameMinutes * 60_000,
            applyReason: PENALTY_RENAME_APPLY_REASON,
            restoreReason: PENALTY_RENAME_RESTORE_REASON,
            enforceReason: PENALTY_RENAME_ENFORCE_REASON,
            channelId: this.channelId,
            expectedTypes: ORDINARY_LOCK_TYPES,
        });
        if (result.created) {
            return [true, `已强制改名 ${renameMinutes} 分钟（新昵称：${enforced}）`];
        }
        if (result.reason === 'existing_lock') {
            return [false, '改名未生效（对方正挂着更高优先级的昵称锁）'];
        }
        return [false, '改名未生效（Bot 权限不足或成员状态）'];
    }

    async fetchMember(guild, userId) {
        try {
            return await guild?.members?.fetch?.(userId) || null;
        } catch (error) {
            logDiscordFailure(this, 'fetch-member', error, userId);
            return null;
        }
    }

    // ── 视图 ──

    challengeViewRows() {
        const rows = [new ActionRowBuilder()];
        if (this.targetId == null) {
            // 公屏擂台：任何非发起人的成员都能应战。
            rows[0].addComponents(
                new ButtonBuilder()
                    .setCustomId(`mystery_devil_roulette_accept:${this.id}`)
                    .setLabel('⚔️ 应战')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(`mystery_devil_roulette_cancel:${this.id}`)
                    .setLabel('🛑 发起人取消')
                    .setStyle(ButtonStyle.Secondary)
            );
        } else {
            rows[0].addComponents(
                new ButtonBuilder()
                    .setCustomId(`mystery_devil_roulette_accept:${this.id}`)
                    .setLabel('⚔️ 接受挑战')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(`mystery_devil_roulette_decline:${this.id}`)
                    .setLabel('拒绝')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`mystery_devil_roulette_cancel:${this.id}`)
                    .setLabel('🛑 发起人取消')
                    .setStyle(ButtonStyle.Secondary)
            );
        }
        return rows;
    }

    // 软兜底：人类回合面板必须带开枪按钮。任何按钮构建异常/空结果都退回这套最小可用按钮集，
    // 保证面板永远可操作（不会出现「转手后没有按钮、只能干等 60s 自动开枪」）。
    guaranteedTurnRows(state) {
        const current = state.currentPlayerId;
        const row0 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_devil_roulette_turn_hint:${this.id}:${state.turnToken}`)
                .setLabel(`当前回合：@${this.plainName(current)}`)
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`mystery_devil_roulette_shoot:${this.id}:${state.turnToken}:opponent`)
                .setLabel('🔫 打对手')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`mystery_devil_roulette_shoot:${this.id}:${state.turnToken}:self`)
                .setLabel('💀 打自己')
                .setStyle(ButtonStyle.Danger)
        );
        const lastRow = new ActionRowBuilder();
        this.addPrivateButton(lastRow);
        this.addItemHelpButton(lastRow);
        return [row0, lastRow];
    }

    gameViewRows() {
        const state = this.state;
        if (!state) {
            return [];
        }
        const current = state.currentPlayerId;
        if (current == null || this.isAuto(current)) {
            // 庄家自动行动 / 待定态：只留 情报 + 道具简介 两个只读按钮。
            const row = new ActionRowBuilder();
            this.addPrivateButton(row, 0);
            this.addItemHelpButton(row, 0);
            return [row];
        }

        try {
            // 第 0 行：行首「当前回合」指示 + 开枪主行动。
            const rows = [new ActionRowBuilder()];
            rows[0].addComponents(
                new ButtonBuilder()
                    .setCustomId(`mystery_devil_roulette_turn_hint:${this.id}:${state.turnToken}`)
                    .setLabel(`当前回合：@${this.plainName(current)}`)
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId(`mystery_devil_roulette_shoot:${this.id}:${state.turnToken}:opponent`)
                    .setLabel('🔫 打对手')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(`mystery_devil_roulette_shoot:${this.id}:${state.turnToken}:self`)
                    .setLabel('💀 打自己')
                    .setStyle(ButtonStyle.Danger)
            );

            // 第 1 行起：道具（每行最多 5 个，自动换行；肾上腺素单独走选择菜单）。
            // 同一道具持有多件（如啤酒×2）会渲染多个按钮——customId 必须带序号去重，
            // 否则 Discord 报 50035 Invalid Form Body、面板渲染失败（转手后没新面板的根因）。
            // 手机只剩一发时没有未来弹位可探：保留"📱 手机（被禁用）"按钮，点击弹仅我可见解释；
            // 其余不可用道具（如对手已被铐住时的手铐）仍按原样不渲染。
            const itemKeys = [];
            for (const k of state.items[current]) {
                if (k === 'adrenaline') continue;
                if (state.canUseItem(current, k) || k === 'phone') itemKeys.push(k);
            }
            for (let index = 0; index < itemKeys.length; index++) {
                const itemKey = itemKeys[index];
                const usable = state.canUseItem(current, itemKey);
                const rowIndex = 1 + Math.floor(index / 5);
                if (!rows[rowIndex]) rows[rowIndex] = new ActionRowBuilder();
                if (!usable) {
                    rows[rowIndex].addComponents(
                        new ButtonBuilder()
                            .setCustomId(`mystery_devil_roulette_phone_blocked:${this.id}:${state.turnToken}:${index}`)
                            .setLabel('📱 手机（被禁用）')
                            .setStyle(ButtonStyle.Secondary)
                    );
                    continue;
                }
                const item = ITEM_DEFS[itemKey];
                rows[rowIndex].addComponents(
                    new ButtonBuilder()
                        .setCustomId(`mystery_devil_roulette_item:${this.id}:${state.turnToken}:${itemKey}:${index}`)
                        .setLabel(`${item.emoji} ${item.name}`)
                        .setStyle(STYLE_MAP[ITEM_BUTTON_STYLE[itemKey]] || ButtonStyle.Secondary)
                );
            }

            const itemRows = Math.ceil(itemKeys.length / 5);
            let nextRow = 1 + itemRows;

            // 肾上腺素：选择菜单（偷取对手哪件道具）。
            if (state.canUseItem(current, 'adrenaline')) {
                const stealable = state._stealableItems(current);
                if (stealable.length) {
                    const selectRow = new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId(`mystery_devil_roulette_adrenaline:${this.id}:${state.turnToken}`)
                            .setPlaceholder('💉 肾上腺素：偷取对手道具')
                            .addOptions(
                                stealable.map(k => new StringSelectMenuOptionBuilder()
                                    .setLabel(`${ITEM_DEFS[k].emoji} ${ITEM_DEFS[k].name}`)
                                    .setValue(k))
                            )
                    );
                    rows.push(selectRow);
                    nextRow += 1;
                }
            }

            // 末行：我的情报 + 道具简介（同一行，情报在左）。
            const lastRow = new ActionRowBuilder();
            this.addPrivateButton(lastRow, 0);
            this.addItemHelpButton(lastRow, 0);
            rows.push(lastRow);
            return rows;
        } catch (error) {
            logDiscordFailure(this, 'game-rows-fallback', error, current);
            return this.guaranteedTurnRows(state);
        }
    }

    addPrivateButton(row) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_devil_roulette_intel:${this.id}:${this.state?.turnToken ?? ''}`)
                .setLabel(PRIVATE_PANEL_LABEL)
                .setStyle(ButtonStyle.Primary)
        );
    }

    addItemHelpButton(row) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_devil_roulette_item_help:${this.id}:${this.state?.turnToken ?? ''}`)
                .setLabel(ITEM_HELP_LABEL)
                .setStyle(ButtonStyle.Secondary)
        );
    }

    privateIntelViewRows(userId) {
        // 「❓ 道具简介」面板附带的认输按钮。
        const state = this.state;
        const isPlayer = state != null && userId != null && state.players.includes(userId);
        const lowHp = isPlayer && (state.hp[userId] || 0) <= SURRENDER_MIN_HP;
        let label;
        if (this.status !== 'playing') {
            label = '🏳️ 认输（对局已结束）';
        } else if (!isPlayer) {
            label = '🏳️ 认输（你不在本局中）';
        } else if (lowHp) {
            label = `🏳️ 认输（血量仅剩 ${SURRENDER_MIN_HP} 点，无法使用）`;
        } else {
            label = '🏳️ 认输';
        }
        const canSurrender = this.status === 'playing'
            && state != null
            && userId != null
            && state.players.includes(userId)
            && !this.isAuto(userId)
            && !lowHp;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_devil_roulette_surrender:${this.id}`)
                .setLabel(label)
                .setStyle(ButtonStyle.Danger)
                .setDisabled(!canSurrender)
        );
        return [row];
    }

    settlementViewRows() {
        // 败者惩罚由胜者自选（PvP 终局才会 pending）；时长按正常/认输口径。
        if (!this.penaltyPending || this.penaltyApplied) return [];
        const [muteMin, renameMin] = this.penaltyMinutes();
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_devil_roulette_penalty_mute:${this.id}`)
                .setLabel(`🔇 禁言 ${muteMin} 分钟`)
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`mystery_devil_roulette_penalty_rename:${this.id}`)
                .setLabel(`✏️ 改名 ${renameMin} 分钟`)
                .setStyle(ButtonStyle.Success)
        );
        return [row];
    }

    // ── 收尾 ──

    disableAllComponents() {
        this.cancelTimerLocked();
        for (const entry of this.panels) {
            if (!entry.interactive) continue;
            entry.interactive = false;
            entry.message.edit({
                components: [],
                allowedMentions: { parse: [], users: [], repliedUser: false },
            }).catch(error => logDiscordFailure(this, 'disable-components', error));
        }
    }

    async close() {
        this.status = 'ended';
        this.lastEvent = '游戏已关闭。';
        await this.renderLocked();
    }
}

// ── 启动入口 ──────────────────────────────────────────────────────────────────

async function startDevilRoulette(interaction, requestedOpponent, {
    onGameStarted,
} = {}) {
    const userId = interaction.user?.id;

    const targetId = requestedOpponent?.id || requestedOpponent?.user?.id || null;
    if (targetId === userId || requestedOpponent?.user?.bot) {
        await interaction.reply({ content: '不能挑战自己或机器人账号。', flags: MessageFlags.Ephemeral });
        return false;
    }

    const session = new DevilRouletteGame({
        mode: 'pvp',
        initiatorId: userId,
        targetId,
        channel: interaction.channel,
        guild: interaction.guild,
    });
    session.onGameStarted = onGameStarted;

    const created = gameManager.createGame(session);
    if (!created.ok) {
        await interaction.reply({
            content: created.reason === 'player'
                ? '你已经在另一场游戏里了。'
                : '这个频道已经有一场游戏在进行中。',
            flags: MessageFlags.Ephemeral,
        });
        return false;
    }
    // gameManager 把会话克隆成普通对象注册（getGame 走这里）；补回类原型让方法可用。
    Object.setPrototypeOf(created.game, DevilRouletteGame.prototype);
    const game = created.game;
    registerActiveGame(game);
    attachDevilShutdown(game); // 原生收尾：shutdownAllGames 统一驱动
    game.onMemberInvalidated = async invalidMember => {
        const invalidUserId = invalidMember?.id || invalidMember?.user?.id;
        if (invalidUserId) {
            await handleDevilRouletteMemberInvalidated(game, invalidUserId);
        }
    };

    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (error) {
        logDiscordFailure(game, 'defer-start', error, userId);
        await cleanup(game);
        return false;
    }

    let okOpen = false;
    try {
        okOpen = await game.open();
    } catch (error) {
        okOpen = false;
        logDiscordFailure(game, 'open', error, userId);
    }
    if (!okOpen) {
        await cleanup(game);
        try {
            await interaction.editReply({ content: '我没有权限在这里发送游戏面板。' });
        } catch (error) {
            logDiscordFailure(game, 'open-failure-reply', error, userId);
        }
        return false;
    }
    await interaction.editReply({
        content: targetId == null ? '⚔️ 擂台已摆下，等待勇士应战……' : '恶魔轮盘挑战已发出。',
    });
    return true;
}

async function startDevilRoulettePve(interaction, {
    onGameStarted,
} = {}) {
    const userId = interaction.user?.id;
    // discord.js 里 interaction.guild.me 可能因 bot 自身 member 未缓存而为 null（导致静默 return false）；
    // interaction.client.user.id 恒可用，是 bot 自身 ID（与 member id 相同）。
    const botId = interaction.client?.user?.id || interaction.guild?.me?.id;
    if (!botId) {
        await interaction.reply({ content: '无法确定机器人身份，请稍后重试。', flags: MessageFlags.Ephemeral });
        return false;
    }

    // 全局并发上限：与庄家对赌每局占一个求解器 Worker（单回合可跑 50s），
    // 超过上限就拒绝新局，避免多局并发把 CPU 打满、互相拖慢。
    const activePveCount = gameManager.listGames()
        .filter(g => g?.type === 'devil_roulette' && g?.mode === 'pve').length;
    if (activePveCount >= DEVIL_ROULETTE_PVE_GLOBAL_CAP) {
        await interaction.reply({
            content: `庄家分身乏术：同时进行的对局已达上限（${DEVIL_ROULETTE_PVE_GLOBAL_CAP} 场），请稍后再试。`,
            flags: MessageFlags.Ephemeral,
        });
        return false;
    }

    const session = new DevilRouletteGame({
        mode: 'pve',
        initiatorId: userId,
        botOpponentId: botId,
        channel: interaction.channel,
        guild: interaction.guild,
    });
    session.onGameStarted = onGameStarted;

    // 不把 Bot 自己的 ID 锁进 by_player，否则全公会同时只能一场。
    const participantIds = [...new Set(session.participants.filter(p => p !== botId))];
    const input = { ...session, participantIds };
    const created = gameManager.createGame(input);
    if (!created.ok) {
        await interaction.reply({
            content: created.reason === 'player'
                ? '你已经在另一场游戏里了。'
                : '这个频道已经有一场游戏在进行中。',
            flags: MessageFlags.Ephemeral,
        });
        return false;
    }
    Object.setPrototypeOf(created.game, DevilRouletteGame.prototype);
    const game = created.game;
    registerActiveGame(game);
    attachDevilShutdown(game); // 原生收尾：shutdownAllGames 统一驱动
    game.onMemberInvalidated = async invalidMember => {
        const invalidUserId = invalidMember?.id || invalidMember?.user?.id;
        if (invalidUserId) {
            await handleDevilRouletteMemberInvalidated(game, invalidUserId);
        }
    };

    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (error) {
        logDiscordFailure(game, 'defer-start', error, userId);
        await cleanup(game);
        return false;
    }

    let okOpen = false;
    try {
        okOpen = await game.open();
    } catch (error) {
        okOpen = false;
        logDiscordFailure(game, 'open', error, userId);
    }
    if (!okOpen) {
        await cleanup(game);
        try {
            await interaction.editReply({ content: '我没有权限在这里发送游戏面板。' });
        } catch (error) {
            logDiscordFailure(game, 'open-failure-reply', error, userId);
        }
        return false;
    }
    try {
        game.onGameStarted?.([userId]);
    } catch (error) {
        logDiscordFailure(game, 'on-game-started', error, userId);
    }
    await interaction.editReply({ content: '🔫 你向庄家发起了恶魔轮盘。她没有任何犹豫。' });
    return true;
}

// ── 交互分发 ──────────────────────────────────────────────────────────────────

function parseParts(parts) {
    const input = (Array.isArray(parts) ? parts : [parts]).filter(part => typeof part === 'string');
    const tokens = input.flatMap(part => part.split(':')).filter(Boolean);
    if (tokens[0]?.startsWith('mystery_devil_roulette_')) {
        tokens[0] = tokens[0].slice('mystery_devil_roulette_'.length);
    }
    while (tokens[0] === 'mystery' || tokens[0] === 'devil' || tokens[0] === 'roulette') tokens.shift();
    return {
        action: tokens[0],
        gameId: tokens[1],
        turnToken: tokens[2],
        argument: tokens[3],
    };
}

// Discord 昵称禁用字符：@ # : 反斜杠、控制符、空字符。胜者自定的败者昵称必须先清洗，
// 否则 PATCH 被 Discord 拒收 → replaceLock 失败 → 输家逃罚（fail-open）。
function sanitizeRenameNickname(raw) {
    return String(raw ?? '')
        .replace(/[@#:\\\x00-\x1F\x7F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 32);
}

async function handleRenameModalSubmit(interaction) {
    const parts = String(interaction.customId || '').split(':');
    const gameId = parts[1];
    const game = gameId && gameManager.getGame(gameId);
    if (!game || game.type !== 'devil_roulette') {
        await deferComponent(interaction, { ephemeral: true });
        await sendComponentError(interaction, EXPIRED_MESSAGE);
        return false;
    }
    const raw = interaction.fields?.getTextInputValue?.('devil_roulette_rename_input');
    const nickname = sanitizeRenameNickname(raw);
    if (!nickname) {
        await deferComponent(interaction, { ephemeral: true });
        await sendComponentError(interaction, '昵称不能为空，或包含 Discord 禁止的字符（@ # : 等）。');
        return false;
    }
    await game.chooseRenamePenalty(interaction, nickname);
    return true;
}

async function handleDevilRouletteInteraction(interaction, parts) {
    if (interaction.isModalSubmit?.() && typeof interaction.customId === 'string'
        && interaction.customId.startsWith(RENAME_MODAL_PREFIX)) {
        return handleRenameModalSubmit(interaction);
    }
    const parsed = parseParts(parts);
    const game = parsed.gameId && gameManager.getGame(parsed.gameId);
    if (!game || game.type !== 'devil_roulette') {
        await deferComponent(interaction, { ephemeral: true });
        await sendComponentError(interaction, EXPIRED_MESSAGE);
        return false;
    }
    const { action, turnToken, argument } = parsed;
    switch (action) {
        case 'accept':
            return game.acceptChallenge(interaction);
        case 'decline':
            return game.declineChallenge(interaction);
        case 'cancel':
            return game.cancelByInitiator(interaction);
        case 'turn_hint':
            return game.hintCurrentTurn(interaction);
        case 'refresh':
            return game.refreshPanel(interaction);
        case 'shoot':
            return game.act(interaction, argument === 'self' ? 'shoot_self' : 'shoot_opponent', Number(turnToken));
        case 'item':
            return game.act(interaction, argument, Number(turnToken));
        case 'phone_blocked':
            return game.showPhoneBlocked(interaction);
        case 'adrenaline':
            return game.act(interaction, 'adrenaline', Number(turnToken), {
                stealKey: interaction.values?.[0],
            });
        case 'intel':
            return game.showPrivateState(interaction);
        case 'item_help':
            return game.showItemHelp(interaction);
        case 'surrender':
            return game.surrender(interaction);
        case 'penalty_mute':
            return game.chooseMutePenalty(interaction);
        case 'penalty_rename':
            return game.openRenameModal(interaction);
        default:
            await deferComponent(interaction, { ephemeral: true });
            await sendComponentError(interaction, EXPIRED_MESSAGE);
            return false;
    }
}

// ── 成员失格 ──────────────────────────────────────────────────────────────────

async function handleDevilRouletteMemberInvalidated(game, userId) {
    if (!game || game.type !== 'devil_roulette') return false;
    // 成员仍在公会缓存 → 只是昵称/资料更新，非真正离开，忽略。
    if (game.guild?.members?.cache?.has(userId)) return false;
    let outcome = null;
    await gameManager.runExclusive(game, () => {
        if (game.status === 'inviting' || game.status === 'challenge') {
            game.status = 'ended';
            game.lastEvent = '🧯 有参与者离开了服务器，本局取消。';
            outcome = 'invite_cancel';
            return;
        }
        if (game.status === 'playing' && game.state && game.participants.includes(userId)) {
            game.status = 'ended';
            game.finalWinnerId = game.state.other(userId);
            game.lastEvent = `🏳️ **${game.shortName(userId)}** 离开了服务器，本局判负。`;
            outcome = 'forfeit';
        }
    });
    if (!outcome) return false;
    await game.renderLocked();
    return true;
}

// ── 重启中止 ──────────────────────────────────────────────────────────────────

const activeGames = new Set();

function registerActiveGame(game) {
    activeGames.add(game);
}

function cleanup(game) {
    if (!game || game.released) return Promise.resolve();
    game.released = true;
    game.status = 'ended';
    game.cancelTimerLocked();
    game.disableAllComponents();
    game.deletePersisted?.();
    return gameManager.cleanupGame(game);
}

// 恶魔轮盘对局收尾：挂到 game.onShutdown，由 mysteryGameManager.shutdownAllGames 统一驱动
// （原生做法，和加压轮盘同一机制）。删掉本局面板（不留"已失效"死按钮），快照保留供下次启动续接；
// 全局冲刷快照写队列 + 停求解器池（都是幂等操作，多局并行收尾时重复调用无害）。
function attachDevilShutdown(game) {
    game.onShutdown = async () => {
        game.cancelTimerLocked?.();
        for (const entry of [...(game.panels || [])]) {
            const msg = entry?.message;
            if (!msg || typeof msg.delete !== 'function') continue;
            await msg.delete().catch(error => logDiscordFailure(game, 'shutdown-delete-panel', error));
        }
        game.panels = [];
        game.itemPanelEntry = null;
        try {
            await resumeStore.flush();
        } catch (error) {
            logDiscordFailure(null, 'resume-flush', error);
        }
        terminateDealerPool();
    };
    return game;
}

// 启动时把上次没打完的恶魔轮盘对局接回来（断连接续）。
async function restoreActiveGames(client) {
    let snapshots = [];
    try {
        snapshots = await resumeStore.list();
    } catch (error) {
        logDiscordFailure(null, 'resume-list', error);
        return 0;
    }
    let restored = 0;
    for (const snap of snapshots) {
        try {
            if (!snap || snap.v !== 1 || !snap.id || !snap.guildId || !snap.channelId) continue;
            if (gameManager.getGame(snap.id)) continue; // 已恢复
            const guild = client.guilds?.cache?.get(snap.guildId)
                || await client.guilds.fetch(snap.guildId).catch(() => null);
            if (!guild) {
                // 机器人已不在该服，快照失去意义，清掉。
                resumeStore.remove(snap.id);
                continue;
            }
            const channel = guild.channels?.cache?.get(snap.channelId)
                || await guild.channels.fetch(snap.channelId).catch(() => null);
            if (!channel || typeof channel.send !== 'function') {
                resumeStore.remove(snap.id);
                continue;
            }
            const game = DevilRouletteGame.restore(snap, { guild, channel });
            // 与正常开局一致：把完整实例交给 gameManager（它克隆成普通对象），再补回类原型，
            // 否则 getGame 拿到的是无方法/无 state 的裸对象，点击一律"已失效"。
            const reg = gameManager.createGame(game);
            if (!reg.ok) continue; // 锁冲突（启动时理论上不会），快照留着下次再试
            Object.setPrototypeOf(reg.game, DevilRouletteGame.prototype);
            const restoredGame = reg.game;
            restoredGame.onMemberInvalidated = async invalidMember => {
                const invalidUserId = invalidMember?.id || invalidMember?.user?.id;
                if (invalidUserId) await handleDevilRouletteMemberInvalidated(restoredGame, invalidUserId);
            };
            registerActiveGame(restoredGame);
            attachDevilShutdown(restoredGame); // 原生收尾：恢复的对局同样挂 onShutdown
            // 清掉上次进程残留的旧面板（优雅退出已由 onShutdown 删掉，这里兜底非优雅退出的漏网），
            // 避免频道里留下点了就"已失效"的死面板；随后 renderLocked 发新面板续接。
            for (const msgId of Array.isArray(snap.panelIds) ? snap.panelIds : []) {
                if (!msgId) continue;
                await channel.messages.delete(msgId).catch(() => {});
            }
            await restoredGame.renderLocked();
            restored += 1;
        } catch (error) {
            logDiscordFailure(null, 'resume-restore', error, snap?.id);
        }
    }
    if (restored > 0) {
        console.log(`[DevilRoulette] 断连接续：恢复 ${restored} 场未完成的对局。`);
    }
    return restored;
}

module.exports = {
    startDevilRoulette,
    startDevilRoulettePve,
    handleDevilRouletteInteraction,
    restoreActiveGames,
    // 供 interactionHandler 路由 rename modal 提交。
    RENAME_MODAL_PREFIX,
};
