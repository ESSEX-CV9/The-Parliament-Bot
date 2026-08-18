/**
 * 恶魔轮盘纯状态机（CommonJS，零依赖，可注入 rng 复现）。
 *
 * 一局定胜负、9 件道具、私密情报（known_shells）、逆转器遮蔽计数、
 * 手铐连锁跳过、空仓补弹道具补满。
 *
 * 所有回合不变量都在这里维护；Discord 交互层只允许调用 apply() 并渲染返回的状态，
 * 不得直接改 hp/shells/turnPlayerId。
 */

const ITEM_KEYS = Object.freeze([
    'magnifier', 'cigarette', 'beer', 'saw', 'handcuffs',
    'phone', 'inverter', 'adrenaline', 'medicine',
]);

const ITEM_DEFS = Object.freeze({
    magnifier: { key: 'magnifier', emoji: '🔍', name: '放大镜', description: '查看当前枪膛这一发是实弹还是空弹。' },
    cigarette: { key: 'cigarette', emoji: '🚬', name: '香烟', description: '回复 1 点生命。' },
    beer: { key: 'beer', emoji: '🍺', name: '啤酒', description: '弹出当前膛内子弹（仅剩最后一发时结束回合）。' },
    saw: { key: 'saw', emoji: '🪚', name: '手锯', description: '下一发实弹伤害翻倍（2 点）。' },
    handcuffs: { key: 'handcuffs', emoji: '🔗', name: '手铐', description: '让对手下一回合无法行动。' },
    phone: { key: 'phone', emoji: '📱', name: '手机', description: '预知往后某一发是什么弹（相对当前弹位）。' },
    inverter: { key: 'inverter', emoji: '🔄', name: '逆转器', description: '把当前膛内子弹翻转为相反类型。' },
    adrenaline: { key: 'adrenaline', emoji: '💉', name: '肾上腺素', description: '偷取对手一件道具并立即使用。' },
    medicine: { key: 'medicine', emoji: '💊', name: '过期药', description: '40% 回复 2 点生命，否则失去 1 点。' },
});

// 单件上限：终结/强控（手锯/手铐/肾上腺素/逆转器）各最多 1 件（防叠双锯/双铐/连偷）；
// 情报/膛内工具（放大镜/手机/啤酒）默认 2 件。
const ITEM_MAX_COUNT = Object.freeze({
    saw: 1,
    handcuffs: 1,
    adrenaline: 1,
    inverter: 1,
    cigarette: 1,
    medicine: 1,
});
const ITEM_DEFAULT_MAX_COUNT = 2;

// 共用上限：回复类（香烟/过期药）合计最多 1 件——不叠加、不兼得；
// 终结/强控类（手锯/手铐/肾上腺素）合计最多 1 件——留了任意一件，补发不再给
// 这三类里的任何一件（防「上轮留锯、这轮又白拿手铐」的跨类囤强道具）。
const ITEM_GROUP_CAPS = Object.freeze([
    { group: Object.freeze(['cigarette', 'medicine']), max: 1 },
    { group: Object.freeze(['saw', 'handcuffs', 'adrenaline']), max: 1 },
]);

// 道具强度权重（统一平衡，2026-08-15 第三轮微调）：
//   稀有(2) 手锯/手铐/肾上腺素 —— 终结/节奏/控场杀手，最决定胜负的三件；
//   少见(3) 放大镜 —— 看当前弹，情报向；
//   常见(4) 逆转器/手机/啤酒 —— 翻转膛弹/情报/膛内工具；
//   最常见(5) 香烟/过期药 —— 回复续航，但与对方共用总上限 1。
const ITEM_WEIGHTS = Object.freeze({
    handcuffs: 2,
    adrenaline: 2,
    saw: 2,
    magnifier: 3,
    inverter: 4,
    phone: 4,
    beer: 4,
    cigarette: 5,
    medicine: 5,
});

const MAX_ITEM_SLOTS = 4;

// 单局配置（一局定胜负）：血量/弹巢/道具数。
// 道具：开局随机发 2-3 件；空仓补弹在当前持有之上实际补 2-3 件（双方同数，总量上限 4）。
// 实弹占比 40%-60%：均值公平 50%，但砍掉最极端的"地狱弹巢"（信息道具收紧后人类无探雷手段硬扛）。
const GAME_CONFIG = Object.freeze({
    hp: 4, shells: [5, 8], liveRatio: [0.40, 0.60], itemsStart: [2, 3], itemsRefill: [2, 3],
});

// 认输血量下限与惩罚口径（供交互层使用）。
const SURRENDER_MIN_HP = 2;

class InvalidAction extends Error {
    constructor(message) {
        super(message);
        this.name = 'InvalidAction';
    }
}

// 默认值全字段齐全的稠密结果对象（交互层可放心读取任意字段）。
function defaultActionResult(action, actorId) {
    return {
        action, actorId,
        targetId: null, hit: null, damage: 0, sawDoubled: false,
        killedId: null, reloaded: false, roundEnded: false,
        gameEnded: false, gameWinnerId: null,
        itemKey: null, reveal: null, healed: 0, fullHp: false, lostHp: 0,
        ejected: false, ejectedLive: null, flipped: false, handcuffedId: null, stolenKey: null,
    };
}

function assert(cond, msg) {
    if (!cond) throw new InvalidAction(msg);
}

// ── 默认 RNG（Math.random 实现；可在构造时注入同接口 rng 做确定性回放） ──────

function shuffleFisherYates(arr, random) {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

function weightedChoice(pool, weights, random) {
    let total = 0;
    for (const w of weights) total += w;
    let r = random() * total;
    for (let i = 0; i < pool.length; i++) {
        r -= weights[i];
        if (r <= 0) return pool[i];
    }
    return pool[pool.length - 1];
}

// 生产 RNG：接口提供 random/randint/choice/choices/shuffle。
// 需要确定性回放时可在 DevilState 构造时注入同接口的自定义 rng。
function defaultRng() {
    return {
        random: Math.random,
        randint: (a, b) => a + Math.floor(Math.random() * (b - a + 1)),
        choice: arr => arr[Math.floor(Math.random() * arr.length)],
        choices: (pool, weights, k = 1) => {
            const out = [];
            for (let i = 0; i < k; i++) out.push(weightedChoice(pool, weights, Math.random));
            return out;
        },
        // shuffle 必须原地改写 arr 并返回它。若只返回 shuffleFisherYates 的副本而不改原数组，
        // 调用方 `_reloadShells` 拿到的是未洗牌的原数组，实弹恒在弹巢头部、空弹恒在尾部
        // （生产弹巢 100% 头部聚类）——"打自己必中实弹"的根因，务必保持原地改写。
        shuffle: arr => {
            const shuffled = shuffleFisherYates(arr, Math.random);
            for (let i = 0; i < arr.length; i++) arr[i] = shuffled[i];
            return arr;
        },
    };
}

// ── 状态机 ─────────────────────────────────────────────────────────────────────

class DevilState {
    constructor(playerIds, { rng = null, alternateFirstTurn = false } = {}) {
        const unique = [...new Set(playerIds)];
        assert(unique.length === 2, '恶魔轮盘需要正好两名玩家');
        this.rng = rng || defaultRng();
        // PVP 交替先手：每次装弹周期（新弹巢）先手硬重置为上一周期先手的对方，斩断出手权继承。
        this.alternateFirstTurn = alternateFirstTurn;
        this.players = unique;
        this.phase = 'playing';
        this.winnerId = null;
        this.hp = { [unique[0]]: 0, [unique[1]]: 0 };
        this.items = { [unique[0]]: [], [unique[1]]: [] };
        // 私密情报：每个玩家已知的弹位（index -> 实弹 bool）。
        this.knownShells = { [unique[0]]: {}, [unique[1]]: {} };
        this.shells = [];
        this.pointer = 0;
        this.sawArmed = false;
        this.handcuffed = new Set();
        this.turnPlayerId = unique[0];
        this.turnToken = 0;
        // 当前装弹周期的先手（用于下一周期的交替判定）。
        this.loadFirstPlayer = null;
        // 逆转器翻转当前弹后，公开的实弹/空弹计数会泄露翻转前类型 → 面板显示 ？？直到当前弹被击发。
        this.inverterObscured = false;
        this._startRound(null);
    }

    // ── 派生状态 ──

    get currentPlayerId() {
        return this.phase === 'ended' ? null : this.turnPlayerId;
    }

    get liveRemaining() {
        return this.shells.slice(this.pointer).filter(Boolean).length;
    }

    get totalRemaining() {
        return this.shells.length - this.pointer;
    }

    get blankRemaining() {
        return this.totalRemaining - this.liveRemaining;
    }

    other(playerId) {
        return this.players[0] === playerId ? this.players[1] : this.players[0];
    }

    hpText(playerId) {
        const hp = Math.max(0, this.hp[playerId]);
        const maxHp = GAME_CONFIG.hp;
        return `${'❤️'.repeat(hp)}${'🖤'.repeat(maxHp - hp)}（${hp}/${maxHp}）`;
    }

    // ── 装填 ──

    _startRound(firstPlayer) {
        const cfg = GAME_CONFIG;
        for (const pid of this.players) this.hp[pid] = cfg.hp;
        this.sawArmed = false;
        this.handcuffed.clear();
        this._reloadShells(false);
        this.turnPlayerId = firstPlayer != null ? firstPlayer : this.rng.choice(this.players);
        // 记录本装弹周期的先手（下一周期交替判定用）。
        this.loadFirstPlayer = this.turnPlayerId;
    }

    _rollShells() {
        const cfg = GAME_CONFIG;
        const total = this.rng.randint(cfg.shells[0], cfg.shells[1]);
        const [ratioMin, ratioMax] = cfg.liveRatio;
        const liveMin = Math.max(1, Math.min(total - 1, Math.round(total * ratioMin)));
        const liveMax = Math.max(liveMin, Math.min(total - 1, Math.round(total * ratioMax)));
        const live = this.rng.randint(liveMin, liveMax);
        return { live, blank: total - live };
    }

    _reloadShells(topUp) {
        const { live, blank } = this._rollShells();
        const shells = [];
        for (let i = 0; i < live; i++) shells.push(true);
        for (let i = 0; i < blank; i++) shells.push(false);
        this.rng.shuffle(shells);
        this.shells = shells;
        this.pointer = 0;
        this.inverterObscured = false; // 全新弹序，计数恢复可信
        // 新弹序：所有人已探明的弹位全部作废。
        this.knownShells = { [this.players[0]]: {}, [this.players[1]]: {} };
        if (topUp) this._topUpItems();
        else this._distributeItems();
    }

    // 是否还能获得该道具：单件上限 + 共用组上限（回复类香烟/过期药合计≤1）。
    canAcquireItem(playerId, itemKey) {
        const items = this.items[playerId];
        if (items.filter(x => x === itemKey).length >= (ITEM_MAX_COUNT[itemKey] ?? ITEM_DEFAULT_MAX_COUNT)) {
            return false;
        }
        for (const { group, max } of ITEM_GROUP_CAPS) {
            if (group.includes(itemKey) && items.filter(x => group.includes(x)).length >= max) {
                return false;
            }
        }
        return true;
    }

    _rollItemKey(playerId) {
        const pool = ITEM_KEYS.filter(k => this.canAcquireItem(playerId, k));
        if (pool.length === 0) return null;
        const weights = pool.map(k => ITEM_WEIGHTS[k] ?? 1);
        return this.rng.choices(pool, weights, 1)[0];
    }

    _distributeItems() {
        const count = this.rng.randint(GAME_CONFIG.itemsStart[0], GAME_CONFIG.itemsStart[1]);
        for (const playerId of this.players) {
            for (let i = 0; i < count; i++) {
                if (this.items[playerId].length >= MAX_ITEM_SLOTS) break;
                const key = this._rollItemKey(playerId);
                if (key === null) break;
                this.items[playerId].push(key);
            }
        }
    }

    _topUpItems() {
        // 实际补 2-3 件在当前持有之上（不追平到固定数），双方补相同数量；
        // 总量受 MAX_ITEM_SLOTS 限制（接近上限时实际补得少）。
        const [lo, hi] = GAME_CONFIG.itemsRefill;
        const refill = this.rng.randint(lo, hi);
        for (const playerId of this.players) {
            for (let i = 0; i < refill; i++) {
                if (this.items[playerId].length >= MAX_ITEM_SLOTS) break;
                const key = this._rollItemKey(playerId);
                if (key === null) break;
                this.items[playerId].push(key);
            }
        }
    }

    _setTurn(nextPlayer) {
        // 手铐连锁跳过：最多跳过两名玩家（双方同时被铐的极端情况），避免死循环。
        for (let i = 0; i < 2; i++) {
            if (this.handcuffed.has(nextPlayer)) {
                this.handcuffed.delete(nextPlayer);
                nextPlayer = this.other(nextPlayer);
            } else {
                break;
            }
        }
        this.turnPlayerId = nextPlayer;
    }

    // 新装弹周期（PVP 交替制）：先手 = 上一周期先手的对方，彻底斩断出手权继承。
    // 周期边界手铐完全作废——上周期末锁的铐只作用于上周期的时间，弹巢重洗羁绊即断；
    // 交替先手是硬规则，不因手铐改写新周期先手（loadFirstPlayer 恒记名义先手）。
    _beginNewCylinderCycle() {
        this.handcuffed.clear();
        this.turnPlayerId = this.other(this.loadFirstPlayer);
        this.loadFirstPlayer = this.turnPlayerId;
    }

    // ── 快照（断连接续） ──

    serialize() {
        return {
            players: this.players,
            alternateFirstTurn: this.alternateFirstTurn,
            phase: this.phase,
            winnerId: this.winnerId,
            hp: this.hp,
            items: this.items,
            knownShells: this.knownShells,
            shells: this.shells,
            pointer: this.pointer,
            sawArmed: this.sawArmed,
            handcuffed: [...this.handcuffed],
            turnPlayerId: this.turnPlayerId,
            turnToken: this.turnToken,
            loadFirstPlayer: this.loadFirstPlayer,
            inverterObscured: this.inverterObscured,
        };
    }

    // 从快照重建状态。构造函数会先随机一次弹巢/道具，这里全量覆盖成保存时的值，
    // 因此 rng 用 defaultRng 即可（续局不要求与中断前同随机序列）。
    static restore(data) {
        const s = new DevilState(data.players, {
            rng: defaultRng(),
            alternateFirstTurn: !!data.alternateFirstTurn,
        });
        s.phase = data.phase;
        s.winnerId = data.winnerId;
        s.hp = data.hp || {};
        s.items = data.items || {};
        s.knownShells = data.knownShells || {};
        s.shells = data.shells || [];
        s.pointer = data.pointer || 0;
        s.sawArmed = !!data.sawArmed;
        s.handcuffed = new Set(data.handcuffed || []);
        s.turnPlayerId = data.turnPlayerId;
        s.turnToken = data.turnToken || 0;
        s.loadFirstPlayer = data.loadFirstPlayer || null;
        s.inverterObscured = !!data.inverterObscured;
        return s;
    }

    _forgetShell(index) {
        for (const known of Object.values(this.knownShells)) delete known[index];
    }

    _damage(targetId, amount) {
        this.hp[targetId] = Math.max(0, this.hp[targetId] - amount);
        return this.hp[targetId] <= 0 ? targetId : null;
    }

    _finishRound(killedId, result) {
        // 一局定胜负：有人倒下即终局，对手赢下本局。
        const winner = this.other(killedId);
        result.killedId = killedId;
        this.phase = 'ended';
        this.winnerId = winner;
        result.roundEnded = true;
        result.gameEnded = true;
        result.gameWinnerId = winner;
        return result;
    }

    // ── 合法性判断 ──

    canUseItem(userId, itemKey) {
        if (this.phase !== 'playing' || userId !== this.turnPlayerId) return false;
        if (!this.items[userId].includes(itemKey)) return false;
        if (itemKey === 'phone' && this.totalRemaining <= 1) return false; // 没有未来弹位可探
        if (itemKey === 'handcuffs') {
            if (this.totalRemaining <= 1) return false; // 马上重洗：锁不住有意义的下一回合
            if (this.handcuffed.has(this.other(userId))) return false; // 对手已被铐住
        }
        if (itemKey === 'adrenaline') return this._stealableItems(userId).length > 0;
        return true;
    }

    _stealableItems(userId) {
        const opponent = this.other(userId);
        // 去重：对手持有重复道具时，肾上腺素选择菜单的 option value 必须唯一（否则 Discord 400）。
        return [...new Set(this.items[opponent].filter(item => item !== 'adrenaline'))];
    }

    _smartStealChoice(userId, stealable) {
        // 未指定偷取目标时的兜底偏好：残血优先回复，其次进攻性道具，最后随机。
        const maxHp = GAME_CONFIG.hp;
        if (this.hp[userId] < maxHp) {
            for (const key of ['cigarette', 'medicine']) {
                if (stealable.includes(key)) return key;
            }
        }
        for (const key of ['saw', 'beer', 'handcuffs', 'inverter']) {
            if (stealable.includes(key)) return key;
        }
        return this.rng.choice(stealable);
    }

    // ── 入口 ──

    apply(action, actorId, { expectedToken = null, stealKey = null } = {}) {
        assert(this.phase !== 'ended', '这局已经结束了。');
        if (expectedToken != null) assert(expectedToken === this.turnToken, '这个按钮已经过期，请看最新面板。');
        assert(actorId === this.turnPlayerId, '现在还没轮到你。');

        let result;
        if (action === 'shoot_self') result = this._shoot(actorId, 'self');
        else if (action === 'shoot_opponent') result = this._shoot(actorId, 'opponent');
        else if (action === 'adrenaline') result = this._useAdrenaline(actorId, stealKey);
        else if (ITEM_DEFS[action]) result = this._useItem(actorId, action);
        else throw new InvalidAction('未知操作。');
        this.turnToken += 1;
        return result;
    }

    // ── 开枪 ──

    _shoot(actorId, target) {
        const shell = this.shells[this.pointer];
        const firedIndex = this.pointer;
        this.pointer += 1;
        this.inverterObscured = false; // 当前弹已击发，计数恢复可信
        const armed = this.sawArmed;
        this.sawArmed = false;
        this._forgetShell(firedIndex);

        const targetId = target === 'self' ? actorId : this.other(actorId);
        const hit = shell;
        let damage = 0;
        let killedId = null;
        if (hit) {
            damage = armed ? 2 : 1;
            killedId = this._damage(targetId, damage);
        }

        const result = defaultActionResult(`shoot_${target}`, actorId);
        result.targetId = targetId;
        result.hit = hit;
        result.damage = damage;
        result.sawDoubled = hit && armed;

        if (killedId != null) return this._finishRound(killedId, result);

        const nextPlayer = (!hit && target === 'self') ? actorId : this.other(actorId);
        let reloaded = false;
        if (this.pointer >= this.shells.length) {
            this._reloadShells(true);
            reloaded = true;
        }
        result.reloaded = reloaded;
        // PVP 交替先手（硬重置）：新装弹周期的先手 = 上一周期先手的对方，彻底斩断出手权继承。
        if (reloaded && this.alternateFirstTurn) {
            this._beginNewCylinderCycle();
        } else {
            this._setTurn(nextPlayer);
        }
        return result;
    }

    // ── 道具 ──

    // 从道具列表里移除一件（只删第一件，同种可持有多个）。filter 会删光同种，是啤酒×2 的 bug。
    _removeOneItem(items, itemKey) {
        const idx = items.indexOf(itemKey);
        if (idx === -1) return items;
        const out = items.slice();
        out.splice(idx, 1);
        return out;
    }

    _useItem(actorId, itemKey) {
        assert(this.canUseItem(actorId, itemKey), '你不能使用这个道具。');
        this.items[actorId] = this._removeOneItem(this.items[actorId], itemKey);
        const effect = this._applyItem(itemKey, actorId);
        const result = this._effectResult(itemKey, actorId, effect);
        if (this.hp[actorId] <= 0) {
            // 道具把自己降到 0 血（目前只有过期药赌输）：按死亡结算，对手赢下本回合/本局。
            return this._finishRound(actorId, result);
        }
        // 啤酒弹掉最后一发触发重装：同样走交替先手（与开枪重装统一），否则新周期先手错位。
        if (effect.endTurn) {
            if (this.alternateFirstTurn) this._beginNewCylinderCycle();
            else this._setTurn(this.other(actorId));
        }
        return result;
    }

    _useAdrenaline(actorId, stealKey) {
        assert(this.items[actorId].includes('adrenaline'), '你不能使用这个道具。');
        this.items[actorId] = this._removeOneItem(this.items[actorId], 'adrenaline');
        const opponent = this.other(actorId);
        const stealable = this._stealableItems(actorId);
        assert(stealable.length > 0, '对手没有可以偷取的道具。');
        // 指定偷取（真人走选择菜单）；未指定时按偏好偷。
        let stolen;
        if (stealKey == null || !stealable.includes(stealKey)) stolen = this._smartStealChoice(actorId, stealable);
        else stolen = stealKey;
        this.items[opponent] = this._removeOneItem(this.items[opponent], stolen);
        const effect = this._applyItem(stolen, actorId);
        const result = this._effectResult('adrenaline', actorId, effect);
        result.stolenKey = stolen;
        if (this.hp[actorId] <= 0) {
            // 偷来的过期药把自己降到 0 血：同样按死亡结算。
            return this._finishRound(actorId, result);
        }
        if (effect.endTurn) {
            if (this.alternateFirstTurn) this._beginNewCylinderCycle();
            else this._setTurn(opponent);
        }
        return result;
    }

    _effectResult(itemKey, actorId, effect) {
        const result = defaultActionResult(itemKey, actorId);
        result.itemKey = itemKey;
        result.reveal = effect.reveal ?? null;
        result.healed = effect.healed ?? 0;
        result.fullHp = effect.fullHp ?? false;
        result.lostHp = effect.lostHp ?? 0;
        result.ejected = effect.ejected ?? false;
        result.ejectedLive = effect.ejectedLive ?? null;
        result.flipped = effect.flipped ?? false;
        result.handcuffedId = effect.handcuffed ? this.other(actorId) : null;
        result.reloaded = effect.reloaded ?? false;
        return result;
    }

    _applyItem(itemKey, userId) {
        if (itemKey === 'magnifier') {
            const index = this.pointer;
            const live = this.shells[index];
            this.knownShells[userId][index] = live;
            return { key: itemKey, reveal: `当前这一发是${live ? '实弹' : '空弹'}。` };
        }
        if (itemKey === 'cigarette') {
            const before = this.hp[userId];
            this.hp[userId] = Math.min(before + 1, GAME_CONFIG.hp);
            const healed = this.hp[userId] - before;
            return { key: itemKey, healed, fullHp: healed === 0 };
        }
        if (itemKey === 'beer') {
            const index = this.pointer;
            const live = this.shells[index];
            this.pointer += 1;
            this.inverterObscured = false; // 弹掉了当前弹，计数恢复可信
            this._forgetShell(index);
            const reloaded = this.pointer >= this.shells.length;
            if (reloaded) this._reloadShells(true);
            // 规则：只有弹掉「最后一发」才结束回合；否则弹掉后仍是你自己的回合。
            return {
                key: itemKey,
                ejected: true,
                ejectedLive: live,
                reloaded,
                endTurn: reloaded,
            };
        }
        if (itemKey === 'saw') {
            this.sawArmed = true;
            return { key: itemKey, sawArmed: true };
        }
        if (itemKey === 'handcuffs') {
            this.handcuffed.add(this.other(userId));
            return { key: itemKey, handcuffed: true };
        }
        if (itemKey === 'phone') {
            // 手机揭示「未来」的随机一发（非当前），文案用相对第几发。
            const future = [];
            for (let i = this.pointer + 1; i < this.shells.length; i++) future.push(i);
            if (future.length === 0) return { key: itemKey };
            // 只探还没探过的未来弹位——从全部未来弹位里选有 ~18% 概率选到已探位置、
            // 连续用手机空转（实测），这里只从未探位置选。
            const known = this.knownShells[userId] || {};
            const unknown = future.filter(i => !(i in known));
            const pool = unknown.length > 0 ? unknown : future;
            const index = this.rng.choice(pool);
            const live = this.shells[index];
            this.knownShells[userId][index] = live;
            const offset = index - this.pointer;
            return { key: itemKey, reveal: `往后第 ${offset} 发是${live ? '实弹' : '空弹'}。` };
        }
        if (itemKey === 'inverter') {
            this.shells[this.pointer] = !this.shells[this.pointer];
            // 已知该弹位的玩家，情报要跟着翻转，否则情报过期误导决策。
            for (const known of Object.values(this.knownShells)) {
                if (this.pointer in known) known[this.pointer] = !known[this.pointer];
            }
            // 翻转后计数会变，玩家一对比就暴露翻转前类型 → 遮蔽公开计数，直到当前弹被击发/弹出。
            this.inverterObscured = true;
            return { key: itemKey, flipped: true };
        }
        if (itemKey === 'medicine') {
            if (this.rng.random() < 0.4) {
                const before = this.hp[userId];
                this.hp[userId] = Math.min(before + 2, GAME_CONFIG.hp);
                const healed = this.hp[userId] - before;
                return { key: itemKey, healed, fullHp: healed === 0 };
            }
            this.hp[userId] = Math.max(0, this.hp[userId] - 1);
            return { key: itemKey, lostHp: 1 };
        }
        throw new InvalidAction('未知道具。');
    }

    // ── 情报渲染 ──

    privateIntelText(userId) {
        const known = this.knownShells[userId] || {};
        const keys = Object.keys(known).map(Number).sort((a, b) => a - b);
        if (keys.length === 0) return '（暂无情报。用 🔍 放大镜或 📱 手机可探明弹位。）';
        const parts = [];
        for (const index of keys) {
            const live = known[index];
            let pos;
            if (index === this.pointer) pos = '当前这一发';
            else if (index > this.pointer) pos = `往后第 ${index - this.pointer} 发`;
            else pos = `第 ${index + 1} 发`; // 历史弹位（开枪即忘，正常不会出现）
            parts.push(`${pos}是${live ? '实弹' : '空弹'}`);
        }
        return parts.join('　');
    }
}

module.exports = {
    DevilState,
    InvalidAction,
    defaultRng,
    ITEM_KEYS,
    ITEM_DEFS,
    ITEM_MAX_COUNT,
    ITEM_DEFAULT_MAX_COUNT,
    ITEM_GROUP_CAPS,
    ITEM_WEIGHTS,
    MAX_ITEM_SLOTS,
    GAME_CONFIG,
    SURRENDER_MIN_HP,
};
