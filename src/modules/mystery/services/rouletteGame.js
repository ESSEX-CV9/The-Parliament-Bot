const { randomUUID } = require('node:crypto');
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
} = require('discord.js');
const gameManager = require('./mysteryGameManager');
const defaultPanelLifecycle = require('./panelLifecycle');

const RECRUITMENT_DURATION_MS = 3 * 60 * 1000;
const DECISION_DURATION_MS = 30 * 1000;
const MAX_PARTICIPANTS = 8;
const MIN_PARTICIPANTS = 3;
const MAX_ROUNDS = 6;
const TIMEOUT_REASON = '神秘指令：运气轮盘';

// Penalty per round: round 1 = 5min, round 2 = 6min, ..., round 6 = 10min
const ROUND_PENALTY_MINUTES = [5, 6, 7, 8, 9, 10];
const FIRST_WINNER_REPEAT_MINUTES = 10;
const ALL_WINNERS_TIMEOUT_MINUTES = 5;

const PLAYER_BUSY_MESSAGE = '🚫 **一心不能二用。**\n你现在已经在一场神秘游戏里，先把那边活着玩完再说。';
const CHANNEL_BUSY_MESSAGE = '🎮 **这里已经有一场游戏在进行了。**\n等当前游戏结束后再开新的吧。';
const TIMEOUT_BLOCKED_MESSAGE = '🎰 **轮盘拒绝了你。**\n你当前还在禁言，暂时无法参加。';
const INVALID_MEMBER_MESSAGE = '⚠️ **你现在无法参加这场运气轮盘。**';
const EXPIRED_MESSAGE = '⌛ **这场运气轮盘已经结束或失效了。**';
const FULL_MESSAGE = '🎰 **这场运气轮盘已经满员了。**';
const DUPLICATE_MESSAGE = '👀 **你已经参加这场游戏了。**\n再点也不会增加中奖概率。';
const JOINED_MESSAGE = '✅ **你已加入运气轮盘**\n\n接下来就看命了。';
const JOIN_FAILURE_MESSAGE = '❌ **参加运气轮盘失败了。**\n请稍后再试。';
const NOT_YOUR_DECISION_MESSAGE = '🎰 **轮盘现在不听你的，等你中枪了再说。**';
const STOP_ACK_MESSAGE = '🛑 **你选择了收手。**\n正在结算本局处罚……';
const CONTINUE_ACK_MESSAGE = '🎰 **继续转！**\n下一轮马上开始。';

function logDiscordFailure(game, action, error, userId = 'system') {
    console.error(
        `[MysteryRoulette] Discord API 失败 (guild=${game?.guildId || 'unknown'}, game=${game?.id || 'unknown'}, user=${userId}, action=${action}):`,
        error
    );
}

function penaltyMinutes(roundNumber) {
    const idx = Math.min(roundNumber - 1, ROUND_PENALTY_MINUTES.length - 1);
    return ROUND_PENALTY_MINUTES[Math.max(0, idx)];
}

function makeEmbed(description) {
    return new EmbedBuilder().setDescription(description);
}

// ── Panel builders ──────────────────────────────────────────────────────────

function recruitmentDescription(game) {
    const startsAt = Math.floor((game.recruitmentEndsAt ?? Date.now() + RECRUITMENT_DURATION_MS) / 1000);
    return [
        '🎰 **运气轮盘已开启**',
        '',
        `<@${game.initiatorId}> 发起了一场运气轮盘，并已自动加入游戏。`,
        '',
        '**游戏规则**',
        '- 本游戏为自愿参加，点击按钮即视为接受游戏规则',
        '- 最少 **3 人**、最多 **8 人**',
        '- 满 **8 人**立即开始',
        '- 未满 8 人将在 **3 分钟后**尝试开始',
        '- 游戏最多进行 **6 轮**，第 6 轮后强制结束',
        '- 每轮随机抽选一名参与者，中过的人仍在池中',
        '- 被抽中者有 **30 秒**决定：**收手** 或 **继续转**，超时默认收手',
        '- 每轮处罚递增：第 1 轮 **5 分钟**，之后每轮 +1，第 6 轮 **10 分钟**',
        '- 收手则游戏结束，所有被抽中过的玩家按本局最高处罚统一禁言',
        '- 连续两轮被抽中则强制结束',
        '- 第一轮被抽中者若再次被抽中，直接升至 **10 分钟**',
        '',
        `**当前人数：${game.participantIds.length} / ${MAX_PARTICIPANTS}**`,
        `⏳ **预计开始：<t:${startsAt}:R>**`,
    ].join('\n');
}

function cancellationDescription() {
    return [
        '🥀 **运气轮盘开不起来了**',
        '',
        '等待 3 分钟后，本轮仍未达到最低 **3 人**。',
        '',
        '本轮游戏自动取消。',
        '',
        '看来今天大家都很珍惜自己的发言权。',
    ].join('\n');
}

function allWinnersDescription() {
    return [
        '🚨 **等等，好像哪里不对……**',
        '',
        '轮盘在最后一刻突然失控。',
        '',
        '🎰 **恭喜，全员中奖。**',
        '',
        '本局所有参与者将被 **禁言 5 分钟**。',
        '',
        '*看来今天的幸运比较平均。*',
    ].join('\n');
}

function allWinnersFailedDescription(failedCount) {
    return [
        allWinnersDescription(),
        '',
        `🛡️ **${failedCount} 人的禁言被神秘力量阻挡，未能生效。**`,
    ].join('\n');
}

function roundHitDescription(winnerId, roundNumber, mins) {
    return [
        `🎯 **第 ${roundNumber} 轮：幸运儿诞生！**`,
        '',
        `<@${winnerId}> 被轮盘选中！`,
        '',
        `本轮处罚：**禁言 ${mins} 分钟**`,
        '',
        '现在，这位幸运儿可以选择：',
        '🛑 **收手** — 游戏结束，所有人按累计处罚执行',
        '🎰 **继续转** — 进入下一轮',
    ].join('\n');
}

function roundHitFirstWinnerDescription(winnerId, roundNumber) {
    return [
        `🎯 **第 ${roundNumber} 轮：幸运儿诞生！**`,
        '',
        `<@${winnerId}> 再次被轮盘选中！`,
        '',
        '作为第一轮的幸运儿，处罚直接升至：**禁言 10 分钟**',
        '',
        '现在，这位幸运儿可以选择：',
        '🛑 **收手** — 游戏结束，所有人按累计处罚执行',
        '🎰 **继续转** — 进入下一轮',
    ].join('\n');
}

function forcedEndDescription(winnerId, roundNumber, mins, reason) {
    const lines = [
        `🎯 **第 ${roundNumber} 轮：幸运儿诞生！**`,
        '',
        `<@${winnerId}> 被轮盘选中！`,
        '',
        `本轮处罚：**禁言 ${mins} 分钟**`,
    ];
    if (reason === 'consecutive') {
        lines.push('', '💥 **同一个玩家连续两轮被选中！**');
    } else if (reason === 'consecutive_first') {
        lines.push('', '💥 **第一轮幸运儿连续被选中！**');
        lines.push('', '处罚直接升至：**禁言 10 分钟**');
    } else if (reason === 'round_limit') {
        lines.push('', '⌛ **已到第 6 轮，游戏强制结束。**');
    }
    lines.push('', '游戏立即结束，不再继续。');
    return lines.join('\n');
}

function settlementDescription(results) {
    const lines = [
        '🏁 **运气轮盘结束**',
        '',
        `本局共进行了 **${results.roundsPlayed} 轮**。`,
        '',
    ];
    const endReasons = {
        stop: '玩家主动收手',
        timeout: '30 秒超时默认收手',
        consecutive: '连续中奖强制结束',
        round_limit: '第 6 轮强制结束',
        all_winners: '5% 全员中奖',
    };
    lines.push(`结束原因：**${endReasons[results.endReason] || results.endReason}**`);
    lines.push('');

    if (results.penalties.length > 0) {
        lines.push('**最终处罚：**');
        for (const p of results.penalties) {
            lines.push(`- <@${p.userId}>：**禁言 ${p.minutes} 分钟**`);
        }
    } else {
        lines.push('没有人受到处罚。');
    }

    if (results.timeoutFailedIds.length > 0) {
        lines.push('');
        lines.push(`🛡️ **${results.timeoutFailedIds.length} 人的禁言被神秘力量阻挡，未能生效。**`);
    }

    return lines.join('\n');
}

// ── Component builders ──────────────────────────────────────────────────────

function joinRow(gameId, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`mystery_roulette_join:${gameId}`)
            .setLabel('🎰 自愿参加')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled)
    );
}

function decisionRow(gameId, roundToken) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`mystery_roulette_stop:${gameId}:${roundToken}`)
            .setLabel('🛑 收手')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`mystery_roulette_continue:${gameId}:${roundToken}`)
            .setLabel('🎰 继续转')
            .setStyle(ButtonStyle.Primary)
    );
}

function recruitmentPayload(game, disabled = false) {
    return {
        embeds: [makeEmbed(recruitmentDescription(game))],
        components: [joinRow(game.id, disabled)],
    };
}

// ── Discord helpers ─────────────────────────────────────────────────────────

async function deferReply(interaction, payload, game, action) {
    try {
        await interaction.deferReply(payload);
        return true;
    } catch (error) {
        logDiscordFailure(game, action, error, interaction.user?.id);
        return false;
    }
}

async function replacePublicDeferWithEphemeral(interaction, content, game) {
    try {
        await interaction.deleteReply();
    } catch (error) {
        logDiscordFailure(game, 'delete-public-defer', error, interaction.user?.id);
    }
    try {
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } catch (error) {
        logDiscordFailure(game, 'ephemeral-follow-up', error, interaction.user?.id);
    }
}

async function safeDeferredReplyEdit(interaction, content, game) {
    try {
        await interaction.editReply({ content });
    } catch (error) {
        logDiscordFailure(game, 'ephemeral-edit-reply', error, interaction.user?.id);
    }
}

async function safePrivateResponse(interaction, content, game) {
    try {
        if (interaction.deferred && !interaction.replied && typeof interaction.editReply === 'function') {
            await interaction.editReply({ content });
        } else if (interaction.replied && typeof interaction.followUp === 'function') {
            await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
        } else if (!interaction.deferred && !interaction.replied && typeof interaction.reply === 'function') {
            await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }
    } catch (error) {
        logDiscordFailure(game, 'private-response', error, interaction.user?.id);
    }
}

function isActivelyTimedOut(member, now = Date.now()) {
    return Number(member?.communicationDisabledUntilTimestamp) > now;
}

function isValidHumanMember(member) {
    return Boolean(member?.id && member.user && !member.user.bot && !isActivelyTimedOut(member));
}

async function fetchMember(game, userId) {
    try {
        return await game.guild.members.fetch(userId);
    } catch (error) {
        logDiscordFailure(game, 'fetch-member', error, userId);
        return null;
    }
}

async function editPublicPanel(game, payload, action) {
    return editMessage(game, game.message, payload, action);
}

async function editMessage(game, message, payload, action) {
    if (!message || typeof message.edit !== 'function') return false;
    try {
        await message.edit(payload);
        return true;
    } catch (error) {
        logDiscordFailure(game, action, error);
        return false;
    }
}

async function sendPublicPanel(game, payload, action) {
    if (!game.channel || typeof game.channel.send !== 'function') return null;
    try {
        return await game.channel.send(payload);
    } catch (error) {
        logDiscordFailure(game, action, error);
        return null;
    }
}

// ── Recruitment panel queue ─────────────────────────────────────────────────

function queueRecruitmentPanelEdit(game, action, finalize) {
    const version = (game.recruitmentPanelVersion || 0) + 1;
    game.recruitmentPanelVersion = version;
    const previous = game.recruitmentPanelQueue || Promise.resolve();
    const operation = previous
        .catch(error => {
            logDiscordFailure(game, 'recruitment-panel-queue', error);
        })
        .then(async () => {
            let result;
            if (game.ended || game.state !== 'recruiting') {
                result = { updated: false, stale: true };
            } else {
                result = {
                    updated: await editPublicPanel(game, recruitmentPayload(game), action),
                    stale: false,
                };
            }
            await finalize?.(result);
            return result;
        })
        .catch(error => {
            logDiscordFailure(game, 'recruitment-panel-queue', error);
            return { updated: false, stale: true };
        })
        .finally(() => {
            game.recruitmentPanelCompletedVersion = Math.max(
                game.recruitmentPanelCompletedVersion || 0,
                version
            );
        });
    game.recruitmentPanelQueue = operation;
    return operation;
}

async function waitForRecruitmentPanelQueue(game) {
    try {
        await game.recruitmentPanelQueue;
    } catch (error) {
        logDiscordFailure(game, 'recruitment-panel-queue-wait', error);
    }
}

function invalidateRecruitmentPanel(game, action) {
    if (!game?.message) return;
    void game.panelLifecycle.invalidatePanel(game.message, {
        disablePayload: { components: [joinRow(game.id, true)] },
        context: { action, guildId: game.guildId, gameId: game.id },
    });
}

function invalidateProcessPanel(game, message, action, keepMessage = false) {
    if (!message) return;
    void game.panelLifecycle.invalidatePanel(message, {
        keepMessage,
        context: { action, guildId: game.guildId, gameId: game.id },
    });
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

function clearDecisionTimer(game) {
    if (game.decisionTimer) {
        clearTimeout(game.decisionTimer);
        game.timers.delete(game.decisionTimer);
        game.decisionTimer = null;
    }
}

async function cleanupRouletteGame(game) {
    clearDecisionTimer(game);
    await waitForRecruitmentPanelQueue(game);
    // 过程面板（开局 + 每轮）：先禁用，释放游戏锁后按现有 5 秒延迟统一删除；
    // 结算/全员中奖等最终结果面板不入此集合，永久保留。
    const processMessages = [...(game.processMessages || [])];
    for (const message of processMessages) {
        invalidateProcessPanel(game, message, 'game-cleanup', true);
    }
    await gameManager.cleanupGame(game);
    for (const message of processMessages) {
        game.panelLifecycle.deleteMessageAfter(
            message,
            5_000,
            { action: 'game-cleanup', guildId: game.guildId, gameId: game.id }
        );
    }
}

// ── Start ping helper ───────────────────────────────────────────────────────

async function sendStartPing(game, participantIds) {
    try {
        const content = '🎮 **「运气轮盘」开始了！**\n'
            + participantIds.map(id => `<@${id}>`).join(' ')
            + '\n\n别聊忘了，回来开转。';
        await game.channel.send({
            content,
            allowedMentions: { parse: [], users: participantIds },
        });
    } catch (error) {
        logDiscordFailure(game, 'start-ping', error);
    }
}

// ── Participant validation ──────────────────────────────────────────────────

async function fetchValidParticipants(game, participantIds) {
    const validMembers = new Map();
    for (const userId of participantIds) {
        const member = await fetchMember(game, userId);
        if (isValidHumanMember(member)) validMembers.set(userId, member);
    }
    return validMembers;
}

// ── Settlement ──────────────────────────────────────────────────────────────

async function applyTimeouts(game, penalties, members) {
    const failedIds = [];
    const appliedMinutes = new Map();
    for (const p of penalties) {
        if (appliedMinutes.has(p.userId)) continue;
        const minutes = p.minutes;
        const ms = minutes * 60 * 1000;
        const member = members.get(p.userId);
        if (!member?.moderatable || typeof member.timeout !== 'function') {
            failedIds.push(p.userId);
            continue;
        }
        try {
            await member.timeout(ms, TIMEOUT_REASON);
            appliedMinutes.set(p.userId, minutes);
        } catch (error) {
            failedIds.push(p.userId);
            logDiscordFailure(game, 'timeout-member', error, p.userId);
        }
    }
    return failedIds;
}

async function settleAndFinish(game) {
    let results = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.settled) return;
        game.settled = true;
        game.state = 'ended';
        results = {
            roundsPlayed: game.roundNumber || 0,
            endReason: game.endReason || 'unknown',
            penalties: [],
            timeoutFailedIds: [],
        };
        // Build final penalty list: each player gets their highest penalty
        for (const [userId, mins] of game.penalties) {
            results.penalties.push({ userId, minutes: mins });
        }
    });
    if (!results) return;

    // Fetch fresh members for timeout
    const validMembers = await fetchValidParticipants(
        game,
        results.penalties.map(p => p.userId)
    );

    // Update penalties for members that became invalid
    results.penalties = results.penalties.filter(p => validMembers.has(p.userId));

    if (results.penalties.length > 0) {
        results.timeoutFailedIds = await applyTimeouts(game, results.penalties, validMembers);
    }

    // Send settlement panel
    const desc = settlementDescription(results);
    await sendPublicPanel(game, { embeds: [makeEmbed(desc)], components: [] }, 'settlement-panel');

    await cleanupRouletteGame(game);
}

// ── Round decision ──────────────────────────────────────────────────────────

function clearDecisionState(game) {
    clearDecisionTimer(game);
    game.decisionToken = null;
    game.currentWinnerId = null;
}

// 同步认领本轮决定：成功才返回 action，随后先回复交互、再执行后续（结算/下一轮）。
async function claimDecision(game, winnerId, choice) {
    let action = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') return;
        if (game.currentWinnerId !== winnerId) return;
        if (!game.decisionToken) return;

        clearDecisionState(game);

        if (choice === 'stop') {
            game.endReason = 'stop';
            action = 'settle';
        } else if (game.roundNumber >= MAX_ROUNDS) {
            // Should not happen: round 6 has no continue button
            game.endReason = 'round_limit';
            action = 'settle';
        } else {
            action = 'continue';
        }
    });
    return action;
}

async function executeDecision(game, action) {
    if (action === 'settle') {
        await settleAndFinish(game);
        return true;
    }
    if (action === 'continue') {
        await runNextRound(game);
        return true;
    }
    return false;
}

async function handleDecisionTimeout(game, expectedToken) {
    let shouldSettle = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') return;
        if (game.decisionToken !== expectedToken) return;
        clearDecisionState(game);
        game.endReason = 'timeout';
        shouldSettle = true;
    });
    if (shouldSettle) {
        await settleAndFinish(game);
    }
}

// ── Round logic ─────────────────────────────────────────────────────────────

async function runNextRound(game) {
    let roundData = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') return;

        game.roundNumber += 1;
        const round = game.roundNumber;

        // Already checked round limit, but guard anyway
        if (round > MAX_ROUNDS) {
            game.endReason = 'round_limit';
            game.state = 'ended';
            return;
        }

        // Select random winner from all current participants
        const pool = [...game.participantIds];
        const index = Math.min(pool.length - 1, Math.max(0, Math.floor(game.random() * pool.length)));
        const winnerId = pool[index];

        // Calculate penalty
        let mins = penaltyMinutes(round);
        let isFirstWinnerRepeat = false;

        if (game.firstWinnerId && winnerId === game.firstWinnerId) {
            mins = FIRST_WINNER_REPEAT_MINUTES;
            isFirstWinnerRepeat = true;
        }

        // Check consecutive
        const isConsecutive = game.previousWinnerId === winnerId;

        // Update penalty map (max)
        const currentMax = game.penalties.get(winnerId) || 0;
        game.penalties.set(winnerId, Math.max(currentMax, mins));

        // Set state for this round
        game.previousWinnerId = winnerId;
        game.currentWinnerId = winnerId;
        game.decisionToken = randomUUID().replaceAll('-', '').slice(0, 12);

        const forceEnd = isConsecutive || round >= MAX_ROUNDS;

        roundData = {
            round,
            winnerId,
            mins,
            isFirstWinnerRepeat,
            isConsecutive,
            forceEnd,
            decisionToken: game.decisionToken,
        };

        if (!game.firstWinnerId && round === 1) {
            game.firstWinnerId = winnerId;
        }

        if (forceEnd) {
            if (isConsecutive && isFirstWinnerRepeat) {
                game.endReason = 'consecutive_first';
            } else if (isConsecutive) {
                game.endReason = 'consecutive';
            } else {
                game.endReason = 'round_limit';
            }
            clearDecisionState(game);
        }
    });

    if (!roundData) {
        await settleAndFinish(game);
        return;
    }

    // Fetch winner member for validation
    const winnerMember = await fetchMember(game, roundData.winnerId);

    // Check if winner is still valid
    let winnerInvalid = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') return;
        if (game.currentWinnerId !== roundData.winnerId) return;
        if (!isValidHumanMember(winnerMember)) {
            winnerInvalid = true;
            game.endReason = 'winner_invalid';
            clearDecisionState(game);
        }
    });

    if (winnerInvalid) {
        await settleAndFinish(game);
        return;
    }

    // Build description
    let desc;
    if (roundData.forceEnd) {
        desc = forcedEndDescription(
            roundData.winnerId,
            roundData.round,
            roundData.mins,
            roundData.isConsecutive ? (roundData.isFirstWinnerRepeat ? 'consecutive_first' : 'consecutive') : 'round_limit'
        );
    } else if (roundData.isFirstWinnerRepeat) {
        desc = roundHitFirstWinnerDescription(roundData.winnerId, roundData.round);
    } else {
        desc = roundHitDescription(roundData.winnerId, roundData.round, roundData.mins);
    }

    const components = roundData.forceEnd
        ? []
        : [decisionRow(game.id, roundData.decisionToken)];

    // 每轮新发一条消息，不覆盖旧面板：旧面板禁用按钮后保留可见，方便回看历史。
    const previousMessages = [...(game.processMessages || [])];
    game.processMessages = new Set();
    for (const oldMessage of previousMessages) {
        invalidateProcessPanel(game, oldMessage, 'round-superseded', true);
    }

    const roundMessage = await sendPublicPanel(game, {
        embeds: [makeEmbed(desc)],
        components,
    }, 'round-panel');
    if (roundMessage) {
        game.processMessages.add(roundMessage);
    }

    if (roundData.forceEnd) {
        await settleAndFinish(game);
        return;
    }

    // Arm decision timer
    const token = roundData.decisionToken;
    const timer = setTimeout(() => {
        game.timers.delete(timer);
        handleDecisionTimeout(game, token).catch(error =>
            logDiscordFailure(game, 'decision-timer', error)
        );
    }, DECISION_DURATION_MS);
    timer.unref?.();
    game.timers.add(timer);
    game.decisionTimer = timer;
}

// ── Game start / 5% check ───────────────────────────────────────────────────

async function startGameplay(game, participantIds, members) {
    // 5% all-winners check — once per game
    if (!game.specialRollChecked) {
        game.specialRollChecked = true;
        if (game.random() < 0.05) {
            game.endReason = 'all_winners';
            // All participants get 5 min
            for (const userId of participantIds) {
                const current = game.penalties.get(userId) || 0;
                game.penalties.set(userId, Math.max(current, ALL_WINNERS_TIMEOUT_MINUTES));
            }
            game.state = 'ended';
            game.settled = true;

            // 全员中奖作为最终结果另发一条永久消息，开局面板保留不动。
            const allWinnersMessage = await sendPublicPanel(game, {
                embeds: [makeEmbed(allWinnersDescription())],
                components: [],
            }, 'all-winners-result');

            // Apply timeouts
            const failedIds = await applyTimeouts(
                game,
                participantIds.map(userId => ({ userId, minutes: ALL_WINNERS_TIMEOUT_MINUTES })),
                members
            );
            if (failedIds.length > 0 && allWinnersMessage) {
                await editMessage(game, allWinnersMessage, {
                    embeds: [makeEmbed(allWinnersFailedDescription(failedIds.length))],
                    components: [],
                }, 'all-winners-failed');
            }

            await cleanupRouletteGame(game);
            return;
        }
    }

    // Start first round
    game.roundNumber = 0;
    await runNextRound(game);
}

// ── Recruitment → gameplay transition ───────────────────────────────────────

async function claimSettlement(game) {
    while (true) {
        const observedPanelVersion = game.recruitmentPanelVersion || 0;
        await waitForRecruitmentPanelQueue(game);

        let ownsSettlement = false;
        let panelQueueAdvanced = false;
        await gameManager.runExclusive(game, () => {
            if (game.ended || game.state !== 'recruiting') return;
            if ((game.recruitmentPanelVersion || 0) !== observedPanelVersion) {
                panelQueueAdvanced = true;
                return;
            }
            if (game.pendingJoins > 0) {
                game.startRequested = true;
                return;
            }

            game.state = 'starting';
            ownsSettlement = true;
            if (game.recruitmentTimer) {
                clearTimeout(game.recruitmentTimer);
                game.timers.delete(game.recruitmentTimer);
                game.recruitmentTimer = null;
            }
        });
        if (!panelQueueAdvanced) return ownsSettlement;
    }
}

async function settleClaimedGame(game) {
    invalidateRecruitmentPanel(game, 'recruitment-ended');

    const participantSnapshot = [...game.participantIds];
    const fetchedMembers = await fetchValidParticipants(game, participantSnapshot);

    let decision = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'starting' || game.resolved) return;

        for (const userId of participantSnapshot) {
            if (game.participantIds.includes(userId) && !fetchedMembers.has(userId)) {
                gameManager.removePlayer(game, userId);
            }
        }

        const validIds = game.participantIds.filter(userId => fetchedMembers.has(userId));
        if (validIds.length < MIN_PARTICIPANTS) {
            game.state = 'ended';
            decision = { cancelled: true };
            return;
        }

        decision = { cancelled: false, participantIds: validIds };
    });

    if (!decision) return;
    if (decision.cancelled) {
        await sendPublicPanel(game, {
            embeds: [makeEmbed(cancellationDescription())],
            components: [],
        }, 'cancel-panel');
        await cleanupRouletteGame(game);
        return;
    }

    // Send start ping
    await sendStartPing(game, decision.participantIds);

    // Send starting panel
    const mentions = decision.participantIds.map(userId => `<@${userId}>`).join('、');
    const startDesc = [
        '🎰 **轮盘开始转动……**',
        '',
        '**本局参与者：**',
        mentions,
        '',
        `本局共有 **${decision.participantIds.length} 名玩家**。`,
        '',
        '正在从各位勇士之中挑选幸运儿……',
        '',
        '**祝你好运。**',
        '',
        '*或者祝别人好运。*',
    ].join('\n');

    const processMessage = await sendPublicPanel(game, {
        embeds: [makeEmbed(startDesc)],
        components: [],
    }, 'starting-panel');

    if (!processMessage) {
        await cleanupRouletteGame(game);
        return;
    }

    game.processMessages = new Set([processMessage]);

    // Transition to playing and start gameplay
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'starting') return;
        game.state = 'playing';
    });

    await startGameplay(game, decision.participantIds, fetchedMembers);
}

async function finishRecruitment(game) {
    if (await claimSettlement(game)) {
        await settleClaimedGame(game);
    }
}

// ── Public API: start game ──────────────────────────────────────────────────

async function startRoulette(interaction, { panelLifecycle = defaultPanelLifecycle } = {}) {
    const userId = interaction.user?.id;
    const guildId = interaction.guildId || interaction.guild?.id;
    const channelId = interaction.channelId;
    const provisionalGame = {
        id: randomUUID(),
        type: 'roulette',
        guildId,
        channelId,
        channel: interaction.channel,
        guild: interaction.guild,
        initiatorId: userId,
        participantIds: [userId],
        state: 'recruiting',
        resolved: false,
        pendingJoins: 0,
        startRequested: false,
        recruitmentPanelVersion: 0,
        recruitmentPanelCompletedVersion: 0,
        recruitmentPanelQueue: Promise.resolve(),
        // Multi-round state
        roundNumber: 0,
        firstWinnerId: null,
        previousWinnerId: null,
        currentWinnerId: null,
        penalties: new Map(),
        decisionToken: null,
        decisionTimer: null,
        specialRollChecked: false,
        settled: false,
        endReason: null,
        processMessages: new Set(),
        random: Math.random,
        timers: new Set(),
        panelLifecycle,
    };

    if (!await deferReply(interaction, undefined, provisionalGame, 'defer-recruitment')) {
        return false;
    }

    const member = await fetchMember(provisionalGame, userId);
    if (!member?.id || !member.user || member.user.bot) {
        await replacePublicDeferWithEphemeral(interaction, INVALID_MEMBER_MESSAGE, provisionalGame);
        return false;
    }
    if (isActivelyTimedOut(member)) {
        await replacePublicDeferWithEphemeral(interaction, TIMEOUT_BLOCKED_MESSAGE, provisionalGame);
        return false;
    }

    let game;
    provisionalGame.onMemberInvalidated = async invalidMember => {
        const invalidUserId = invalidMember?.id || invalidMember?.user?.id;
        if (invalidUserId) {
            await handleRouletteMemberInvalidated(game, invalidUserId, 'member-invalidated');
        }
    };
    provisionalGame.disableComponents = () => {
        clearDecisionTimer(game);
        if (game?.processMessages?.size) {
            for (const message of game.processMessages) {
                invalidateProcessPanel(game, message, 'game-cleanup', true);
            }
        } else {
            invalidateRecruitmentPanel(game, 'game-cleanup');
        }
    };

    const created = gameManager.createGame(provisionalGame);
    if (!created.ok) {
        await replacePublicDeferWithEphemeral(
            interaction,
            created.reason === 'player' ? PLAYER_BUSY_MESSAGE : CHANNEL_BUSY_MESSAGE,
            provisionalGame
        );
        return false;
    }
    game = created.game;
    game.recruitmentEndsAt = Date.now() + RECRUITMENT_DURATION_MS;

    try {
        const replyResult = await interaction.editReply(recruitmentPayload(game));
        const replyMessage = replyResult?.resource?.message || replyResult;
        if (typeof replyMessage?.edit === 'function') {
            game.message = replyMessage;
        } else if (typeof interaction.editReply === 'function') {
            game.message = { edit: payload => interaction.editReply(payload) };
        }
    } catch (error) {
        logDiscordFailure(game, 'recruitment-panel', error, userId);
        await cleanupRouletteGame(game);
        await replacePublicDeferWithEphemeral(interaction, JOIN_FAILURE_MESSAGE, game);
        return false;
    }

    try {
        const fetchedReply = await interaction.fetchReply();
        if (typeof fetchedReply?.edit === 'function') game.message = fetchedReply;
    } catch (error) {
        logDiscordFailure(game, 'fetch-recruitment-panel', error, userId);
        if (!game.message) {
            await cleanupRouletteGame(game);
            return false;
        }
    }

    game.recruitmentTimer = setTimeout(
        () => finishRecruitment(game).catch(error => logDiscordFailure(game, 'recruitment-timer', error)),
        RECRUITMENT_DURATION_MS
    );
    game.timers.add(game.recruitmentTimer);
    return true;
}

// ── Interaction parsing ─────────────────────────────────────────────────────

function parseJoinParts(parts) {
    const tokens = (Array.isArray(parts) ? parts : [parts])
        .filter(part => typeof part === 'string')
        .flatMap(part => part.split(/[:_]/))
        .filter(Boolean)
        .filter(part => part !== 'mystery' && part !== 'roulette');
    const actionIndex = tokens.indexOf('join');
    if (actionIndex === -1) return null;
    return tokens[actionIndex + 1] || tokens.at(-1);
}

function parseDecisionParts(parts) {
    const tokens = (Array.isArray(parts) ? parts : [parts])
        .filter(part => typeof part === 'string')
        .flatMap(part => part.split(/[:_]/))
        .filter(Boolean)
        .filter(part => part !== 'mystery' && part !== 'roulette');
    // Expected: ["stop", gameId, roundToken] or ["continue", gameId, roundToken]
    const action = tokens[0]; // "stop" or "continue"
    return {
        action,
        gameId: tokens[1],
        roundToken: tokens[2],
    };
}

// ── Interaction handlers ────────────────────────────────────────────────────

async function handleRouletteInteraction(interaction, parts) {
    const customId = interaction.customId || '';

    // Check if it's a decision button (stop/continue)
    if (customId.includes('_stop:') || customId.includes('_continue:')) {
        return handleDecisionInteraction(interaction, parts);
    }

    // Otherwise it's a join button
    return handleJoinInteraction(interaction, parts);
}

async function handleDecisionInteraction(interaction, parts) {
    const parsed = parseDecisionParts(parts);
    const game = parsed.gameId && gameManager.getGame(parsed.gameId);

    if (!game || game.type !== 'roulette') {
        await safePrivateResponse(interaction, EXPIRED_MESSAGE, game);
        return false;
    }

    const userId = interaction.user?.id;
    const choice = parsed.action === 'stop' ? 'stop' : 'continue';

    // Quick validation outside exclusive lock
    let rejection = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') {
            rejection = EXPIRED_MESSAGE;
        } else if (game.currentWinnerId !== userId) {
            rejection = NOT_YOUR_DECISION_MESSAGE;
        } else if (game.decisionToken !== parsed.roundToken) {
            rejection = EXPIRED_MESSAGE;
        }
    });

    if (rejection) {
        await safePrivateResponse(interaction, rejection, game);
        return false;
    }

    // For "continue" on round 6: should never have the button, but guard
    if (choice === 'continue' && game.roundNumber >= MAX_ROUNDS) {
        await safePrivateResponse(interaction, EXPIRED_MESSAGE, game);
        return false;
    }

    // 先认领决定（防止 double click / timer race），再立即回复交互，最后执行。
    const action = await claimDecision(game, userId, choice);
    if (!action) {
        await safePrivateResponse(interaction, EXPIRED_MESSAGE, game);
        return false;
    }

    await safePrivateResponse(
        interaction,
        choice === 'stop' ? STOP_ACK_MESSAGE : CONTINUE_ACK_MESSAGE,
        game
    );

    await executeDecision(game, action);
    return true;
}

async function handleJoinInteraction(interaction, parts) {
    if (!await deferReply(
        interaction,
        { flags: MessageFlags.Ephemeral },
        null,
        'defer-join'
    )) {
        return false;
    }

    const gameId = parseJoinParts(parts);
    const game = gameId && gameManager.getGame(gameId);
    if (!game || game.type !== 'roulette') {
        await safeDeferredReplyEdit(interaction, EXPIRED_MESSAGE, game);
        return false;
    }

    const userId = interaction.user?.id;
    let rejectionMessage = null;
    const inspectJoinState = () => {
        if (
            game.ended
            || game.state !== 'recruiting'
            || interaction.channelId !== game.channelId
            || (interaction.guildId || interaction.guild?.id) !== game.guildId
        ) {
            return EXPIRED_MESSAGE;
        }
        if (game.participantIds.includes(userId)) {
            return DUPLICATE_MESSAGE;
        }
        if (game.participantIds.length >= MAX_PARTICIPANTS) {
            return FULL_MESSAGE;
        }
        return null;
    };

    await gameManager.runExclusive(game, () => {
        rejectionMessage = inspectJoinState();
    });
    if (rejectionMessage) {
        await safeDeferredReplyEdit(interaction, rejectionMessage, game);
        return false;
    }

    const member = await fetchMember(game, userId);
    if (!member?.id || !member.user || member.user.bot) {
        await safeDeferredReplyEdit(interaction, INVALID_MEMBER_MESSAGE, game);
        return false;
    }
    if (isActivelyTimedOut(member)) {
        await safeDeferredReplyEdit(interaction, TIMEOUT_BLOCKED_MESSAGE, game);
        return false;
    }

    let joinCommitted = false;
    await gameManager.runExclusive(game, () => {
        rejectionMessage = inspectJoinState();
        if (rejectionMessage) return;
        if (isActivelyTimedOut(member)) {
            rejectionMessage = TIMEOUT_BLOCKED_MESSAGE;
            return;
        }
        const ownedGame = gameManager.getPlayerGame(game.guildId, userId);
        if (ownedGame && ownedGame !== game) {
            rejectionMessage = PLAYER_BUSY_MESSAGE;
            return;
        }
        if (!gameManager.addPlayer(game, userId)) {
            rejectionMessage = PLAYER_BUSY_MESSAGE;
            return;
        }
        game.pendingJoins += 1;
        joinCommitted = true;
    });
    if (!joinCommitted) {
        await safeDeferredReplyEdit(interaction, rejectionMessage || EXPIRED_MESSAGE, game);
        return false;
    }

    let joined = false;
    let startWhenUnlocked = false;
    const panelResult = await queueRecruitmentPanelEdit(game, 'join-count-panel', async result => {
        await gameManager.runExclusive(game, () => {
            game.pendingJoins = Math.max(0, game.pendingJoins - 1);
            if (!result.updated) {
                gameManager.removePlayer(game, userId);
            } else {
                joined = !game.ended
                    && game.state === 'recruiting'
                    && game.participantIds.includes(userId);
            }
            startWhenUnlocked = game.pendingJoins === 0
                && game.state === 'recruiting'
                && (game.startRequested || game.participantIds.length >= MAX_PARTICIPANTS);
        });
    });
    const panelUpdated = panelResult.updated;

    if (!panelUpdated) {
        await safeDeferredReplyEdit(interaction, JOIN_FAILURE_MESSAGE, game);
    } else if (!joined) {
        await safeDeferredReplyEdit(interaction, EXPIRED_MESSAGE, game);
    } else {
        await safeDeferredReplyEdit(interaction, JOINED_MESSAGE, game);
    }

    if (startWhenUnlocked) {
        await finishRecruitment(game);
    }
    return joined;
}

async function handleRouletteMemberInvalidated(game, userId, reason) {
    if (!game || game.type !== 'roulette') return false;
    let removed = false;
    let refreshRecruitmentPanel = false;
    let currentWinnerInvalidated = false;

    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state === 'ended') return;
        removed = gameManager.removePlayer(game, userId);
        if (!removed) return;
        refreshRecruitmentPanel = game.state === 'recruiting';

        // If the current decision-maker becomes invalid, end the game safely
        if (game.state === 'playing' && game.currentWinnerId === userId && game.decisionToken) {
            clearDecisionState(game);
            game.endReason = 'winner_invalid';
            game.state = 'ended';
            currentWinnerInvalidated = true;
        }
    });

    if (refreshRecruitmentPanel) {
        await queueRecruitmentPanelEdit(game, `member-invalidated-${reason || 'unknown'}`);
    }

    if (currentWinnerInvalidated) {
        await settleAndFinish(game);
    }

    return removed;
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
    startRoulette,
    handleRouletteInteraction,
    handleRouletteMemberInvalidated,
    // For testing
    penaltyMinutes,
    MIN_PARTICIPANTS,
    MAX_PARTICIPANTS,
    MAX_ROUNDS,
    RECRUITMENT_DURATION_MS,
    DECISION_DURATION_MS,
    ROUND_PENALTY_MINUTES,
    FIRST_WINNER_REPEAT_MINUTES,
    ALL_WINNERS_TIMEOUT_MINUTES,
};
