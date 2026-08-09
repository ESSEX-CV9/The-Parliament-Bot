const { randomUUID } = require('node:crypto');
const { MessageFlags } = require('discord.js');
const gameManager = require('./mysteryGameManager');
const panels = require('./pressureRoulettePanels');
const {
    applyCowardPenalty,
    settleCowardPenalties,
    cowardPenaltyMinutes,
    cowardPenaltyRemainingMs,
} = require('./cowardPenalty');
const {
    createPressureStats,
    recordShot,
    recordChoice,
    recordElimination,
    recordQuit,
    finalizePressureStats,
} = require('./pressureStatsRecorder');
const { recordPressureGame } = require('../utils/mysteryStatsDatabase');

const GAME_TYPE = 'pressure';
const CUSTOM_ID_PREFIX = 'mystery_pressure_';
const CHAMBER_COUNT = 6;
const MIN_PARTICIPANTS = 3;
const MAX_PARTICIPANTS = 6;
const RECRUITMENT_DURATION_MS = 3 * 60 * 1000;
const TURN_DURATION_MS = 60 * 1000;
const HIT_PAUSE_MS = 3 * 1000;
const BASE_TIMEOUT_MINUTES = 3;
const MINUTES_PER_PRESSURE = 1;
const TIMEOUT_REASON = '神秘指令：加压俄罗斯轮盘';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
// 游戏进行中保留的消息数（含当前这条）。超出窗口的旧消息才删。
const PANEL_HISTORY_LIMIT = 3;
// 独立的频道锁分组：同一频道只能有一场加压轮盘，
// 但可以和运气轮盘 / 传炸弹 / 死斗同时进行。
const CHANNEL_LOCK_GROUP = 'pressure';
// 测试用虚拟玩家。真实 Discord ID 全是数字，不会撞。
const VIRTUAL_PREFIX = 'testbot-';
const VIRTUAL_THINK_MS = 2500;
const TEST_MIN_PARTICIPANTS = 2;
const MAX_TEST_BOTS = 5;
const TURN_ACTIONS = Object.freeze({
    fire: 'fire',
    quit: 'fire',
    pass: 'choice',
    again: 'choice',
    load: 'choice',
});

const PLAYER_BUSY_MESSAGE = '🚫 **一心不能二用。**\n你现在已经在一场神秘游戏里，先把那边活着玩完再说。';
const CHANNEL_BUSY_MESSAGE = '🔫 **这个频道已经有一场加压俄罗斯轮盘了。**\n等那把枪打空了再开新的。';
const TIMEOUT_BLOCKED_MESSAGE = '🔫 **左轮拒绝了你。**\n你当前还在禁言，暂时无法参加。';

// 名字上还挂着 🤡 的时候不能上桌：跑一次就得把这轮的耻辱挂满。
function cowardBlockedMessage(remainingMs) {
    const minutes = Math.max(1, Math.ceil(remainingMs / 60000));
    return [
        '🤡 **你现在还是个胆小鬼。**',
        `名字上的 🤡 还有大约 **${minutes} 分钟**才摘得掉。`,
        '在那之前，这把枪不接待你。',
    ].join('\n');
}
const INVALID_MEMBER_MESSAGE = '⚠️ **你现在无法参加这场加压俄罗斯轮盘。**';
const EXPIRED_MESSAGE = '⌛ **这场加压俄罗斯轮盘已经结束或失效了。**';
const FULL_MESSAGE = '🔫 **这局已经满员了。**';
const DUPLICATE_MESSAGE = '👀 **你已经报过名了。**\n再点也不会多给你一条命。';
const JOINED_MESSAGE = '🔫 **报名成功。**\n\n枪里有一发子弹，位置没人知道。';
const NOT_YOUR_TURN_MESSAGE = '✋ **枪不在你手里。**\n等轮到你再说。';
const STALE_ACTION_MESSAGE = '⌛ **这个操作已经过时了。**\n请看频道里最新的那条面板。';
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

function nameFor(game, userId) {
    return panels.nameOf({ labels: game.labels || {} }, userId);
}

// 机器人偏激进：不加压就不会有人被淘汰，测试时局面推不动。
// 攒了蓄力就更倾向于兑现，否则测试局里几乎看不到一次塞好几发的情况。
function pickVirtualAction(game) {
    const roll = randomFor(game);
    const charge = chargeFor(game, game.alive[game.turnIndex]);
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

function spinCylinder(game) {
    const positions = shuffleInPlace(
        Array.from({ length: CHAMBER_COUNT }, (_, index) => index),
        game
    );
    game.chambers = new Array(CHAMBER_COUNT).fill(false);
    for (let index = 0; index < game.bullets && index < CHAMBER_COUNT; index += 1) {
        game.chambers[positions[index]] = true;
    }
    game.revealed = new Array(CHAMBER_COUNT).fill(false);
    game.hitChambers = new Array(CHAMBER_COUNT).fill(false);
    game.pointer = 0;
}

// 存活名单按接下来的行动顺序排：当前持枪的人排第一，后面依次是排在他之后的人。
// 中弹 / 退出时 turnIndex 已经被挪到了下一个人身上，所以这里直接从它起转一圈就对。
function turnOrderIds(game) {
    const alive = game.alive || [];
    if (alive.length <= 1) return [...alive];
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

// 这次加压实际能塞进去几发：基础 1 发 + 蓄力层数，塞不下就按弹巢剩余空位截断。
function loadBulletsFor(game, userId) {
    return Math.min(1 + chargeFor(game, userId), CHAMBER_COUNT - game.bullets);
}

function chamberView(game) {
    return game.revealed.map((revealed, index) => {
        if (game.state === 'playing' && index === game.pointer && !revealed) return 'next';
        if (revealed) return game.hitChambers?.[index] ? 'hit' : 'spent';
        return 'unknown';
    });
}

function buildView(game) {
    const unknownCount = unknownChamberCount(game);
    return {
        gameId: game.id,
        turnToken: game.turnToken,
        chambers: chamberView(game),
        chamberCount: CHAMBER_COUNT,
        bullets: game.bullets,
        pressure: game.pressure,
        pressureBullets: game.pressureBullets || 0,
        charge: chargeFor(game, game.alive[game.turnIndex]),
        unknownCount,
        hitChance: unknownCount > 0 ? game.bullets / unknownCount : 0,
        stakeMinutes: currentStakeMinutes(game),
        aliveIds: turnOrderIds(game),
        eliminated: game.eliminated.map(entry => ({ ...entry })),
        cowards: game.cowards.map(entry => ({ ...entry })),
        shooterId: game.alive[game.turnIndex],
        shooterName: panels.nameOf({ labels: game.labels || {} }, game.alive[game.turnIndex]),
        shotNumber: game.shotNumber + 1,
        turnTimeoutMs: turnDurationFor(game),
        labels: game.labels || {},
        testMode: Boolean(game.testConfig),
        autoPlay: isVirtualPlayer(game.alive[game.turnIndex]),
    };
}

function buildChoiceView(game) {
    const view = buildView(game);
    const loadBullets = loadBulletsFor(game, game.alive[game.turnIndex]);
    view.passUnknownCount = view.unknownCount;
    view.passChance = view.unknownCount > 0 ? game.bullets / view.unknownCount : 0;
    view.canLoad = game.bullets < CHAMBER_COUNT;
    view.loadBullets = loadBullets;
    view.loadChance = (game.bullets + loadBullets) / CHAMBER_COUNT;
    view.loadStakeMinutes = currentStakeMinutes(game) + (loadBullets * MINUTES_PER_PRESSURE);
    view.shotNumber = game.shotNumber;
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

async function deletePanelEntry(entry) {
    if (typeof entry?.message?.delete !== 'function') return;
    try {
        await entry.message.delete();
    } catch (error) {
        // 面板可能已被别人删掉，忽略即可。
    }
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
        if (!game.keepMessages) {
            while (game.panels.length > PANEL_HISTORY_LIMIT) {
                await deletePanelEntry(game.panels.shift());
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
            await deletePanelEntry(entry);
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
    settleCowardPenalties(game.guildId, game.cowards);
    flushPressureStats(game, outcome, finalAliveIds);
    await cleanupPressureGame(game);
}

function evaluateOutcome(game) {
    if (game.alive.length === 0) return 'aborted';
    if (game.alive.length === 1) return 'champion';
    if (game.bullets <= 0) return 'draw';
    return null;
}

async function continueOrSettle(game) {
    let outcome = null;
    let advance = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') return;
        outcome = evaluateOutcome(game);
        if (outcome) return;
        game.phase = 'fire';
        game.turnToken += 1;
        advance = true;
    });

    if (outcome) {
        await settleGame(game, outcome);
        return;
    }
    if (advance) await startTurn(game);
}

async function startTurn(game) {
    if (game.ended || game.state !== 'playing') return;
    const view = buildView(game);
    await renderPanel(game, panels.firePanel(view));

    // 虚拟玩家没有按钮可点，短暂"思考"后自动扣扳机。
    const delay = view.autoPlay ? VIRTUAL_THINK_MS : undefined;
    armTurnTimer(game, view.turnToken, () => performShot(game, view.turnToken), delay);
}

async function renderChoice(game) {
    if (game.ended || game.state !== 'playing') return;
    const view = buildChoiceView(game);
    await renderPanel(game, panels.choicePanel(view));

    if (view.autoPlay) {
        armTurnTimer(
            game,
            view.turnToken,
            () => handleChoice(game, pickVirtualAction(game), view.turnToken),
            VIRTUAL_THINK_MS
        );
        return;
    }
    armTurnTimer(game, view.turnToken, () => handleChoice(game, 'pass', view.turnToken));
}

async function resolveHit(game, victimId) {
    const minutes = currentStakeMinutes(game);
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
        timeoutFailed,
        victimVirtual: virtual,
    }));

    await sleep(HIT_PAUSE_MS);
    if (game.ended) return;
    await continueOrSettle(game);
}

async function performShot(game, expectedToken) {
    let result = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') return;
        if (game.phase !== 'fire' || game.turnToken !== expectedToken) return;

        const shooterId = game.alive[game.turnIndex];
        if (!shooterId) return;

        const index = game.pointer;
        const hit = game.chambers[index] === true;
        // 统计要的是「扣扳机那一刻」的局面，所以必须在验巢、扣子弹之前取。
        const bulletsBefore = game.bullets;
        const unknownBefore = unknownChamberCount(game);
        game.revealed[index] = true;
        if (hit) {
            game.chambers[index] = false;
            game.hitChambers[index] = true;
            game.bullets = Math.max(0, game.bullets - 1);
            // 人没了，攒下的蓄力跟着一起没。
            setCharge(game, shooterId, 0);
        }
        game.pointer = (index + 1) % CHAMBER_COUNT;
        game.shotNumber += 1;
        game.turnToken += 1;
        game.phase = hit ? 'resolving' : 'choice';
        recordShot(game.stats, shooterId, { hit, bulletsBefore, unknownBefore });
        result = { shooterId, hit };
    });

    if (!result) return;
    clearTurnTimer(game);

    if (result.hit) {
        await resolveHit(game, result.shooterId);
        return;
    }

    // 先播报空枪，再给出选择面板，让全场都看清刚才发生了什么。
    await renderPanel(game, panels.missAnnouncement({
        ...buildView(game),
        shooterId: result.shooterId,
        shooterName: nameFor(game, result.shooterId),
    }));
    await renderChoice(game);
}

async function handleChoice(game, action, expectedToken) {
    let accepted = false;
    let actorId = null;
    let resolvedAction = action;
    let loadedBullets = 0;
    let clearedCharge = 0;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') return;
        if (game.phase !== 'choice' || game.turnToken !== expectedToken) return;
        if (game.alive.length === 0) return;

        actorId = game.alive[game.turnIndex];
        let effectiveAction = action;
        if (effectiveAction === 'load' && game.bullets >= CHAMBER_COUNT) {
            effectiveAction = 'pass';
        }
        resolvedAction = effectiveAction;

        const charge = chargeFor(game, actorId);
        if (effectiveAction === 'load') {
            // 走到这里 bullets 一定小于 CHAMBER_COUNT，至少能塞进 1 发。
            loadedBullets = loadBulletsFor(game, actorId);
            game.bullets += loadedBullets;
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
        removed = true;
        if (wasCurrent) game.turnToken += 1;
    });

    if (!removed) return;
    if (game.state === 'recruiting') return;

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
        await deletePanelEntry(entry);
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
        // 数据只从这里开始记：招募人数不足被取消的局压根不该进榜单。
        // 测试局（含虚拟机器人，且真人可以混进来一起玩）整局跳过，避免污染正式数据。
        game.stats = game.testConfig ? null : createPressureStats(validIds);
        game.turnIndex = 0;
        game.bullets = 1;
        game.pressure = 0;
        game.pressureBullets = 0;
        game.shotNumber = 0;
        setCharge(game, null, 0);
        spinCylinder(game);

        // 测试模式可以把第一发子弹钉在指定弹巢，方便复现"第 N 枪必中"
        const forcedChamber = game.testConfig?.bulletChamber;
        if (forcedChamber >= 1 && forcedChamber <= CHAMBER_COUNT) {
            game.chambers = new Array(CHAMBER_COUNT).fill(false);
            game.chambers[forcedChamber - 1] = true;
            game.revealed = new Array(CHAMBER_COUNT).fill(false);
            game.hitChambers = new Array(CHAMBER_COUNT).fill(false);
            game.pointer = 0;
        }

        // 隐藏规则：全局第一枪（第一轮第一枪）必须是空枪，
        // 避免开局第一个人一扣扳机就被命中、游戏瞬间结束。
        // 若枪口正对的弹巢恰好有子弹，把它挪到另一个空巢即可，
        // 玩家看到的弹巢视图不变。测试工具显式把子弹钉在枪口
        // （bulletChamber=1）时跳过，否则"第 N 枪必中"无法复现。
        // 没有 testConfig 时 forcedChamber 是 undefined，比较结果自然为 false。
        const bulletPinnedToPointer = forcedChamber === game.pointer + 1;
        if (!bulletPinnedToPointer && game.chambers[game.pointer] === true) {
            const emptyChambers = [];
            for (let index = 0; index < CHAMBER_COUNT; index += 1) {
                if (index !== game.pointer && game.chambers[index] === false) {
                    emptyChambers.push(index);
                }
            }
            if (emptyChambers.length > 0) {
                const target = emptyChambers[Math.floor(randomFor(game) * emptyChambers.length)];
                game.chambers[game.pointer] = false;
                game.chambers[target] = true;
            }
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
    const cowardRemainingMs = cowardPenaltyRemainingMs(game.guildId, userId);
    if (cowardRemainingMs > 0) {
        await replyEphemeral(interaction, cowardBlockedMessage(cowardRemainingMs));
        return;
    }

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
    if (!Object.hasOwn(TURN_ACTIONS, action)) return null;
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
        chambers: new Array(CHAMBER_COUNT).fill(false),
        revealed: new Array(CHAMBER_COUNT).fill(false),
        hitChambers: new Array(CHAMBER_COUNT).fill(false),
        pointer: 0,
        bullets: 0,
        pressure: 0,
        pressureBullets: 0,
        charge: 0,
        chargeOwnerId: null,
        shotNumber: 0,
        alive: [],
        eliminated: [],
        cowards: [],
        // 真正开局（beginGame）时才创建，在那之前没有任何数据可记。
        stats: null,
        turnIndex: 0,
        turnToken: 0,
        phase: 'idle',
        panels: [],
        recruitmentEntry: null,
        channelLockGroup: CHANNEL_LOCK_GROUP,
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
    const cowardRemainingMs = cowardPenaltyRemainingMs(guildId, userId);
    if (cowardRemainingMs > 0) {
        await replyEphemeral(interaction, cowardBlockedMessage(cowardRemainingMs));
        return false;
    }

    let game;
    provisionalGame.onMemberInvalidated = async invalidMember => {
        const invalidUserId = invalidMember?.id || invalidMember?.user?.id;
        if (invalidUserId && game) {
            await handleMemberInvalidated(game, invalidUserId);
        }
    };
    provisionalGame.disableComponents = async () => {
        const entry = game?.panels?.at(-1);
        if (!entry?.interactive || typeof entry.message?.edit !== 'function') return;
        entry.interactive = false;
        try {
            await entry.message.edit({ components: [] });
        } catch (error) {
            // 面板可能已被删除，忽略。
        }
    };

    const created = gameManager.createGame(provisionalGame);
    if (!created.ok) {
        await replyEphemeral(
            interaction,
            created.reason === 'player' ? PLAYER_BUSY_MESSAGE : CHANNEL_BUSY_MESSAGE
        );
        return false;
    }
    game = created.game;

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
    CHANNEL_LOCK_GROUP,
    PANEL_HISTORY_LIMIT,
    CHAMBER_COUNT,
    MIN_PARTICIPANTS,
    MAX_PARTICIPANTS,
    BASE_TIMEOUT_MINUTES,
    MINUTES_PER_PRESSURE,
    startPressureRoulette,
    handlePressureInteraction,
    parsePressureCustomId,
};
