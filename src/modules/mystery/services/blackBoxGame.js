const { randomUUID } = require('node:crypto');
const { randomInt: nodeRandomInt } = require('node:crypto');
const { MessageFlags } = require('discord.js');
const gameManager = require('./mysteryGameManager');
const panels = require('./blackBoxPanels');
const rules = require('./blackBoxRules');
const defaultPanelLifecycle = require('./panelLifecycle');
const { createPanelRegistry } = defaultPanelLifecycle;

const BLACKBOX_CUSTOM_ID_PREFIX = 'mystery_blackbox';

const RECRUIT_DURATION_MS = 3 * 60_000;
const DECLARATION_DURATION_MS = 10_000;
const ACTION_DURATION_MS = 15_000;
const COUNTER_DURATION_MS = 5_000;
const FINAL_WAGER_DURATION_MS = 10_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

const GENERIC_FAILURE_MESSAGE = '❌ 处理黑箱交易操作时出现问题，请稍后再试。';
const EXPIRED_MESSAGE = '⌛ **这次黑箱交易操作已经过期或失效了。**';
const NOT_YOURS_MESSAGE = '🚫 **这不是你的操作。**';

function logFailure(game, action, error, userId = 'system') {
    console.error(
        `[MysteryBlackBox] Discord API 失败 (guild=${game?.guildId || 'unknown'}, game=${game?.id || 'unknown'}, user=${userId}, action=${action}):`,
        error
    );
}

function roundId() {
    return randomUUID().replaceAll('-', '').slice(0, 12);
}

function inRoundOrFinal(game) {
    return game.state === 'round' || game.state === 'final_hand';
}

function createGameInput(interaction, userId, guildId, channelId, options) {
    return {
        id: randomUUID(),
        type: 'blackbox',
        guildId,
        channelId,
        guild: interaction.guild,
        channel: interaction.channel,
        initiatorId: userId,
        participantIds: [userId],
        state: 'recruiting',
        timers: new Set(),
        publicWriteQueue: Promise.resolve(),
        originInteraction: interaction,
        alive: [userId],
        chips: new Map([[userId, rules.INITIAL_CHIPS]]),
        inactivityStreak: new Map([[userId, 0]]),
        eliminationBatch: 0,
        previousByeId: null,
        roundNumber: 0,
        round: null,
        final: null,
        randomInt: options.randomInt || nodeRandomInt,
        now: options.now || Date.now,
        setTimeoutImpl: options.setTimeoutImpl || setTimeout,
        clearTimeoutImpl: options.clearTimeoutImpl || clearTimeout,
        cleanupStarted: false,
        componentsDisabled: false,
        panelLifecycle: options.panelLifecycle || defaultPanelLifecycle,
        panelRegistry: createPanelRegistry({
            lifecycle: options.panelLifecycle || defaultPanelLifecycle,
        }),
    };
}

async function deferPublicStart(interaction, game) {
    if (interaction.deferred || interaction.replied || typeof interaction.deferReply !== 'function') {
        return false;
    }
    try {
        await interaction.deferReply();
        return true;
    } catch (error) {
        logFailure(game, 'defer-public-start', error, interaction.user?.id);
        return false;
    }
}

async function safeSend(game, payload, action) {
    if (!game?.channel || typeof game.channel.send !== 'function') return false;
    try {
        return await game.channel.send(payload);
    } catch (error) {
        logFailure(game, action, error);
        return false;
    }
}

async function safeSendProcess(game, payload, action, options = {}) {
    const message = await safeSend(game, payload, action);
    if (message) {
        game.panelRegistry?.track(message, {
            context: { action, guildId: game.guildId, gameId: game.id },
            ...options,
        });
    }
    return message;
}

async function safeEdit(message, payload, game, action) {
    if (!message || typeof message.edit !== 'function') return false;
    try {
        return await message.edit(payload);
    } catch (error) {
        logFailure(game, action, error);
        return false;
    }
}

async function sendPrivate(interaction, payload, game) {
    if (!interaction) return false;
    try {
        if (interaction.deferred && !interaction.replied && typeof interaction.editReply === 'function') {
            await interaction.editReply(payload);
        } else if (interaction.replied && typeof interaction.followUp === 'function') {
            await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
        } else if (!interaction.replied && typeof interaction.reply === 'function') {
            await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
        } else {
            return false;
        }
        return true;
    } catch (error) {
        logFailure(game, 'private-reply', error, interaction.user?.id);
        return false;
    }
}

async function deferEphemeralComponent(interaction, game) {
    if (interaction.deferred || interaction.replied || typeof interaction.deferReply !== 'function') {
        return true;
    }
    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return true;
    } catch (error) {
        logFailure(game, 'defer-component-reply', error, interaction.user?.id);
        return false;
    }
}

function queuePublicWrite(game, operation) {
    const next = game.publicWriteQueue.catch(() => undefined).then(operation);
    game.publicWriteQueue = next;
    return next;
}

function isActivelyTimedOut(member, now = Date.now()) {
    return Number(member?.communicationDisabledUntilTimestamp) > now;
}

function isValidHumanMember(member) {
    return Boolean(member?.id && member.user && !member.user.bot && !isActivelyTimedOut(member));
}

function isCurrentGuildMember(game, member, userId = member?.id) {
    if (!isValidHumanMember(member) || member.id !== userId) return false;
    const memberGuildId = member.guild?.id || member.guildId;
    if (!memberGuildId || memberGuildId !== game.guildId) return false;
    return game.guild?.members?.cache?.get(userId) === member;
}

async function safeFetchMember(game, userId) {
    try {
        return await game.guild?.members?.fetch(userId) || null;
    } catch (error) {
        logFailure(game, 'fetch-member', error, userId);
        return null;
    }
}

function setTimer(game, label, callback, delayMs) {
    const timer = game.setTimeoutImpl(() => {
        game.timers.delete(timer);
        return Promise.resolve(callback()).catch(error => {
            logFailure(game, `timer-${label}`, error);
            return cleanupBlackBox(game);
        });
    }, Math.min(delayMs, MAX_TIMER_MS));
    timer.unref?.();
    game.timers.add(timer);
    return timer;
}

function clearTimer(game, timer) {
    if (!timer) return;
    game.clearTimeoutImpl(timer);
    game.timers.delete(timer);
}

async function cleanupBlackBox(game) {
    if (!game || game.cleanupStarted) return game?.cleanupPromise;
    game.cleanupStarted = true;
    game.cleanupPromise = (async () => {
        for (const timer of game.timers) game.clearTimeoutImpl(timer);
        game.timers.clear();
        await game.panelRegistry?.stageAll();
        await gameManager.cleanupGame(game);
        game.panelRegistry?.armAll();
    })().catch(error => logFailure(game, 'cleanup', error));
    return game.cleanupPromise;
}

function buildRecruitmentView(game) {
    return { gameId: game.id, count: game.alive.length };
}

async function renderRecruitment(game) {
    const payload = panels.recruitmentPanel(buildRecruitmentView(game));
    if (!game.recruitMessage) {
        try {
            const result = await game.originInteraction?.editReply?.(payload);
            game.recruitMessage = result?.resource?.message || result || null;
            if (typeof game.recruitMessage?.edit !== 'function') {
                const fetched = await game.originInteraction?.fetchReply?.();
                if (typeof fetched?.edit === 'function') game.recruitMessage = fetched;
            }
            if (!game.recruitMessage && typeof game.originInteraction?.editReply === 'function') {
                game.recruitMessage = {
                    edit: next => game.originInteraction.editReply(next),
                };
            }
            if (game.recruitMessage) {
                game.panelRegistry?.track(game.recruitMessage, {
                    context: {
                        action: 'blackbox-recruitment',
                        guildId: game.guildId,
                        gameId: game.id,
                    },
                });
            }
            return game.recruitMessage;
        } catch (error) {
            logFailure(game, 'recruitment-panel', error);
            return false;
        }
    }
    return safeEdit(game.recruitMessage, payload, game, 'recruitment-edit');
}

async function beginGame(game) {
    let ownsBegin = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'recruiting') return;
        game.state = 'round';
        ownsBegin = true;
    });
    if (!ownsBegin) return false;

    game.onGameStarted?.();
    await game.panelRegistry?.retire(game.recruitMessage, {
        context: { action: 'blackbox-recruitment-start' },
    });
    await startRound(game, 1);
    return true;
}

async function expireRecruitment(game) {
    let shouldCancel = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'recruiting') return;
        shouldCancel = game.alive.length < rules.MIN_PLAYERS;
        if (shouldCancel) game.state = 'ended';
    });
    if (!shouldCancel) return beginGame(game);

    await queuePublicWrite(game, () => safeSend(game, panels.cancellationPanel({}), 'recruitment-cancel'));
    await cleanupBlackBox(game);
    return true;
}

async function handleJoin(interaction, game) {
    const userId = interaction.user?.id;
    let accepted = false;
    let rejection = null;
    const member = await safeFetchMember(game, userId);
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'recruiting') {
            rejection = EXPIRED_MESSAGE;
            return;
        }
        if (!isCurrentGuildMember(game, member, userId)) {
            rejection = EXPIRED_MESSAGE;
            return;
        }
        if (game.participantIds.includes(userId)) {
            rejection = '🖐️ **你已经报名了。**';
            return;
        }
        const owner = gameManager.getPlayerGame(game.guildId, userId);
        if (owner && owner !== game) {
            rejection = '🚫 **你已经在另一场神秘游戏里了。**';
            return;
        }
        if (!gameManager.addPlayer(game, userId)) {
            rejection = '🚫 **无法加入这场游戏。**';
            return;
        }
        if (game.alive.length >= rules.MAX_PLAYERS) {
            rejection = null;
            accepted = true;
            return;
        }
        game.alive.push(userId);
        game.chips.set(userId, rules.INITIAL_CHIPS);
        game.inactivityStreak.set(userId, 0);
        accepted = true;
    });

    if (rejection) {
        await sendPrivate(interaction, { content: rejection }, game);
        return false;
    }
    if (!accepted) return false;

    await renderRecruitment(game);
    if (game.alive.length >= rules.MAX_PLAYERS) {
        return beginGame(game);
    }
    return true;
}

// ---------- 常规轮 ----------

function buildPhaseView(game) {
    const round = game.round;
    return {
        gameId: game.id,
        roundId: round.id,
        revision: round.revision,
        roundNumber: game.roundNumber,
        dangerousCount: round.dangerousCount,
    };
}

async function startRound(game, roundNumber) {
    const alive = game.alive;
    if (alive.length <= 1) {
        await queuePublicWrite(game, () => safeSend(
            game,
            panels.championPanel({ winnerId: alive[0] }),
            'champion'
        ));
        await cleanupBlackBox(game);
        return true;
    }
    if (alive.length === 2) {
        return startFinal(game);
    }

    const dangerousCount = rules.dangerousBoxCount(alive.length, roundNumber);
    const deck = rules.shuffle(rules.buildNormalDeck(alive.length, roundNumber), game.randomInt);
    const boxes = new Map(alive.map((id, index) => [id, deck[index]]));
    const { pairs, byeId } = rules.pairPlayers(alive, {
        previousByeId: game.previousByeId,
        randomInt: game.randomInt,
    });
    game.previousByeId = byeId;
    game.roundNumber = roundNumber;
    game.round = {
        id: roundId(),
        revision: 1,
        phase: 'declaration',
        dangerousCount,
        boxes,
        finalBoxes: new Map(),
        pairs,
        byeId,
        declarations: new Map(),
        actions: new Map(),
        counters: new Map(),
        pendingCounters: [],
        counterIndex: 0,
        eliminated: [],
        resolved: false,
        timer: null,
    };

    if (game.phaseMessage) {
        await game.panelRegistry?.retire(game.phaseMessage, {
            context: { action: 'blackbox-phase-invalidated' },
        });
    }
    const message = await queuePublicWrite(game, () => safeSendProcess(
        game,
        panels.phasePanel(buildPhaseView(game)),
        'phase-panel'
    ));
    if (!message) {
        await cleanupBlackBox(game);
        return false;
    }
    game.phaseMessage = message;
    game.round.timer = setTimer(game, 'declaration', () => advanceDeclaration(game, game.round), DECLARATION_DURATION_MS);
    return true;
}

async function advanceDeclaration(game, round) {
    let moved = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || !inRoundOrFinal(game) || game.round !== round || round.resolved) return;
        if (round.phase !== 'declaration') return;
        round.phase = 'action';
        moved = true;
    });
    if (!moved) return false;
    round.timer = setTimer(game, 'action', () => defaultMissingActions(game, round), ACTION_DURATION_MS);
    return true;
}

async function submitDeclaration(game, { userId, roundId, revision, choice }) {
    let result = null;
    await gameManager.runExclusive(game, () => {
        const round = game.round;
        if (game.ended || !inRoundOrFinal(game) || round?.id !== roundId || round.revision !== revision) {
            result = { ok: false, reason: 'stale' };
            return;
        }
        if (round.phase !== 'declaration') {
            result = { ok: false, reason: 'wrong_phase' };
            return;
        }
        if (!game.alive.includes(userId)) {
            result = { ok: false, reason: 'not_player' };
            return;
        }
        if (!['safe', 'dangerous'].includes(choice)) {
            result = { ok: false, reason: 'invalid' };
            return;
        }
        if (round.declarations.has(userId)) {
            result = { ok: false, reason: 'duplicate' };
            return;
        }
        round.declarations.set(userId, choice);
        result = { ok: true };
    });
    return result;
}

async function defaultMissingActions(game, round) {
    let moved = false;
    let streakEliminated = [];
    await gameManager.runExclusive(game, () => {
        if (game.ended || !inRoundOrFinal(game) || game.round !== round || round.resolved) return;
        if (round.phase !== 'action') return;
        for (const userId of game.alive) {
            if (!round.actions.has(userId)) {
                round.actions.set(userId, { exchange: 'keep', wager: 'stable' });
                const streak = (game.inactivityStreak.get(userId) || 0) + 1;
                game.inactivityStreak.set(userId, streak);
                if (streak >= 2) {
                    streakEliminated.push(userId);
                    game.alive = game.alive.filter(id => id !== userId);
                    game.chips.delete(userId);
                    gameManager.removePlayer(game, userId);
                }
            }
        }
        round.phase = 'counter';
        moved = true;
    });
    if (!moved) return false;

    if (streakEliminated.length > 0) {
        await queuePublicWrite(game, () => safeSendProcess(
            game,
            panels.insufficientPlayersPanel({ eliminated: streakEliminated }),
            'inactivity-elimination'
        ));
    }
    if (game.alive.length <= 1) {
        await startRound(game, game.roundNumber);
        return true;
    }
    return processCounters(game, round);
}

async function submitAction(game, { userId, roundId, revision, exchange, wager }) {
    let result = null;
    let readyToResolve = false;
    await gameManager.runExclusive(game, () => {
        const round = game.round;
        if (game.ended || !inRoundOrFinal(game) || round?.id !== roundId || round.revision !== revision) {
            result = { ok: false, reason: 'stale' };
            return;
        }
        if (round.phase !== 'action') {
            result = { ok: false, reason: 'wrong_phase' };
            return;
        }
        if (!game.alive.includes(userId)) {
            result = { ok: false, reason: 'not_player' };
            return;
        }
        if (!['keep', 'exchange'].includes(exchange) || !['stable', 'wager'].includes(wager)) {
            result = { ok: false, reason: 'invalid' };
            return;
        }
        if (round.byeId === userId && exchange === 'exchange') {
            result = { ok: false, reason: 'bye_no_exchange' };
            return;
        }
        if (round.actions.has(userId)) {
            result = { ok: false, reason: 'duplicate' };
            return;
        }
        round.actions.set(userId, { exchange, wager });
        game.inactivityStreak.set(userId, 0);
        if (game.alive.every(id => round.actions.has(id))) {
            round.phase = 'counter';
            readyToResolve = true;
        }
        result = { ok: true };
    });
    if (!result?.ok) return result;
    if (readyToResolve) {
        clearTimer(game, game.round?.timer);
        await processCounters(game, game.round);
    }
    return result;
}

function buildPendingCounters(game, round) {
    const pending = [];
    for (const [a, b] of round.pairs) {
        const actionA = round.actions.get(a);
        const actionB = round.actions.get(b);
        if (!actionA || !actionB) continue;
        const aExchange = actionA.exchange === 'exchange';
        const bExchange = actionB.exchange === 'exchange';
        if (aExchange && !bExchange) pending.push({ keeperId: b, exchangerId: a });
        if (bExchange && !aExchange) pending.push({ keeperId: a, exchangerId: b });
    }
    return pending;
}

async function processCounters(game, round) {
    let pending = [];
    await gameManager.runExclusive(game, () => {
        if (game.ended || !inRoundOrFinal(game) || game.round !== round || round.resolved) return;
        if (round.phase !== 'counter') return;
        round.pendingCounters = buildPendingCounters(game, round);
        round.counterIndex = 0;
        pending = [...round.pendingCounters];
    });
    if (pending.length === 0) {
        if (game.state === 'final_hand') await resolveFinalHand(game, round);
        else await resolveNormalRound(game, round);
        return;
    }
    await sendNextCounter(game, round);
}

async function sendNextCounter(game, round) {
    let entry = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || !inRoundOrFinal(game) || game.round !== round || round.resolved) return;
        entry = round.pendingCounters[round.counterIndex] || null;
    });
    if (!entry) {
        await resolveNormalRound(game, round);
        return;
    }
    // 裁定面板由保留方点击公共阶段面板按钮打开；超时默认放行。
    round.timer = setTimer(game, 'counter', () => defaultCounter(game, round, entry), COUNTER_DURATION_MS);
}

async function submitCounter(game, { userId, roundId, revision, decision, source }) {
    let result = null;
    let entry = null;
    await gameManager.runExclusive(game, () => {
        const round = game.round;
        if (game.ended || !inRoundOrFinal(game) || round?.id !== roundId || round.revision !== revision) {
            result = { ok: false, reason: 'stale' };
            return;
        }
        if (round.phase !== 'counter') {
            result = { ok: false, reason: 'wrong_phase' };
            return;
        }
        entry = round.pendingCounters[round.counterIndex];
        if (!entry || entry.keeperId !== userId) {
            result = { ok: false, reason: 'not_yours' };
            return;
        }
        if (!['lock', 'allow'].includes(decision)) {
            result = { ok: false, reason: 'invalid' };
            return;
        }
        if (decision === 'lock' && (game.chips.get(userId) || 0) < 2) {
            result = { ok: false, reason: 'not_enough_chips' };
            return;
        }
        round.counters.set(userId, decision);
        result = { ok: true };
    });
    if (!result?.ok) return result;
    await advanceCounter(game, game.round);
    return result;
}

async function defaultCounter(game, round, entry) {
    let ok = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || !inRoundOrFinal(game) || game.round !== round || round.resolved) return;
        if (round.phase !== 'counter') return;
        const current = round.pendingCounters[round.counterIndex];
        if (!current || current.keeperId !== entry.keeperId) return;
        round.counters.set(current.keeperId, 'allow');
        ok = true;
    });
    if (!ok) return;
    await advanceCounter(game, round);
}

async function advanceCounter(game, round) {
    let done = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || !inRoundOrFinal(game) || game.round !== round || round.resolved) return;
        if (round.phase !== 'counter') return;
        round.counterIndex += 1;
        if (round.counterIndex >= round.pendingCounters.length) done = true;
    });
    if (!done) {
        await sendNextCounter(game, round);
        return;
    }
    await resolveNormalRound(game, round);
}

async function resolveNormalRound(game, round) {
    let snapshot = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'round' || game.round !== round || round.resolved) return;
        if (round.phase !== 'counter') return;
        round.resolved = true;
        clearTimer(game, round.timer);
        round.timer = null;

        const finalBoxes = new Map(round.boxes);
        for (const [a, b] of round.pairs) {
            const actionA = round.actions.get(a);
            const actionB = round.actions.get(b);
            if (!actionA || !actionB) continue;
            const decision = round.counters.get(a) || round.counters.get(b);
            const resolution = rules.resolveExchange(
                actionA.exchange,
                actionB.exchange,
                decision ?? null
            );
            if (resolution.swapped) {
                const boxA = finalBoxes.get(a);
                finalBoxes.set(a, finalBoxes.get(b));
                finalBoxes.set(b, boxA);
            }
            if (resolution.lockCostUserId) {
                const keeper = resolution.lockCostUserId === 'a' ? a : b;
                game.chips.set(keeper, Math.max(0, (game.chips.get(keeper) || 0) - 1));
            }
        }
        round.finalBoxes = finalBoxes;

        const rows = [];
        const eliminated = [];
        const chipDeltas = new Map();
        for (const userId of game.alive) {
            const action = round.actions.get(userId);
            const before = game.chips.get(userId) || 0;
            const after = rules.applyChipOutcome({
                chips: before,
                wager: action.wager,
                box: finalBoxes.get(userId),
            });
            chipDeltas.set(userId, after - before);
            game.chips.set(userId, after);
            const declaration = round.declarations.get(userId) || '（沉默）';
            rows.push({
                userId,
                declaration,
                originalBox: round.boxes.get(userId),
                action: `${action.exchange === 'exchange' ? '交换' : '保留'} · ${action.wager === 'wager' ? '加码' : '稳一手'}`,
                finalBox: finalBoxes.get(userId),
                delta: after - before,
            });
            if (after <= 0) eliminated.push(userId);
        }
        round.eliminated = eliminated;
        snapshot = {
            rows,
            eliminated,
            finalBoxes: Object.fromEntries(finalBoxes),
        };
    });
    if (!snapshot) return false;

    for (const userId of snapshot.eliminated) {
        game.alive = game.alive.filter(id => id !== userId);
        game.chips.delete(userId);
        gameManager.removePlayer(game, userId);
    }
    if (snapshot.eliminated.length > 0) {
        game.eliminationBatch += 1;
        const timeoutMs = rules.eliminationTimeoutMs(game.eliminationBatch);
        for (const userId of snapshot.eliminated) {
            await applyTimeoutBestEffort(game, userId, timeoutMs);
        }
    }

    const revealView = {
        rows: snapshot.rows.map(row => (
            `${row.declaration === '（沉默）' ? '🤐' : `📢 ${row.declaration === 'safe' ? '安全' : '危险'}`} `
            + `<@${row.userId}>：${row.action}，箱子 ${row.finalBox === 'safe' ? '🛡️' : '💥'}，筹码 ${row.delta >= 0 ? `+${row.delta}` : row.delta}`
        )),
        eliminated: snapshot.eliminated,
    };
    await queuePublicWrite(game, () => safeSendProcess(game, panels.revealPanel(revealView), 'reveal'));
    await game.panelRegistry?.retire(game.phaseMessage, {
        context: { action: 'blackbox-round-invalidated' },
    });
    game.phaseMessage = null;

    await startRound(game, game.roundNumber + 1);
    return true;
}

async function applyTimeoutBestEffort(game, userId, timeoutMs) {
    const member = await safeFetchMember(game, userId);
    if (!member || typeof member.timeout !== 'function') return false;
    try {
        await member.timeout(timeoutMs, '神秘指令：黑箱交易');
        return true;
    } catch (error) {
        logFailure(game, 'elimination-timeout', error, userId);
        return false;
    }
}

// ---------- 决赛 ----------

async function startFinal(game) {
    const [a, b] = game.alive;
    game.state = 'final_wager';
    game.final = {
        a,
        b,
        wagers: new Map(),
        wagerCount: 0,
        timeoutMs: null,
        winnerId: null,
        loserId: null,
    };
    if (game.phaseMessage) {
        await game.panelRegistry?.retire(game.phaseMessage, {
            context: { action: 'blackbox-final-invalidated' },
        });
    }
    const message = await queuePublicWrite(game, () => safeSendProcess(
        game,
        panels.finalWagerPanel({ gameId: game.id, revision: 1, a, b }),
        'final-wager-panel'
    ));
    if (!message) {
        await cleanupBlackBox(game);
        return false;
    }
    game.phaseMessage = message;
    game.final.timer = setTimer(game, 'final-wager', () => defaultFinalWager(game), FINAL_WAGER_DURATION_MS);
    return true;
}

async function submitFinalWager(game, { userId, roundId, revision, choice }) {
    let result = null;
    let done = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'final_wager' || !game.final) {
            result = { ok: false, reason: 'stale' };
            return;
        }
        if (![game.final.a, game.final.b].includes(userId)) {
            result = { ok: false, reason: 'not_player' };
            return;
        }
        if (game.final.wagers.has(userId)) {
            result = { ok: false, reason: 'duplicate' };
            return;
        }
        if (!['none', 'wager'].includes(choice)) {
            result = { ok: false, reason: 'invalid' };
            return;
        }
        if (choice === 'wager') {
            const chips = game.chips.get(userId) || 0;
            if (chips < 1) {
                result = { ok: false, reason: 'not_enough_chips' };
                return;
            }
            game.chips.set(userId, chips - 1);
            game.final.wagerCount += 1;
        }
        game.final.wagers.set(userId, choice);
        if (game.final.wagers.size === 2) done = true;
        result = { ok: true };
    });
    if (!result?.ok) return result;
    if (done) {
        clearTimer(game, game.final.timer);
        game.final.timeoutMs = rules.finalTimeoutMs(game.final.wagerCount);
        await startFinalHand(game);
    }
    return result;
}

async function defaultFinalWager(game) {
    let done = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'final_wager' || !game.final) return;
        for (const userId of [game.final.a, game.final.b]) {
            if (!game.final.wagers.has(userId)) {
                game.final.wagers.set(userId, 'none');
            }
        }
        done = true;
    });
    if (!done) return;
    game.final.timeoutMs = rules.finalTimeoutMs(game.final.wagerCount);
    await startFinalHand(game);
}

async function startFinalHand(game) {
    const final = game.final;
    const deck = rules.shuffle(rules.buildFinalDeck(), game.randomInt);
    const [cardA, cardB, hidden] = deck;
    game.state = 'final_hand';
    game.round = {
        id: roundId(),
        revision: 1,
        phase: 'declaration',
        dangerousCount: 1,
        boxes: new Map([[final.a, cardA], [final.b, cardB]]),
        hidden,
        finalBoxes: new Map(),
        pairs: [[final.a, final.b]],
        byeId: null,
        declarations: new Map(),
        actions: new Map(),
        counters: new Map(),
        pendingCounters: [],
        counterIndex: 0,
        eliminated: [],
        resolved: false,
        timer: null,
    };
    if (game.phaseMessage) {
        await game.panelRegistry?.retire(game.phaseMessage, {
            context: { action: 'blackbox-hand-invalidated' },
        });
    }
    const message = await queuePublicWrite(game, () => safeSendProcess(
        game,
        panels.phasePanel(buildPhaseView(game)),
        'final-hand-panel'
    ));
    if (!message) {
        await cleanupBlackBox(game);
        return false;
    }
    game.phaseMessage = message;
    game.round.timer = setTimer(game, 'hand-declaration', () => advanceDeclaration(game, game.round), DECLARATION_DURATION_MS);
    return true;
}

async function resolveFinalHand(game, round) {
    let outcome = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'final_hand' || game.round !== round || round.resolved) return;
        if (round.phase !== 'counter') return;
        round.resolved = true;
        clearTimer(game, round.timer);
        round.timer = null;

        const finalBoxes = new Map(round.boxes);
        for (const [a, b] of round.pairs) {
            const actionA = round.actions.get(a);
            const actionB = round.actions.get(b);
            if (!actionA || !actionB) continue;
            const decision = round.counters.get(a) || round.counters.get(b);
            const resolution = rules.resolveExchange(actionA.exchange, actionB.exchange, decision ?? null);
            if (resolution.swapped) {
                const boxA = finalBoxes.get(a);
                finalBoxes.set(a, finalBoxes.get(b));
                finalBoxes.set(b, boxA);
            }
        }
        round.finalBoxes = finalBoxes;

        const loserId = [game.final.a, game.final.b].find(id => finalBoxes.get(id) === 'dangerous');
        if (!loserId) {
            outcome = { redeal: true };
        } else {
            outcome = {
                redeal: false,
                winnerId: loserId === game.final.a ? game.final.b : game.final.a,
                loserId,
            };
        }
    });
    if (!outcome) return false;
    await game.panelRegistry?.retire(game.phaseMessage, {
        context: { action: 'blackbox-final-hand-invalidated' },
    });
    game.phaseMessage = null;

    if (outcome.redeal) {
        await startFinalHand(game);
        return true;
    }

    game.final.winnerId = outcome.winnerId;
    game.final.loserId = outcome.loserId;
    const timeoutFailed = !await applyTimeoutBestEffort(game, outcome.loserId, game.final.timeoutMs);
    await queuePublicWrite(game, () => safeSend(
        game,
        panels.finalResultPanel({
            winnerId: outcome.winnerId,
            loserId: outcome.loserId,
            timeoutMs: game.final.timeoutMs,
            timeoutFailed,
        }),
        'final-result'
    ));
    game.state = 'ended';
    await cleanupBlackBox(game);
    return true;
}

// ---------- 成员失效 ----------

async function handleBlackBoxMemberInvalidated(game, userId, reason) {
    if (!game || game.type !== 'blackbox' || game.ended) return false;
    let removed = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || !game.participantIds.includes(userId)) return;
        if (!gameManager.removePlayer(game, userId)) return;
        game.alive = game.alive.filter(id => id !== userId);
        game.chips.delete(userId);
        game.inactivityStreak.delete(userId);
        removed = true;
    });
    if (!removed) return false;

    if (game.state === 'final_hand' && game.final && [game.final.a, game.final.b].includes(userId)) {
        const other = userId === game.final.a ? game.final.b : game.final.a;
        game.final.winnerId = other;
        game.final.loserId = userId;
        const timeoutFailed = !await applyTimeoutBestEffort(game, other, game.final.timeoutMs || rules.finalTimeoutMs(0));
        await queuePublicWrite(game, () => safeSend(
            game,
            panels.finalResultPanel({
                winnerId: other,
                loserId: userId,
                timeoutMs: game.final.timeoutMs || rules.finalTimeoutMs(0),
                timeoutFailed,
            }),
            'final-invalidation-result'
        ));
        game.state = 'ended';
        await cleanupBlackBox(game);
        return true;
    }

    if (game.alive.length <= 1) {
        if (game.state === 'recruiting') {
            // 招募中成员离开：人数不足不自动取消，等计时器。
            await renderRecruitment(game);
            return true;
        }
        await startRound(game, game.roundNumber);
        return true;
    }

    if (game.state === 'round' && game.round && game.round.actions.size >= game.alive.length) {
        await processCounters(game, game.round);
    }
    return true;
}

// ---------- 交互路由 ----------

function parseBlackBoxCustomId(customId) {
    const parts = typeof customId === 'string' ? customId.split(':') : [];
    if (parts[0] !== BLACKBOX_CUSTOM_ID_PREFIX || parts.length < 3) return null;
    const action = parts[1];
    const gameId = parts[2];
    if (!action || !gameId) return null;
    return { action, gameId, parts };
}

async function handleBlackBoxInteraction(interaction) {
    const parsed = parseBlackBoxCustomId(interaction?.customId);
    if (!parsed) return false;
    const game = gameManager.getGame(parsed.gameId);
    if (!await deferEphemeralComponent(interaction, game)) return false;
    if (!game || game.type !== 'blackbox') {
        await sendPrivate(interaction, { content: EXPIRED_MESSAGE }, game);
        return true;
    }

    const userId = interaction.user?.id;
    const { action, parts } = parsed;
    if (action === 'join') {
        return handleJoin(interaction, game);
    }
    if (action === 'panel') {
        const roundId = parts[3];
        const revision = Number(parts[4]);
        return openPersonalPanel(interaction, game, roundId, revision);
    }
    if (action === 'declare') {
        const roundId = parts[3];
        const revision = Number(parts[4]);
        const choice = parts[5];
        const result = await submitDeclaration(game, { userId, roundId, revision, choice });
        if (result?.ok) {
            await queuePublicWrite(game, () => safeSendProcess(
                game,
                panels.declarationAnnouncement({ userId, choice }),
                'declaration-announcement'
            ));
        }
        await replySubmissionResult(interaction, game, result, {
            ok: '📢 **声明已公开。**',
            duplicate: '📢 **你已经声明过了。**',
            wrong_phase: '⌛ **现在不是声明阶段。**',
            stale: EXPIRED_MESSAGE,
            not_player: NOT_YOURS_MESSAGE,
            invalid: GENERIC_FAILURE_MESSAGE,
        });
        return true;
    }
    if (action === 'action') {
        const roundId = parts[3];
        const revision = Number(parts[4]);
        const exchange = parts[5];
        const wager = parts[6];
        const result = await submitAction(game, { userId, roundId, revision, exchange, wager });
        await replySubmissionResult(interaction, game, result, {
            ok: '✅ **行动已记录。**',
            duplicate: '✋ **你已经行动过了。**',
            wrong_phase: '⌛ **现在不是行动阶段。**',
            stale: EXPIRED_MESSAGE,
            not_player: NOT_YOURS_MESSAGE,
            invalid: GENERIC_FAILURE_MESSAGE,
            bye_no_exchange: '🚫 **本轮你轮空，不能交换箱子，但仍可押注。**',
        });
        return true;
    }
    if (action === 'counter') {
        const roundId = parts[3];
        const revision = Number(parts[4]);
        const decision = parts[6];
        const result = await submitCounter(game, { userId, roundId, revision, decision });
        await replySubmissionResult(interaction, game, result, {
            ok: '✅ **裁定已提交。**',
            not_yours: NOT_YOURS_MESSAGE,
            wrong_phase: '⌛ **现在不是裁定阶段。**',
            stale: EXPIRED_MESSAGE,
            invalid: GENERIC_FAILURE_MESSAGE,
            not_enough_chips: '🚫 **筹码不足 2 个，无法锁住。**',
        });
        return true;
    }
    if (action === 'finalwager') {
        const revision = Number(parts[3]);
        const choice = parts[4];
        const result = await submitFinalWager(game, { userId, revision, choice });
        await replySubmissionResult(interaction, game, result, {
            ok: '✅ **决赛押注已提交。**',
            duplicate: '✋ **你已经押注过了。**',
            stale: EXPIRED_MESSAGE,
            not_player: NOT_YOURS_MESSAGE,
            invalid: GENERIC_FAILURE_MESSAGE,
            not_enough_chips: '🚫 **没有筹码，无法加码。**',
        });
        return true;
    }
    await sendPrivate(interaction, { content: EXPIRED_MESSAGE }, game);
    return true;
}

async function openPersonalPanel(interaction, game, roundId, revision) {
    const userId = interaction.user?.id;
    const round = game.round;
    let view = null;
    let reason = null;
    await gameManager.runExclusive(game, () => {
        if (!round || round.id !== roundId || round.revision !== revision || game.ended) {
            reason = 'stale';
            return;
        }
        if (!inRoundOrFinal(game)) {
            reason = 'wrong_phase';
            return;
        }
        if (!game.alive.includes(userId)) {
            reason = 'not_player';
            return;
        }
        const box = round.boxes.get(userId);
        const base = { gameId: game.id, roundId: round.id, revision: round.revision, box };
        if (round.phase === 'declaration') {
            view = panels.privateDeclarationPanel(base);
        } else if (round.phase === 'action') {
            view = panels.privateActionPanel({ ...base, bye: round.byeId === userId });
        } else if (round.phase === 'counter') {
            const entry = round.pendingCounters[round.counterIndex];
            if (entry && entry.keeperId === userId) {
                view = panels.counterPanel({
                    gameId: game.id,
                    roundId: round.id,
                    revision: round.revision,
                    keeperId: entry.keeperId,
                    exchangerId: entry.exchangerId,
                });
            } else {
                reason = 'wrong_phase';
            }
        } else {
            reason = 'wrong_phase';
        }
    });
    if (reason || !view) {
        await sendPrivate(interaction, { content: EXPIRED_MESSAGE }, game);
        return false;
    }
    await sendPrivate(interaction, view, game);
    return true;
}

async function replySubmissionResult(interaction, game, result, messages) {
    const text = messages[result?.reason] || messages.ok || GENERIC_FAILURE_MESSAGE;
    await sendPrivate(interaction, { content: text }, game);
}

async function startBlackBox(interaction, {
    onGameStarted,
    randomInt,
    now,
    setTimeoutImpl,
    clearTimeoutImpl,
    panelLifecycle = defaultPanelLifecycle,
} = {}) {
    const userId = interaction.user?.id;
    const guildId = interaction.guildId || interaction.guild?.id;
    const channelId = interaction.channelId;
    const provisional = createGameInput(interaction, userId, guildId, channelId, {
        randomInt,
        now,
        setTimeoutImpl,
        clearTimeoutImpl,
        panelLifecycle,
    });
    provisional.onGameStarted = onGameStarted;

    if (!await deferPublicStart(interaction, provisional)) return false;
    const initiator = await safeFetchMember(provisional, userId);
    if (!isCurrentGuildMember(provisional, initiator, userId)) {
        await interaction.editReply({ content: '🚫 **你现在无法参加黑箱交易。**' });
        return false;
    }

    const created = gameManager.createGame(provisional);
    if (!created.ok) {
        await interaction.editReply({
            content: created.reason === 'player'
                ? '🚫 **你已经在另一场神秘游戏里了。**'
                : '🎮 **这里已经有一场游戏在进行了。**',
        });
        return false;
    }
    const game = created.game;
    game.onMemberInvalidated = async invalidMember => {
        const invalidUserId = invalidMember?.id || invalidMember?.user?.id;
        if (invalidUserId) await handleBlackBoxMemberInvalidated(game, invalidUserId, 'member-invalidated');
    };

    await renderRecruitment(game);
    if (!game.recruitMessage) {
        await cleanupBlackBox(game);
        return false;
    }

    game.recruitTimer = setTimer(game, 'recruitment', () => expireRecruitment(game), RECRUIT_DURATION_MS);
    return true;
}

function resetForTests() {
    gameManager.resetForTests();
}

module.exports = {
    BLACKBOX_CUSTOM_ID_PREFIX,
    startBlackBox,
    handleBlackBoxInteraction,
    handleBlackBoxMemberInvalidated,
    resetForTests,
};
