'use strict';
/**
 * 恶魔轮盘庄家最优解求解器（纯 JS，零依赖）。
 *
 * 把剩余弹序按已知信息（实弹/空弹计数 + 本方情报）枚举成信念集合，
 * 在完整博弈树上做期望最大——开枪 + 每件道具 + 手锯 + 手铐 + 补弹。
 * 返回 P(我方赢下本回合) / 最优动作，随机结果按信念平均。
 *
 * 关键机制：
 *  - 完备性标记：节点/深度超限回退截断评估，值**不写 memo**；仅完备时才缓存，
 *    让 IDDFS 每趟复用上一趟的真实浅层搜索值。
 *  - IDDFS（battleBestActionTimed 内）：分趟翻倍预算搜索，末趟未完备时用已缓存的部分值选动作。
 *  - 对手建模（setOppModel）：uniform/aggressive，在对手决策节点用 θ(evs) 加权平均代替 min。
 *  - 对手私有情报（oppKnown）：对手按自己的信念选动作，值按我方信念计算。
 *
 * 算力限制：不追求极速，只在给定时间窗内尽量逼近真最优——决策入口按耗时预算配置
 * （默认 10s，ROULETTE_SOLVER_MAX_MS 可调），IDDFS 逐趟扩大直至完备或超时；Worker 池
 * 默认占 50% 核数并留 ≥1 核给主线程。强化方向：补弹道具分布目前用强/非强二分建模，
 * 可换更细的 top-K 枚举逼近真最优，但状态空间会显著扩大（需按机器算力权衡）。
 */

// ── 全局状态（单线程；预热与决策共用同一 memo，缓存跨回合保持） ──

let _battleMemo = new Map(); // key -> value（只存完备值）
let _OPP_MODEL = null; // null=精确 minimax；callable=对手子优建模
let _oppMemo = new Map();
// 补弹期望记忆化：空仓补弹值按「补弹状态」缓存。补弹子树对满道具局面是自指的
// （每次空仓扩 48 子博弈、子博弈又含空仓）——不缓存则树指数爆炸、永不收敛。
// in-progress 标记 = 定点迭代一步：子博弈内部再遇同状态空仓直接返回当前估计，打破自指。
let _reloadMemo = new Map();

const battleTL = { nodes: 0, limit: 400_000, depth: 0, depthLimit: 80, deadline: 0 };

const _ITEM_WEIGHTS = Object.freeze({
    handcuffs: 2, adrenaline: 2,
    saw: 2, magnifier: 3,
    inverter: 4, phone: 4, beer: 4,
    cigarette: 5, medicine: 5,
});
const _STRONG_ITEMS = new Set(['saw', 'handcuffs', 'adrenaline']);
const _HEAL_ITEMS = new Set(['cigarette', 'medicine']);
// 单件上限（与引擎 ITEM_MAX_COUNT 对齐）；其余默认 2。
const _ITEM_MAX = Object.freeze({
    saw: 1, handcuffs: 1, adrenaline: 1, inverter: 1,
    cigarette: 1, medicine: 1,
});

function itemCapReached(items, k) {
    if (items.filter(x => x === k).length >= (_ITEM_MAX[k] ?? 2)) return true;
    // 共用上限：香烟/过期药合计最多 1 件（与引擎 ITEM_GROUP_CAPS 对齐）。
    if (_HEAL_ITEMS.has(k)) {
        return items.filter(x => _HEAL_ITEMS.has(x)).length >= 1;
    }
    return false;
}
const MEMO_GUARD = 400_000;
// 补弹子博弈的深度上限：满深度自指爆炸，浅深度让补弹估计有界可算。
let RELOAD_SUB_DEPTH = 24;

// ── 对手建模 ──

function oppWeightUniform(actions) {
    const n = actions.length;
    if (n === 0) return [];
    return new Array(n).fill(1.0 / n);
}

// 对手=莽：偏爱 shoot_opponent，不保回合、道具权重低。权重为相对强度。
function oppWeightAggressive(actions) {
    const w = [];
    for (const [a] of actions) {
        if (a === 'shoot_opponent') w.push(3.0);
        else if (a === 'shoot_self') w.push(0.5);
        else if (a === 'saw' || a === 'handcuffs' || a === 'cigarette' || a === 'medicine') w.push(0.6);
        else if (a === 'beer' || a === 'magnifier' || a === 'inverter' || a === 'phone') w.push(0.4);
        else w.push(0.3);
    }
    return w;
}

const OPP_MODELS = {
    uniform: oppWeightUniform,
    aggressive: oppWeightAggressive,
};

// 幂等设置：仅档位真正变化时清空对手 memo，避免冲掉预热预填。
function setOppModel(name) {
    const next = name ? (OPP_MODELS[name] || null) : null;
    if (next !== _OPP_MODEL) {
        _OPP_MODEL = next;
        _oppMemo = new Map();
    }
}

// IDDFS 每趟前清空补弹记忆：让新预算重算更优的补弹估计（逐趟定点迭代收敛）。
function clearReloadMemo() {
    _reloadMemo = new Map();
}

// ── 信念集合 ──

// known: [[offset, bool], ...] 按 offset 排序。
function knownKey(known) {
    if (!known || known.length === 0) return '';
    return known.map(([o, v]) => `${o}:${v ? 1 : 0}`).join(';');
}

const _beliefCache = new Map();

function battleBelief(live, blank, known) {
    const key = `${live},${blank}|${knownKey(known)}`;
    const hit = _beliefCache.get(key);
    if (hit !== undefined) return hit;
    const n = live + blank;
    if (n === 0) {
        _beliefCache.set(key, [[]]);
        return [[]];
    }
    const results = [];
    const knownMap = new Map(known || []);
    for (let bits = 0; bits < (1 << n); bits++) {
        let liveCount = 0;
        let ok = true;
        const shells = new Array(n);
        for (let i = 0; i < n; i++) {
            const v = ((bits >> i) & 1) === 1;
            shells[i] = v;
            if (v) liveCount++;
        }
        if (liveCount !== live) continue;
        for (const [off, val] of knownMap) {
            if (off < n && shells[off] !== val) { ok = false; break; }
        }
        if (ok) results.push(shells);
    }
    _beliefCache.set(key, results);
    return results;
}

function pLive(live, blank, known, offset = 0) {
    const bel = battleBelief(live, blank, known);
    if (bel.length === 0) return 0.0;
    let count = 0;
    for (const t of bel) {
        if (offset < t.length && t[offset]) count++;
    }
    return count / bel.length;
}

// ── 截断评估（节点/深度超限的静态近似；零和对称） ──

function battleFallback(myTurn, myHp, oppHp, live, blank, myItems, oppItems, oppCuffed) {
    let advantage = myHp - oppHp;
    advantage = Math.max(-4, Math.min(4, advantage));
    let base = 0.5 + 0.1 * advantage;
    const total = live + blank;
    if (total > 0) {
        const p = live / total;
        base += 0.05 * (p - 0.5) * (myTurn ? 1 : -1);
    }
    let myStrong = 0, oppStrong = 0;
    for (const k of myItems) if (_STRONG_ITEMS.has(k)) myStrong++;
    for (const k of oppItems) if (_STRONG_ITEMS.has(k)) oppStrong++;
    base += 0.02 * (myStrong - oppStrong);
    if (oppCuffed) base += 0.03;
    base += myTurn ? 0.05 : -0.05;
    return Math.max(0.02, Math.min(0.98, base));
}

// ── 补弹配置与道具建模 ──

const _reloadCfgCache = new Map();

// 补弹弹巢配置。引擎口径：先均匀选 total（shellsLo..shellsHi），再在 [0.40*total, 0.60*total]
// 区间内均匀选 live。返回 [live, blank, 权重]，权重和=1——否则对每种 (total,live) 等权平均会把
// live 选项多的 total（如 8 发）系统性高估（P2-1）。
function reloadCfgs(shellsLo, shellsHi) {
    const key = `${shellsLo},${shellsHi}`;
    const hit = _reloadCfgCache.get(key);
    if (hit !== undefined) return hit;
    const cfgs = [];
    const numTotals = shellsHi - shellsLo + 1;
    for (let total = shellsLo; total <= shellsHi; total++) {
        const liveMin = Math.max(1, Math.min(total - 1, Math.round(total * 0.40)));
        const liveMax = Math.max(liveMin, Math.min(total - 1, Math.round(total * 0.60)));
        const numLive = liveMax - liveMin + 1;
        for (let live = liveMin; live <= liveMax; live++) {
            cfgs.push([live, total - live, 1 / (numTotals * numLive)]);
        }
    }
    _reloadCfgCache.set(key, cfgs);
    return cfgs;
}

function removeOne(items, item) {
    const idx = items.indexOf(item);
    if (idx === -1) return items;
    const out = items.slice();
    out.splice(idx, 1);
    return out;
}

// 道具列表规范化排序：同一多重集无论生成路径顺序如何，都得到同一键。
// 补弹分支若直接追加会破坏有序性 → memo 对同状态生成不同键 → 命中率崩塌（已实测 16M 节点不收敛）。
function sortItems(items) {
    return items.length < 2 ? items : [...items].sort();
}

function withPos0(known, val) {
    const out = known.filter(([o]) => o !== 0);
    out.push([0, val]);
    out.sort((a, b) => a[0] - b[0]);
    return out;
}

function pStrong(items) {
    let availW = 0, strongW = 0;
    for (const [k, w] of Object.entries(_ITEM_WEIGHTS)) {
        if (itemCapReached(items, k)) continue;
        availW += w;
        if (_STRONG_ITEMS.has(k)) strongW += w;
    }
    return availW > 0 ? strongW / availW : 0.0;
}

function replenishExpect(nItems) {
    // 实际补 2-3 件在当前持有之上、总量上限 4：期望补件数 = E[min(R, 4 - nItems)]，R~U{2,3}。
    const room = Math.max(0, 4 - nItems);
    if (room >= 3) return 2.5;
    if (room === 2) return 2;
    if (room === 1) return 1;
    return 0;
}

function reloadItemBranches(myItems, oppItems) {
    const branchProb = items => {
        const n = items.length;
        if (n >= 4) return 0.0;
        const p = pStrong(items);
        const expN = replenishExpect(n);
        const pAny = expN > 0 ? 1.0 - Math.pow(1.0 - p, expN) : 0.0;
        return Math.max(0.0, Math.min(1.0, pAny));
    };
    const pm = branchProb(myItems);
    const po = branchProb(oppItems);
    const out = [];
    for (const myStrong of [false, true]) {
        for (const oppStrong of [false, true]) {
            const w = (myStrong ? pm : 1 - pm) * (oppStrong ? po : 1 - po);
            if (w <= 0) continue;
            out.push({
                w,
                myItems: myStrong ? sortItems([...myItems, 'saw']) : myItems,
                oppItems: oppStrong ? sortItems([...oppItems, 'saw']) : oppItems,
            });
        }
    }
    return out;
}

// ── memo 键 ──

function battleKey(myTurn, myHp, oppHp, myItems, oppItems, saw, myCuffed, oppCuffed, live, blank, known, hpCap, shellsLo, shellsHi, oppKnown = known) {
    // items 规范化排序后 join（防御：任何路径都应传已排序数组，此处兜底保证同多重集同键）。
    const mi = sortItems(myItems).join(',');
    const oi = sortItems(oppItems).join(',');
    return `${myTurn ? 1 : 0}|${myHp}|${oppHp}|${mi}|${oi}|${saw ? 1 : 0}|${myCuffed ? 1 : 0}|${oppCuffed ? 1 : 0}|${live}|${blank}|${knownKey(known)}|${knownKey(oppKnown)}|${hpCap}|${shellsLo}|${shellsHi}`;
}

function memoFor() {
    return _OPP_MODEL !== null ? _oppMemo : _battleMemo;
}

// ── 补弹期望 ──

function reloadValueComplete(myTurn, myHp, oppHp, myItems, oppItems, saw, myCuffed, oppCuffed, hpCap, shellsLo, shellsHi) {
    const cfgs = reloadCfgs(shellsLo, shellsHi);
    const itemBranches = reloadItemBranches(myItems, oppItems);
    // 补弹子博弈给「每子博弈小预算」：满深度/满预算会吃掉全局预算（满道具子博弈宽度爆炸，
    // 已实测 4M 节点单次补弹都不收敛）。子博弈浅搜后由截断评估收尾——补弹估计因此有界可算、
    // 可缓存共享，省下的预算留给主树继续精化。
    const savedDepthLimit = battleTL.depthLimit;
    battleTL.depthLimit = Math.min(savedDepthLimit, RELOAD_SUB_DEPTH);
    const subBudget = Math.max(2000, Math.floor(battleTL.limit / 256));
    let total = 0.0;
    let allOk = true;
    try {
        for (const [live, blank, cfgWeight] of cfgs) {
            for (const br of itemBranches) {
                const startNodes = battleTL.nodes;
                const savedLimit = battleTL.limit;
                // 相对子预算，且绝不超出传入的绝对上限（否则嵌套补弹会把全局预算越推越开）。
                battleTL.limit = Math.min(savedLimit, startNodes + subBudget);
                let value, complete;
                try {
                    ({ value, complete } = battleValueComplete(
                        myTurn, myHp, oppHp, br.myItems, br.oppItems, saw, myCuffed, oppCuffed,
                        live, blank, [], hpCap, shellsLo, shellsHi,
                    ));
                } finally {
                    battleTL.limit = savedLimit;
                }
                total += cfgWeight * br.w * value;
                allOk = allOk && complete;
            }
        }
    } finally {
        battleTL.depthLimit = savedDepthLimit;
    }
    return { value: total, complete: allOk };
}

// ── 补弹期望（记忆化 + 定点一步） ──

function reloadStateKey(myTurn, myHp, oppHp, myItems, oppItems, saw, myCuffed, oppCuffed, hpCap, shellsLo, shellsHi) {
    return `${myTurn ? 1 : 0}|${myHp}|${oppHp}|${sortItems(myItems).join(',')}|${sortItems(oppItems).join(',')}|${saw ? 1 : 0}|${myCuffed ? 1 : 0}|${oppCuffed ? 1 : 0}|${hpCap}|${shellsLo}|${shellsHi}`;
}

function reloadValueCached(myTurn, myHp, oppHp, myItems, oppItems, saw, myCuffed, oppCuffed, hpCap, shellsLo, shellsHi) {
    const key = reloadStateKey(myTurn, myHp, oppHp, myItems, oppItems, saw, myCuffed, oppCuffed, hpCap, shellsLo, shellsHi);
    const hit = _reloadMemo.get(key);
    if (hit !== undefined) return hit;
    // 初始估计 = 静态 fallback（优于 0.5），并标记 in-progress 打破自指：
    // 子博弈内部再遇同状态空仓会命中此估计，定点迭代一步后再写入最终值。
    _reloadMemo.set(key, {
        value: battleFallback(myTurn, myHp, oppHp, 0, 0, myItems, oppItems, oppCuffed),
        complete: true,
    });
    const val = reloadValueComplete(myTurn, myHp, oppHp, myItems, oppItems, saw, myCuffed, oppCuffed, hpCap, shellsLo, shellsHi);
    // 补弹估计视为完备终点：确定性定点近似，使整树有限可解、memo 全生效（预算越大越接近真值）。
    const out = { value: val.value, complete: true };
    _reloadMemo.set(key, out);
    return out;
}

// ── 核心：信念博弈 EV ──

function battleValueComplete(myTurn, myHp, oppHp, myItems, oppItems, saw, myCuffed, oppCuffed, live, blank, known, hpCap, shellsLo, shellsHi, oppKnown = known) {
    const key = battleKey(myTurn, myHp, oppHp, myItems, oppItems, saw, myCuffed, oppCuffed, live, blank, known, hpCap, shellsLo, shellsHi, oppKnown);
    const memo = memoFor();
    const cached = memo.get(key);
    if (cached !== undefined) return { value: cached, complete: true };

    if (myHp <= 0) return { value: 0.0, complete: true };
    if (oppHp <= 0) return { value: 1.0, complete: true };
    if (live + blank <= 0) {
        // 用记忆化的定点估计替代直接展开（补弹子树自指，不缓存则指数爆炸、永不收敛）。
        const r = reloadValueCached(myTurn, myHp, oppHp, myItems, oppItems, saw, myCuffed, oppCuffed, hpCap, shellsLo, shellsHi);
        if (r.complete) memo.set(key, r.value);
        return r;
    }
    if (battleTL.nodes > battleTL.limit || battleTL.depth > battleTL.depthLimit) {
        return {
            value: battleFallback(myTurn, myHp, oppHp, live, blank, myItems, oppItems, oppCuffed),
            complete: false,
        };
    }
    // 时间截止：每 ~1024 节点采样一次，超时即放弃（不可缓存），保证 maxMs 内返回。
    if (battleTL.deadline > 0 && (battleTL.nodes & 1023) === 0 && Date.now() > battleTL.deadline) {
        return {
            value: battleFallback(myTurn, myHp, oppHp, live, blank, myItems, oppItems, oppCuffed),
            complete: false,
        };
    }
    battleTL.nodes += 1;
    battleTL.depth += 1;
    let r;
    try {
        r = battleValueInnerComplete(myTurn, myHp, oppHp, myItems, oppItems, saw, myCuffed, oppCuffed, live, blank, known, hpCap, shellsLo, shellsHi, oppKnown);
    } finally {
        battleTL.depth -= 1;
    }
    if (r.complete) {
        memo.set(key, r.value);
        if (_battleMemo.size > MEMO_GUARD) _battleMemo = new Map();
        if (_oppMemo.size > MEMO_GUARD) _oppMemo = new Map();
    }
    return r;
}

// ── 动作期望枚举（P3：双情报带 myKnown=known / oppKnown） ──

function actorActionEvs(myTurn, myHp, oppHp, myItems, oppItems, saw, myCuffed, oppCuffed, live, blank, known, hpCap, shellsLo, shellsHi, oppKnown = known) {
    const p0 = pLive(live, blank, known, 0);
    const actorIsMe = myTurn;
    const meHp = actorIsMe ? myHp : oppHp;
    const opHp = actorIsMe ? oppHp : myHp;
    const meItems = actorIsMe ? myItems : oppItems;
    const opItems = actorIsMe ? oppItems : myItems;
    const meCuffed = actorIsMe ? myCuffed : oppCuffed;
    const opCuffed = actorIsMe ? oppCuffed : myCuffed;

    const shift = k => k.filter(([o]) => o >= 1).map(([o, v]) => [o - 1, v]).sort((a, b) => a[0] - b[0]);
    const addReveal = (k, pos, val) => {
        const out = k.filter(([o]) => o !== pos);
        out.push([pos, val]);
        return out.sort((a, b) => a[0] - b[0]);
    };

    // 子局状态（我方视角）：known(11)=我知情，oppKnown(15)=对手知情。
    // 公开事件（开枪/啤酒/逆转器）双带同更新；私有道具（放大镜/手机）只更新行动者自己的带。
    const emit = (localTurn, mHp, oHp, mItems, oItems, sawL, mCuffed, oCuffed, nLive, nBlank, nMy, nOpp) => {
        if (actorIsMe) {
            return [localTurn, mHp, oHp, mItems, oItems, sawL, mCuffed, oCuffed, nLive, nBlank, nMy, hpCap, shellsLo, shellsHi, nOpp];
        }
        return [!localTurn, oHp, mHp, oItems, mItems, sawL, oCuffed, mCuffed, nLive, nBlank, nMy, hpCap, shellsLo, shellsHi, nOpp];
    };

    const ev = branches => {
        let tot = 0.0;
        let ok = true;
        for (const [w, ns] of branches) {
            const { value, complete } = battleValueComplete(...ns);
            tot += w * value;
            ok = ok && complete;
        }
        return [tot, ok];
    };

    const shootBranches = goSelf => {
        const out = [];
        for (const obs of [true, false]) {
            const w = obs ? p0 : 1 - p0;
            if (w <= 0) continue;
            const dmg = (saw && obs) ? 2 : 1;
            let mHp2 = meHp, oHp2 = opHp;
            if (obs) {
                if (goSelf) mHp2 = meHp - dmg;
                else oHp2 = opHp - dmg;
            }
            const keep = !obs && goSelf; // 打自己+空弹保回合；其余换手
            const localTurn = keep;
            const nLive = live - (obs ? 1 : 0);
            const nBlank = blank - (obs ? 0 : 1);
            let nMy = shift(known), nOpp = shift(oppKnown);
            if (nLive + nBlank <= 0) { nMy = []; nOpp = []; }
            out.push([w, emit(localTurn, mHp2, oHp2, meItems, opItems, false, meCuffed, opCuffed, nLive, nBlank, nMy, nOpp)]);
        }
        return out;
    };

    const itemBranches = (item, mItemsCur, oItemsCur) => {
        if (item === 'magnifier') {
            const out = [];
            for (const obs of [true, false]) {
                const w = obs ? p0 : 1 - p0;
                if (w <= 0) continue;
                const nMy = actorIsMe ? addReveal(known, 0, obs) : known;
                const nOpp = actorIsMe ? oppKnown : addReveal(oppKnown, 0, obs);
                out.push([w, emit(true, meHp, opHp, mItemsCur, oItemsCur, saw, meCuffed, opCuffed, live, blank, nMy, nOpp)]);
            }
            return out;
        }
        if (item === 'cigarette') {
            return [[1.0, emit(true, Math.min(meHp + 1, hpCap), opHp, mItemsCur, oItemsCur, saw, meCuffed, opCuffed, live, blank, known, oppKnown)]];
        }
        if (item === 'beer') {
            const out = [];
            for (const obs of [true, false]) {
                const w = obs ? p0 : 1 - p0;
                if (w <= 0) continue;
                const nLive = live - (obs ? 1 : 0);
                const nBlank = blank - (obs ? 0 : 1);
                if (nLive + nBlank <= 0) {
                    // 弹掉最后一发：重装 + 结束回合（回合给对方）
                    out.push([w, emit(false, meHp, opHp, mItemsCur, oItemsCur, saw, meCuffed, opCuffed, 0, 0, [], [])]);
                } else {
                    out.push([w, emit(true, meHp, opHp, mItemsCur, oItemsCur, saw, meCuffed, opCuffed, nLive, nBlank, shift(known), shift(oppKnown))]);
                }
            }
            return out;
        }
        if (item === 'saw') {
            return [[1.0, emit(true, meHp, opHp, mItemsCur, oItemsCur, true, meCuffed, opCuffed, live, blank, known, oppKnown)]];
        }
        if (item === 'handcuffs') {
            return [[1.0, emit(true, meHp, opHp, mItemsCur, oItemsCur, saw, meCuffed, true, live, blank, known, oppKnown)]];
        }
        if (item === 'phone') {
            const nTotal = live + blank;
            if (nTotal <= 1) return [];
            const out = [];
            for (let off = 1; off < nTotal; off++) {
                const pk = pLive(live, blank, known, off);
                for (const obs of [true, false]) {
                    const w = (1.0 / (nTotal - 1)) * (obs ? pk : 1 - pk);
                    if (w <= 0) continue;
                    const nMy = actorIsMe ? addReveal(known, off, obs) : known;
                    const nOpp = actorIsMe ? oppKnown : addReveal(oppKnown, off, obs);
                    out.push([w, emit(true, meHp, opHp, mItemsCur, oItemsCur, saw, meCuffed, opCuffed, live, blank, nMy, nOpp)]);
                }
            }
            return out;
        }
        if (item === 'inverter') {
            const out = [];
            // 按「读真实计数」近似：翻转后 pos0 已知（公开事件，双带更新）。
            if (p0 > 0) {
                out.push([p0, emit(true, meHp, opHp, mItemsCur, oItemsCur, saw, meCuffed, opCuffed, live - 1, blank + 1, withPos0(known, false), withPos0(oppKnown, false))]);
            }
            if (1 - p0 > 0) {
                out.push([1 - p0, emit(true, meHp, opHp, mItemsCur, oItemsCur, saw, meCuffed, opCuffed, live + 1, blank - 1, withPos0(known, true), withPos0(oppKnown, true))]);
            }
            return out;
        }
        if (item === 'medicine') {
            return [
                [0.4, emit(true, Math.min(meHp + 2, hpCap), opHp, mItemsCur, oItemsCur, saw, meCuffed, opCuffed, live, blank, known, oppKnown)],
                [0.6, emit(true, meHp - 1, opHp, mItemsCur, oItemsCur, saw, meCuffed, opCuffed, live, blank, known, oppKnown)],
            ];
        }
        return [];
    };

    // 公平预算：按动作数均分 limit，每动作子树预算独立——否则第一个动作吃光预算、
    // 其余全 fallback，动作 EV 顺序偏置（已实测）。
    // 跳过纯浪费/no-op 道具动作：满血用烟（回复 0，严格劣于保留道具）；当前弹已知时用放大镜
    // （揭示无新信息）。这类动作在公平预算下会给"同一行动者继续走更深子树"的伪高值，导致
    // 求解器做无意义动作（已实测：庄家满血抽烟）。
    const actorBelt = actorIsMe ? known : oppKnown;
    const evaluableItems = meItems.filter(it => {
        if (it === 'adrenaline') return false; // 单独处理（bestAdv）
        if (it === 'saw' && saw) return false;
        if (it === 'handcuffs' && opCuffed) return false;
        if (it === 'phone' && live + blank <= 1) return false;
        if (it === 'cigarette' && meHp >= hpCap) return false;
        if (it === 'magnifier' && actorBelt.some(([o]) => o === 0)) return false;
        return true;
    });
    let numActions = 2 + evaluableItems.length;
    if (meItems.includes('adrenaline') && opItems.some(i => i !== 'adrenaline')) numActions++;
    const actionBudget = Math.max(2000, Math.floor(battleTL.limit / Math.max(1, numActions)));
    const boundedEv = branches => {
        const start = battleTL.nodes;
        const saved = battleTL.limit;
        battleTL.limit = Math.min(saved, start + actionBudget);
        try {
            return ev(branches);
        } finally {
            battleTL.limit = saved;
        }
    };

    const actEvs = [];
    const [ev0, ok0] = boundedEv(shootBranches(false));
    actEvs.push(['shoot_opponent', null, ev0, ok0]);
    const [ev1, ok1] = boundedEv(shootBranches(true));
    actEvs.push(['shoot_self', null, ev1, ok1]);
    for (const item of evaluableItems) {
        const [e, ok] = boundedEv(itemBranches(item, removeOne(meItems, item), opItems));
        actEvs.push([item, null, e, ok]);
    }
    if (meItems.includes('adrenaline')) {
        let bestAdv = null;
        for (const steal of opItems) {
            if (steal === 'adrenaline') continue;
            const [e, ok] = boundedEv(itemBranches(steal, removeOne(meItems, 'adrenaline'), removeOne(opItems, steal)));
            // 我方回合挑对自己最有利的偷（max）；对手回合对手挑对我方最不利的偷（min）。
            if (bestAdv === null || (actorIsMe ? (e > bestAdv[0]) : (e < bestAdv[0]))) {
                bestAdv = [e, ok, steal];
            }
        }
        if (bestAdv !== null) actEvs.push(['adrenaline', bestAdv[2], bestAdv[0], bestAdv[1]]);
    }
    return actEvs;
}

// 对手在私有情报下的开枪 EV：用 oppKnown 的 pos0 概率重加权「我方信念带」的子局值
// （子局在本节点 actorActionEvs 已算过 → memo 热命中，几乎零成本）。对手选动作用（min）。
function opponentShootEV(goSelf, live, blank, saw, knownMy, knownOpp, myHp, oppHp, myItems, oppItems, myCuffed, oppCuffed, hpCap, shellsLo, shellsHi) {
    const pOpp = pLive(live, blank, knownOpp, 0);
    const dmg = saw ? 2 : 1;
    let tot = 0.0;
    for (const obs of [true, false]) {
        const w = obs ? pOpp : 1 - pOpp;
        if (w <= 0) continue;
        let mHp2 = myHp, oHp2 = oppHp;
        if (obs) {
            if (goSelf) oHp2 = oppHp - dmg; // 对手打自己=扣对手血
            else mHp2 = myHp - dmg;         // 对手打我=扣我血
        }
        const childTurn = !(!obs && goSelf); // 空弹打自己保回合 → 仍是对手回合(myTurn=false)
        const nLive = live - (obs ? 1 : 0);
        const nBlank = blank - (obs ? 0 : 1);
        const shift = k => k.filter(([o]) => o >= 1).map(([o, v]) => [o - 1, v]).sort((a, b) => a[0] - b[0]);
        let nMy = shift(knownMy), nOpp = shift(knownOpp);
        if (nLive + nBlank <= 0) { nMy = []; nOpp = []; }
        const { value } = battleValueComplete(childTurn, mHp2, oHp2, myItems, oppItems, false, myCuffed, oppCuffed, nLive, nBlank, nMy, hpCap, shellsLo, shellsHi, nOpp);
        tot += w * value;
    }
    return tot;
}

// ── 内层：当前行动者最优动作 EV（我方胜率口径） ──

function battleValueInnerComplete(myTurn, myHp, oppHp, myItems, oppItems, saw, myCuffed, oppCuffed, live, blank, known, hpCap, shellsLo, shellsHi, oppKnown = known) {
    // 手铐跳过：被铐的玩家轮到时直接跳过（消耗手铐），回合给对方。
    if (myTurn && myCuffed) {
        return battleValueComplete(false, myHp, oppHp, myItems, oppItems, saw, false, oppCuffed, live, blank, known, hpCap, shellsLo, shellsHi, oppKnown);
    }
    if ((!myTurn) && oppCuffed) {
        return battleValueComplete(true, myHp, oppHp, myItems, oppItems, saw, myCuffed, false, live, blank, known, hpCap, shellsLo, shellsHi, oppKnown);
    }
    const evs = actorActionEvs(myTurn, myHp, oppHp, myItems, oppItems, saw, myCuffed, oppCuffed, live, blank, known, hpCap, shellsLo, shellsHi, oppKnown);
    if (evs.length === 0) return { value: 0.5, complete: true };
    if (myTurn) {
        let best = null;
        for (const [a, s, v, ok] of evs) {
            if (best === null || v > best[2]) best = [a, s, v, ok];
        }
        return { value: best[2], complete: best[3] };
    }
    if (_OPP_MODEL !== null) {
        const theta = _OPP_MODEL(evs);
        let tot = 0.0, wsum = 0.0;
        let ok = true;
        for (let i = 0; i < evs.length; i++) {
            const [, , ev, okv] = evs[i];
            const w = theta[i];
            if (okv) {
                tot += w * ev;
                wsum += w;
            } else {
                ok = false;
            }
        }
        return { value: wsum > 0 ? tot / wsum : 0.5, complete: ok };
    }
    // 纯 minimax + 对手私有情报：对手按 oppKnown 选动作（min），返回被选动作在我方 known 下的 EV。
    const pMy0 = pLive(live, blank, known, 0);
    const pOpp0 = pLive(live, blank, oppKnown, 0);
    const beliefGap = Math.abs(pOpp0 - pMy0) > 1e-12;
    let best = null; // [myEV, ok, oppEV]
    for (const [a, s, v, ok] of evs) {
        let evOpp = v;
        if (beliefGap && (a === 'shoot_opponent' || a === 'shoot_self')) {
            evOpp = opponentShootEV(a === 'shoot_self', live, blank, saw, known, oppKnown, myHp, oppHp, myItems, oppItems, myCuffed, oppCuffed, hpCap, shellsLo, shellsHi);
        }
        if (best === null || evOpp < best[2]) best = [v, ok, evOpp];
    }
    return { value: best[0], complete: best[1] };
}

// 时间封顶的最优决策（60s 真最优的决策器）：IDDFS 逐趟翻倍预算直到完备或 maxMs 超时。
// 末趟未完备时，用已缓存的部分值选动作——比固定预算更充分利用给定时间窗。
// 不做节点数硬封顶：只有 maxMs 时间窗是边界（递归内每 1024 节点采样退出），
// 否则「预算翻到某个上限但时间没到」会提前停在不完备结果上，违背真最优目标。
function battleBestActionTimed(myHp, oppHp, myItems, oppItems, saw, myCuffed, oppCuffed, live, blank, known, hpCap, shellsLo, shellsHi, {
    maxMs = 10_000, startBudget = 50_000, factor = 4,
} = {}, oppKnown = known) {
    const args = [true, myHp, oppHp, myItems, oppItems, saw, myCuffed, oppCuffed, live, blank, known, hpCap, shellsLo, shellsHi, oppKnown];
    const t0 = Date.now();
    battleTL.deadline = t0 + maxMs; // 递归内按 deadline 采样退出，严格控制在 maxMs 内
    let budget = startBudget;
    let complete = false;
    while (!complete) {
        battleTL.nodes = 0;
        battleTL.limit = budget;
        battleTL.depth = 0;
        clearReloadMemo();
        const r = battleValueComplete(...args);
        complete = r.complete;
        if (complete || Date.now() >= battleTL.deadline) break;
        budget *= factor;
    }
    // 选动作也在 deadline 内：memo 只存完备值，未完备子树重算可能很久——deadline 必须保持到选完。
    const evs = actorActionEvs(...args);
    battleTL.deadline = 0;
    if (evs.length === 0) return { action: 'shoot_opponent', steal: null, complete, ms: Date.now() - t0 };
    let best = null;
    for (const [a, s, v] of evs) {
        if (best === null || v > best[2]) best = [a, s, v];
    }
    return { action: best[0], steal: best[1], complete, ms: Date.now() - t0 };
}

module.exports = {
    battleBestActionTimed,
    setOppModel,
    battleTL,
};
