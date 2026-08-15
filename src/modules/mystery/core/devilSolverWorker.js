'use strict';
/* 庄家决策 Worker：常驻线程跑求解器，不阻塞主事件循环。
   主线程 postMessage({ seq, ...workerData }) → worker 回 { seq, result }。
   worker 内 memo（查表）跨回合常驻：同一局/多局的相同局面直接命中缓存，不再每次冷启动全量重算。
   worker 进程内 memo 有 80 万条自愈上限（见 devilSolver MEMO_GUARD）。 */

const { parentPort } = require('node:worker_threads');
const solver = require('./devilSolver');

const oppModel = process.env.ROULETTE_SOLVER_OPP_MODEL || '';
// 默认空串 → 纯 minimax（对手完美理性，庄家最大化最坏情况胜率 = 理论极致最优）。
// 设 aggressive/uniform 则切换为对手子优建模（exploit，对真人胜率可能更高但非理论最优）。
solver.setOppModel(oppModel || null);

function solveOnce(payload) {
    const {
        myHp, oppHp, myItems, oppItems, saw, myCuffed, oppCuffed,
        live, blank, known, oppKnown, hpCap, shellsLo, shellsHi,
        maxMs, startBudget, factor, depthLimit,
    } = payload || {};
    solver.battleTL.depthLimit = depthLimit || 100;
    let result;
    try {
        // 预算不再设节点上限：IDDFS 逐趟翻倍预算，直到完备或 maxMs 时间窗耗尽。
        result = solver.battleBestActionTimed(
            myHp, oppHp, myItems, oppItems, saw, myCuffed, oppCuffed,
            live, blank, known, hpCap, shellsLo, shellsHi,
            { maxMs: maxMs || 10_000, startBudget: startBudget || 50_000, factor: factor || 4 },
            oppKnown || known,
        );
    } catch (error) {
        result = { action: 'shoot_opponent', steal: null, complete: false, error: String(error?.message || error) };
    }
    return result;
}

parentPort.on('message', payload => {
    if (!payload || typeof payload.seq !== 'number') return;
    const { seq } = payload;
    let result;
    try {
        result = solveOnce(payload);
    } catch (error) {
        result = { action: 'shoot_opponent', steal: null, complete: false, error: String(error?.message || error) };
    }
    parentPort.postMessage({ seq, result });
});
