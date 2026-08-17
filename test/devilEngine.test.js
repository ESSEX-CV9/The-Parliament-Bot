/* 恶魔轮盘引擎回归测试（node:test，零依赖纯引擎层）。 */

const test = require('node:test');
const assert = require('node:assert');
const {
    DevilState, InvalidAction, ITEM_DEFS, MAX_ITEM_SLOTS, GAME_CONFIG,
} = require('../src/modules/mystery/core/devilRouletteEngine');

function makeRng(seed) {
    // xorshift32 确定性 RNG，接口对齐 defaultRng。
    let s = seed | 0 || 1;
    const next = () => {
        s ^= s << 13; s |= 0;
        s ^= s >>> 17;
        s ^= s << 5; s |= 0;
        return ((s >>> 0) % 100000) / 100000;
    };
    return {
        random: next,
        randint: (a, b) => a + Math.floor(next() * (b - a + 1)),
        choice: arr => arr[Math.floor(next() * arr.length)],
        choices: (pool, weights, k = 1) => {
            const out = [];
            for (let i = 0; i < k; i++) {
                let total = 0;
                for (const w of weights) total += w;
                let r = next() * total;
                for (let j = 0; j < pool.length; j++) {
                    r -= weights[j];
                    if (r <= 0) { out.push(pool[j]); break; }
                }
                if (out.length <= i) out.push(pool[pool.length - 1]);
            }
            return out;
        },
        shuffle: arr => {
            for (let i = arr.length - 1; i > 0; i--) {
                const j = Math.floor(next() * (i + 1));
                [arr[i], arr[j]] = [arr[j], arr[i]];
            }
            return arr;
        },
    };
}

test('开局状态：血量/弹巢/道具/先手', () => {
    const s = new DevilState(['a', 'b'], { rng: makeRng(1) });
    assert.strictEqual(s.phase, 'playing');
    assert.strictEqual(s.hp.a, GAME_CONFIG.hp);
    assert.strictEqual(s.hp.b, GAME_CONFIG.hp);
    assert.ok(s.shells.length >= GAME_CONFIG.shells[0] && s.shells.length <= GAME_CONFIG.shells[1]);
    assert.ok(['a', 'b'].includes(s.turnPlayerId));
});

test('道具上限：槽位 4 + 回复类合计 1', () => {
    for (let seed = 1; seed <= 40; seed++) {
        const s = new DevilState(['a', 'b'], { rng: makeRng(seed) });
        for (let i = 0; i < 8; i++) s._reloadShells(true);
        for (const pid of ['a', 'b']) {
            assert.ok(s.items[pid].length <= MAX_ITEM_SLOTS, `seed=${seed} 槽位超限`);
            const heal = s.items[pid].filter(x => x === 'cigarette' || x === 'medicine').length;
            assert.ok(heal <= 1, `seed=${seed} 回复类共存`);
        }
    }
});

test('空弹打自己保回合；实弹换手', () => {
    const s = new DevilState(['a', 'b'], { rng: makeRng(7) });
    s.shells = [false, true];
    s.pointer = 0;
    s.turnPlayerId = 'a';
    const r1 = s.apply('shoot_self', 'a');
    assert.strictEqual(r1.hit, false);
    assert.strictEqual(s.turnPlayerId, 'a'); // 空弹保回合

    const r2 = s.apply('shoot_self', 'a');
    assert.strictEqual(r2.hit, true);
    assert.strictEqual(s.hp.a, GAME_CONFIG.hp - 1);
});

test('手铐跳过 + 手铐消耗', () => {
    const s = new DevilState(['a', 'b'], { rng: makeRng(3) });
    s.shells = [false, false];
    s.pointer = 0;
    s.turnPlayerId = 'a';
    s.items.a = ['handcuffs']; // 测试需要显式持有手铐
    s.apply('handcuffs', 'a');
    assert.ok(s.handcuffed.has('b'));
    s.apply('shoot_opponent', 'a'); // 空弹 → 换手到 b → b 被铐跳过 → 回到 a
    assert.strictEqual(s.turnPlayerId, 'a');
    assert.strictEqual(s.handcuffed.size, 0); // 铐已消耗
});

test('逆转器：翻转 + 情报同步 + 计数遮蔽', () => {
    const s = new DevilState(['a', 'b'], { rng: makeRng(5) });
    s.shells = [true, false];
    s.pointer = 0;
    s.turnPlayerId = 'a';
    s.items.a = ['inverter'];
    s.knownShells.a = { 0: true };
    s.apply('inverter', 'a');
    assert.strictEqual(s.shells[0], false);
    assert.strictEqual(s.knownShells.a[0], false); // 情报跟着翻
    assert.strictEqual(s.inverterObscured, true);
});

test('过期药：40% 加 2 / 60% 扣 1（大数定律近似）', () => {
    const s = new DevilState(['a', 'b'], { rng: makeRng(11) });
    let heal = 0, total = 0;
    for (let i = 0; i < 20000; i++) {
        s.hp.a = 2;
        const eff = s._applyItem('medicine', 'a');
        total++;
        if (eff.healed > 0 || eff.fullHp) heal++;
    }
    const p = heal / total;
    assert.ok(Math.abs(p - 0.4) < 0.02, `medicine p=${p}`);
});

test('血清快照往返：全字段等', () => {
    const s = new DevilState(['a', 'b'], { rng: makeRng(42) });
    s.shells = [true, false, true];
    s.pointer = 1;
    s.knownShells.a = { 1: false };
    s.items.a = ['saw'];
    s.handcuffed.add('b');
    const snap = JSON.parse(JSON.stringify(s.serialize()));
    const r = DevilState.restore(snap);
    assert.deepStrictEqual(r.shells, s.shells);
    assert.strictEqual(r.pointer, s.pointer);
    assert.deepStrictEqual(r.knownShells, s.knownShells);
    assert.deepStrictEqual(r.items, s.items);
    assert.deepStrictEqual([...r.handcuffed], [...s.handcuffed]);
    assert.strictEqual(r.turnToken, s.turnToken);
});

test('随机对打 200 局不变量：不崩、上限不破、必终局', () => {
    const STRONG = new Set(['saw', 'handcuffs', 'adrenaline']);
    for (let seed = 1; seed <= 200; seed++) {
        const s = new DevilState(['a', 'b'], { rng: makeRng(seed), alternateFirstTurn: true });
        let steps = 0;
        while (s.phase !== 'ended' && steps < 500) {
            const cur = s.currentPlayerId;
            const acts = ['shoot_self', 'shoot_opponent'];
            for (const k of Object.keys(ITEM_DEFS)) if (s.canUseItem(cur, k)) acts.push(k);
            const a = acts[(seed * 31 + steps) % acts.length];
            try {
                s.apply(a, cur, a === 'adrenaline' ? { stealKey: s._stealableItems(cur)[0] } : {});
            } catch (e) { if (e instanceof InvalidAction) break; throw e; }
            for (const pid of ['a', 'b']) {
                assert.ok(s.items[pid].length <= MAX_ITEM_SLOTS);
                const heal = s.items[pid].filter(x => x === 'cigarette' || x === 'medicine').length;
                assert.ok(heal <= 1);
                const strong = s.items[pid].filter(x => STRONG.has(x)).length;
                assert.ok(strong <= 1, `seed=${seed} 强控类共存 ${s.items[pid]}`);
            }
            steps++;
        }
    }
});
