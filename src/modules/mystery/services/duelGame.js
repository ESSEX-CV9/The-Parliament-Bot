const { randomUUID } = require('node:crypto');
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
} = require('discord.js');
const gameManager = require('./mysteryGameManager');

const INVITATION_DURATION_MS = 60_000;
const ROUND_DURATION_MS = 30_000;
const MAX_DUEL_ROUNDS = 7;
const DUEL_TIMEOUT_DURATION_MS = 3 * 60_000;
const DUEL_TIMEOUT_REASON = '神秘指令：死斗';

const PLAYER_BUSY_MESSAGE = '🚫 **一心不能二用。**\n你现在已经在一场神秘游戏里，先把那边活着玩完再说。';
const CHANNEL_BUSY_MESSAGE = '🎮 **这里已经有一场游戏在进行了。**\n等当前游戏结束后再开新的吧。';
const INVALID_OPPONENT_MESSAGE = '⚔️ **这个对手现在无法参加死斗。**\n换个人再试试吧。';
const GENERIC_FAILURE_MESSAGE = '❌ 处理神秘指令时出现错误，请稍后重试。';
const WRONG_INVITEE_MESSAGE = '🚫 **这不是发给你的邀请。**';
const TIMEOUT_BLOCKED_MESSAGE = '⚔️ **你现在无法参加死斗。**\n你当前还在禁言，暂时无法参加。';
const INVALID_INITIATOR_MESSAGE = '⚔️ **你现在无法参加死斗。**';
const EXPIRED_MESSAGE = '⌛ **这场死斗已经结束或失效了。**';
const SELF_ACCEPT_MESSAGE = '⚔️ **不能接受自己发起的死斗。**';
const DUPLICATE_CHOICE_MESSAGE = '✋ **本轮已经出过拳了。**\n选择不能修改。';
const INVALID_CHOICE_MESSAGE = '⚠️ **这个出拳无效。**';
const CHOICE_RECORDED_MESSAGE = '✅ **出拳已记录。**\n等待对手完成选择。';
const BOTH_TIMEOUT_DESCRIPTION = '💤 **两个人都没出拳。**\n\n看来这场死斗的杀气也就到这里了。\n\n**本场死斗自动取消。**';
const INVALIDATED_DESCRIPTION = '⚔️ **死斗中止。**\n\n由于其中一名玩家已无法继续参与，本场死斗自动取消。';
const ROUND_LIMIT_DESCRIPTION = [
    '⌛ **死斗已失效**',
    '',
    '双方鏖战 **7 轮**，仍然没有分出胜负。',
    '',
    '本场死斗到此为止，双方均不受处罚。',
].join('\n');
const SHIELD_LINE = '🛡️ **但禁言被神秘力量阻挡，未能生效。**';

const CHOICES = {
    rock: { label: '✊ 石头', display: '✊ 石头', style: ButtonStyle.Secondary },
    scissors: { label: '✌️ 剪刀', display: '✌️ 剪刀', style: ButtonStyle.Secondary },
    paper: { label: '✋ 布', display: '✋ 布', style: ButtonStyle.Secondary },
};

function logDiscordFailure(game, action, error, userId = 'system') {
    console.error(
        `[MysteryDuel] Discord API 失败 (guild=${game?.guildId || 'unknown'}, game=${game?.id || 'unknown'}, user=${userId}, action=${action}):`,
        error
    );
}

function makeEmbed(description) {
    return new EmbedBuilder().setDescription(description);
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
        logDiscordFailure(game, 'fetch-member', error, userId);
        return null;
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
        logDiscordFailure(game, 'defer-component-reply', error, interaction.user?.id);
        return false;
    }
}

async function sendPrivate(interaction, payload, game) {
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
        logDiscordFailure(game, 'private-reply', error, interaction.user?.id);
        return false;
    }
}

async function safeEphemeralReply(interaction, content, game) {
    return sendPrivate(interaction, { content }, game);
}

async function deferPublicStart(interaction, game) {
    if (interaction.deferred || interaction.replied || typeof interaction.deferReply !== 'function') {
        return false;
    }
    try {
        await interaction.deferReply();
        return true;
    } catch (error) {
        logDiscordFailure(game, 'defer-start-reply', error, interaction.user?.id);
        return false;
    }
}

async function rejectDeferredStart(interaction, content, game) {
    try {
        await interaction.deleteReply?.();
    } catch (error) {
        logDiscordFailure(game, 'delete-start-reply', error, interaction.user?.id);
    }
    try {
        if (typeof interaction.followUp !== 'function') return false;
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
        return true;
    } catch (error) {
        logDiscordFailure(game, 'reject-start-reply', error, interaction.user?.id);
        return false;
    }
}

async function safeEdit(message, payload, game, action) {
    if (typeof message?.edit !== 'function') return false;
    try {
        await message.edit(payload);
        return true;
    } catch (error) {
        logDiscordFailure(game, action, error);
        return false;
    }
}

async function safeSend(game, payload, action) {
    try {
        return await game.channel?.send(payload) || null;
    } catch (error) {
        logDiscordFailure(game, action, error);
        return null;
    }
}

function queuePublicWrite(game, operation) {
    const previous = game.publicWriteQueue || Promise.resolve();
    const queued = previous
        .catch(error => logDiscordFailure(game, 'public-write-queue', error))
        .then(operation)
        .catch(error => {
            logDiscordFailure(game, 'public-write-queue', error);
            return null;
        });
    game.publicWriteQueue = queued;
    return queued;
}

function acceptRow(gameId, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`mystery_duel_accept:${gameId}`)
            .setLabel('⚔️ 接受死斗')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled)
    );
}

function choiceRow(gameId, roundId) {
    return new ActionRowBuilder().addComponents(
        ...Object.entries(CHOICES).map(([choice, details]) => (
            new ButtonBuilder()
                .setCustomId(`mystery_duel_choice:${gameId}:${roundId}:${choice}`)
                .setLabel(details.label)
                .setStyle(details.style)
        ))
    );
}

function invitationDescription(initiatorId, requestedOpponentId) {
    if (requestedOpponentId) {
        return [
            '⚔️ **死斗邀请已发出**',
            '',
            `<@${initiatorId}> 向 <@${requestedOpponentId}> 发起了一场死斗。`,
            '',
            '**游戏规则**',
            '- 双人游戏',
            '- 石头剪刀布',
            '- 三局两胜',
            '- 最多进行 **7 轮**；仍未分出胜负则自动失效',
            '- 输家将被 **禁言 3 分钟**',
            '',
            `<@${requestedOpponentId}>，敢接吗？`,
        ].join('\n');
    }
    return [
        '⚔️ **有人发起了一场死斗**',
        '',
        `<@${initiatorId}> 正在寻找一名对手。`,
        '',
        '**游戏规则**',
        '- 双人游戏',
        '- 石头剪刀布',
        '- 三局两胜',
        '- 最多进行 **7 轮**；仍未分出胜负则自动失效',
        '- 输家将被 **禁言 3 分钟**',
        '',
        '谁敢来？',
    ].join('\n');
}

function invitationPayload(game, disabled = false, description) {
    return {
        embeds: [makeEmbed(description || invitationDescription(game.initiatorId, game.requestedOpponentId))],
        components: [acceptRow(game.id, disabled)],
    };
}

function roundLabel(number) {
    const labels = ['第一轮', '第二轮', '第三轮', '第四轮', '第五轮', '第六轮', '第七轮'];
    return labels[number - 1] || `第 ${number} 轮`;
}

function choicePayload(game, round) {
    return {
        content: `⚔️ **${roundLabel(round.number)}：请选择出拳**\n选择以后不能修改，你有 **30 秒**。`,
        components: [choiceRow(game.id, round.id)],
    };
}

function scoreLines(game, scores) {
    return [
        '**当前比分**',
        `<@${game.initiatorId}> **${scores[game.initiatorId]} : ${scores[game.opponentId]}** <@${game.opponentId}>`,
    ];
}

function normalRoundDescription(game, snapshot) {
    const a = game.initiatorId;
    const b = game.opponentId;
    if (snapshot.outcome === 'tie') {
        return [
            '⚔️ **本轮平局**',
            '',
            `<@${a}>：${CHOICES[snapshot.choices[a]].display}`,
            `<@${b}>：${CHOICES[snapshot.choices[b]].display}`,
            '',
            '双方不得分。',
            '',
            ...scoreLines(game, snapshot.scores),
        ].join('\n');
    }
    if (snapshot.outcome === 'timeout') {
        return [
            `⚔️ **${roundLabel(snapshot.number)}结果**`,
            '',
            `<@${snapshot.winnerId}> 已出拳`,
            `<@${snapshot.loserId}> 超时未出拳`,
            '',
            `**<@${snapshot.winnerId}> 获胜！**`,
            '',
            ...scoreLines(game, snapshot.scores),
        ].join('\n');
    }
    return [
        `⚔️ **${roundLabel(snapshot.number)}结果**`,
        '',
        `<@${a}>：${CHOICES[snapshot.choices[a]].display}`,
        `<@${b}>：${CHOICES[snapshot.choices[b]].display}`,
        '',
        `**<@${snapshot.winnerId}> 获胜！**`,
        '',
        ...scoreLines(game, snapshot.scores),
    ].join('\n');
}

function finalDescription(game, snapshot, timeoutFailed) {
    const winnerScore = snapshot.scores[snapshot.winnerId];
    const loserScore = snapshot.scores[snapshot.loserId];
    const lines = [
        '🏆 **死斗结束**',
        '',
        `**胜者：<@${snapshot.winnerId}>**`,
        `**败者：<@${snapshot.loserId}>**`,
        '',
        `最终比分：**${winnerScore} : ${loserScore}**`,
        '',
        `<@${snapshot.loserId}> 将接受 **禁言 3 分钟**。`,
    ];
    if (timeoutFailed) lines.push('', SHIELD_LINE);
    return lines.join('\n');
}

function resolveChoices(a, b) {
    if (a === b) return 0;
    if (
        (a === 'rock' && b === 'scissors')
        || (a === 'scissors' && b === 'paper')
        || (a === 'paper' && b === 'rock')
    ) return 1;
    return -1;
}

function clearTimer(game, timer) {
    if (!timer) return;
    clearTimeout(timer);
    game.timers?.delete(timer);
}

async function disableInvitation(game) {
    if (game.componentsDisabled) return true;
    const disabled = await safeEdit(
        game.inviteMessage,
        { components: [acceptRow(game.id, true)] },
        game,
        'disable-invitation'
    );
    if (disabled) game.componentsDisabled = true;
    return disabled;
}

async function disableInvitationWithRetry(game) {
    if (await disableInvitation(game)) return true;
    return disableInvitation(game);
}

async function cleanupDuelGame(game) {
    if (!game || game.cleanupStarted) return game?.cleanupPromise;
    game.cleanupStarted = true;
    game.cleanupPromise = (async () => {
        await disableInvitation(game);
        await gameManager.cleanupGame(game);
    })().catch(error => {
        logDiscordFailure(game, 'cleanup', error);
    });
    return game.cleanupPromise;
}

function createRound(game) {
    game.roundNumber = (game.roundNumber || 0) + 1;
    return {
        id: randomUUID().replaceAll('-', '').slice(0, 12),
        number: game.roundNumber,
        choices: new Map(),
        resolved: false,
        timer: null,
    };
}

async function deliverRoundPanels(game, round) {
    if (game.ended || game.state !== 'round' || game.round !== round) return null;
    const payload = choicePayload(game, round);
    const [initiatorSent, opponentSent] = await Promise.all([
        sendPrivate(game.originInteraction, payload, game),
        sendPrivate(game.opponentInteraction, payload, game),
    ]);
    if (!initiatorSent || !opponentSent) {
        await cleanupDuelGame(game);
        return false;
    }

    let armed = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'round' || game.round !== round || round.resolved) return;
        round.timer = setTimeout(() => {
            return handleRoundTimeout(game, round.id).catch(error => {
                logDiscordFailure(game, 'round-timer', error);
                return cleanupDuelGame(game);
            });
        }, ROUND_DURATION_MS);
        round.timer.unref?.();
        game.timers.add(round.timer);
        armed = true;
    });
    return armed ? true : null;
}

function claimRoundResolution(game, round, mode) {
    if (game.ended || game.state !== 'round' || game.round !== round || round.resolved) return null;
    const playerIds = [game.initiatorId, game.opponentId];
    const choiceIds = playerIds.filter(userId => round.choices.has(userId));
    if (mode === 'choices' && choiceIds.length !== 2) return null;

    round.resolved = true;
    clearTimer(game, round.timer);
    round.timer = null;

    if (choiceIds.length === 0) {
        game.state = 'ended';
        return { outcome: 'cancel', roundId: round.id, number: round.number };
    }

    let winnerId;
    let loserId;
    let outcome;
    if (choiceIds.length === 1) {
        winnerId = choiceIds[0];
        loserId = playerIds.find(userId => userId !== winnerId);
        outcome = 'timeout';
    } else {
        const result = resolveChoices(
            round.choices.get(game.initiatorId),
            round.choices.get(game.opponentId)
        );
        if (result === 0) {
            outcome = 'tie';
        } else {
            winnerId = result === 1 ? game.initiatorId : game.opponentId;
            loserId = result === 1 ? game.opponentId : game.initiatorId;
            outcome = 'choice';
        }
    }

    if (winnerId) game.scores[winnerId] += 1;
    const final = Boolean(winnerId && game.scores[winnerId] >= 2);
    let effectToken = null;
    if (final) {
        effectToken = randomUUID().replaceAll('-', '').slice(0, 16);
        game.pendingFinal = { roundId: round.id, effectToken };
    }
    return {
        outcome,
        final,
        roundId: round.id,
        number: round.number,
        winnerId,
        loserId,
        choices: Object.fromEntries(round.choices),
        scores: { ...game.scores },
        effectToken,
    };
}

async function applyLoserTimeout(game, snapshot, loser) {
    if (!loser?.moderatable || typeof loser.timeout !== 'function') return false;
    try {
        await loser.timeout(DUEL_TIMEOUT_DURATION_MS, DUEL_TIMEOUT_REASON);
        return true;
    } catch (error) {
        logDiscordFailure(game, 'timeout-loser', error, snapshot.loserId);
        return false;
    }
}

async function appendTimeoutFailure(game, snapshot, finalMessage) {
    const payload = { embeds: [makeEmbed(finalDescription(game, snapshot, true))] };
    if (await safeEdit(finalMessage, payload, game, 'append-timeout-shield')) return true;
    return Boolean(await queuePublicWrite(game, () => safeSend(
        game,
        { embeds: [makeEmbed(SHIELD_LINE)] },
        'supplement-timeout-shield'
    )));
}

async function publishRoundResolution(game, snapshot) {
    if (!snapshot) return false;
    if (snapshot.outcome === 'cancel') {
        await queuePublicWrite(game, () => safeSend(
            game,
            { embeds: [makeEmbed(BOTH_TIMEOUT_DESCRIPTION)] },
            'both-timeout-cancel'
        ));
        await cleanupDuelGame(game);
        return true;
    }

    const roundMessage = await queuePublicWrite(game, () => {
        if (
            game.ended
            || game.round?.id !== snapshot.roundId
            || game.state !== 'round'
        ) return false;
        return safeSend(
            game,
            { embeds: [makeEmbed(normalRoundDescription(game, snapshot))] },
            'round-result'
        );
    });
    if (roundMessage === false) return false;
    if (!roundMessage) {
        await cleanupDuelGame(game);
        return false;
    }

    if (snapshot.final) {
        const finalMembers = new Map();
        const fetchedMembers = await Promise.all([
            safeFetchMember(game, game.initiatorId),
            safeFetchMember(game, game.opponentId),
        ]);
        finalMembers.set(game.initiatorId, fetchedMembers[0]);
        finalMembers.set(game.opponentId, fetchedMembers[1]);

        let finalDecision = null;
        await gameManager.runExclusive(game, () => {
            if (
                game.ended
                || game.state !== 'round'
                || game.round?.id !== snapshot.roundId
                || game.pendingFinal?.roundId !== snapshot.roundId
                || game.pendingFinal?.effectToken !== snapshot.effectToken
                || game.finalEffect
            ) return;

            const participantsCurrent = game.participantIds.every(userId => (
                isCurrentGuildMember(game, finalMembers.get(userId), userId)
            ));
            if (!participantsCurrent) {
                game.state = 'ended';
                game.pendingFinal = null;
                game.finalEffect = { token: snapshot.effectToken, phase: 'cancelled' };
                finalDecision = 'cancel';
                return;
            }

            game.finalEffect = { token: snapshot.effectToken, phase: 'publishing-result' };
            finalDecision = 'publish';
        });
        if (!finalDecision) return false;
        if (finalDecision === 'cancel') {
            await queuePublicWrite(game, () => safeSend(
                game,
                { embeds: [makeEmbed(INVALIDATED_DESCRIPTION)] },
                'final-member-invalidated-cancel'
            ));
            await cleanupDuelGame(game);
            return false;
        }

        const finalMessage = await queuePublicWrite(game, () => {
            if (
                game.ended
                || game.state !== 'round'
                || game.round?.id !== snapshot.roundId
                || game.pendingFinal?.roundId !== snapshot.roundId
                || game.pendingFinal?.effectToken !== snapshot.effectToken
                || game.finalEffect?.token !== snapshot.effectToken
                || game.finalEffect.phase !== 'publishing-result'
            ) return false;
            return safeSend(
                game,
                { embeds: [makeEmbed(finalDescription(game, snapshot, false))] },
                'final-result'
            );
        });
        if (finalMessage === false) return false;
        if (!finalMessage) {
            await gameManager.runExclusive(game, () => {
                if (
                    game.ended
                    || game.state !== 'round'
                    || game.pendingFinal?.effectToken !== snapshot.effectToken
                    || game.finalEffect?.token !== snapshot.effectToken
                    || game.finalEffect.phase !== 'publishing-result'
                ) return;
                game.state = 'ended';
                game.pendingFinal = null;
                game.finalEffect.phase = 'publish-failed';
            });
            await cleanupDuelGame(game);
            return false;
        }

        let applyTimeout = false;
        await gameManager.runExclusive(game, () => {
            if (
                game.ended
                || game.state !== 'round'
                || game.round?.id !== snapshot.roundId
                || game.pendingFinal?.roundId !== snapshot.roundId
                || game.pendingFinal?.effectToken !== snapshot.effectToken
                || game.finalEffect?.token !== snapshot.effectToken
                || game.finalEffect.phase !== 'publishing-result'
            ) return;
            game.state = 'ended';
            game.pendingFinal = null;
            game.finalEffect.phase = 'applying-timeout';
            applyTimeout = true;
        });
        if (!applyTimeout) {
            await cleanupDuelGame(game);
            return false;
        }

        const timeoutApplied = await applyLoserTimeout(
            game,
            snapshot,
            finalMembers.get(snapshot.loserId)
        );
        if (game.finalEffect?.token === snapshot.effectToken) {
            game.finalEffect.phase = timeoutApplied ? 'complete' : 'supplementing-result';
        }
        if (!timeoutApplied) await appendTimeoutFailure(game, snapshot, finalMessage);
        if (game.finalEffect?.token === snapshot.effectToken) game.finalEffect.phase = 'complete';
        await cleanupDuelGame(game);
        return true;
    }

    if (snapshot.number >= MAX_DUEL_ROUNDS) {
        let ownsRoundLimit = false;
        await gameManager.runExclusive(game, () => {
            if (
                game.ended
                || game.state !== 'round'
                || game.round?.id !== snapshot.roundId
            ) return;
            game.state = 'ended';
            ownsRoundLimit = true;
        });
        if (!ownsRoundLimit) return false;

        const expiryMessage = await queuePublicWrite(game, () => safeSend(
            game,
            { embeds: [makeEmbed(ROUND_LIMIT_DESCRIPTION)] },
            'round-limit-expired'
        ));
        await cleanupDuelGame(game);
        return Boolean(expiryMessage);
    }

    let nextRound = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'round' || game.round?.id !== snapshot.roundId) return;
        nextRound = createRound(game);
        game.round = nextRound;
    });
    if (!nextRound) return false;
    const delivered = await deliverRoundPanels(game, nextRound);
    return delivered !== false;
}

async function handleRoundTimeout(game, roundId) {
    let snapshot = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'round' || game.round?.id !== roundId) return;
        snapshot = claimRoundResolution(game, game.round, 'timeout');
    });
    return publishRoundResolution(game, snapshot);
}

async function expireInvitation(game) {
    let expired = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'inviting') return;
        game.state = 'ended';
        clearTimer(game, game.invitationTimer);
        game.invitationTimer = null;
        expired = true;
    });
    if (!expired) return false;
    const description = '⌛ **死斗邀请已过期。**\n\n1 分钟内无人接受，本场死斗自动取消。';
    const edited = await safeEdit(
        game.inviteMessage,
        invitationPayload(game, true, description),
        game,
        'invitation-timeout'
    );
    if (edited) game.componentsDisabled = true;
    await cleanupDuelGame(game);
    return true;
}

async function startDuel(interaction, requestedOpponent) {
    const userId = interaction.user?.id;
    const guildId = interaction.guildId || interaction.guild?.id;
    const channelId = interaction.channelId;
    const provisionalGame = {
        id: randomUUID(),
        type: 'duel',
        guildId,
        channelId,
        guild: interaction.guild,
        channel: interaction.channel,
        initiatorId: userId,
        participantIds: [userId],
        requestedOpponentId: requestedOpponent?.id || requestedOpponent?.user?.id || null,
        state: 'inviting',
        timers: new Set(),
        publicWriteQueue: Promise.resolve(),
        originInteraction: interaction,
    };

    if (!await deferPublicStart(interaction, provisionalGame)) return false;

    const initiator = await safeFetchMember(provisionalGame, userId);
    if (!isCurrentGuildMember(provisionalGame, initiator, userId)) {
        await rejectDeferredStart(
            interaction,
            isActivelyTimedOut(initiator) ? TIMEOUT_BLOCKED_MESSAGE : INVALID_INITIATOR_MESSAGE,
            provisionalGame
        );
        return false;
    }

    let opponent = null;
    if (provisionalGame.requestedOpponentId) {
        if (
            provisionalGame.requestedOpponentId === userId
            || gameManager.getPlayerGame(guildId, provisionalGame.requestedOpponentId)
        ) {
            await rejectDeferredStart(interaction, INVALID_OPPONENT_MESSAGE, provisionalGame);
            return false;
        }
        opponent = await safeFetchMember(provisionalGame, provisionalGame.requestedOpponentId);
        if (!isCurrentGuildMember(
            provisionalGame,
            opponent,
            provisionalGame.requestedOpponentId
        )) {
            await rejectDeferredStart(interaction, INVALID_OPPONENT_MESSAGE, provisionalGame);
            return false;
        }
    }

    let game;
    provisionalGame.onMemberInvalidated = async invalidMember => {
        const invalidUserId = invalidMember?.id || invalidMember?.user?.id;
        if (invalidUserId) {
            await handleDuelMemberInvalidated(game, invalidUserId, 'member-invalidated');
        }
    };
    provisionalGame.disableComponents = () => {
        if (!game?.componentsDisabled) void disableInvitation(game);
    };

    let finalPreflightRejection = null;
    if (!isCurrentGuildMember(provisionalGame, initiator, userId)) {
        finalPreflightRejection = isActivelyTimedOut(initiator)
            ? TIMEOUT_BLOCKED_MESSAGE
            : INVALID_INITIATOR_MESSAGE;
    } else if (
        provisionalGame.requestedOpponentId
        && (
            !isCurrentGuildMember(
                provisionalGame,
                opponent,
                provisionalGame.requestedOpponentId
            )
            || gameManager.getPlayerGame(guildId, provisionalGame.requestedOpponentId)
        )
    ) {
        finalPreflightRejection = INVALID_OPPONENT_MESSAGE;
    }
    if (finalPreflightRejection) {
        await rejectDeferredStart(interaction, finalPreflightRejection, provisionalGame);
        return false;
    }

    const created = gameManager.createGame(provisionalGame);
    if (!created.ok) {
        await rejectDeferredStart(
            interaction,
            created.reason === 'player' ? PLAYER_BUSY_MESSAGE : CHANNEL_BUSY_MESSAGE,
            provisionalGame
        );
        return false;
    }
    game = created.game;

    try {
        const replyResult = await interaction.editReply(invitationPayload(game));
        const responseMessage = replyResult?.resource?.message || replyResult;
        if (typeof responseMessage?.edit === 'function') game.inviteMessage = responseMessage;
    } catch (error) {
        logDiscordFailure(game, 'invitation-panel', error, userId);
        await cleanupDuelGame(game);
        await rejectDeferredStart(interaction, GENERIC_FAILURE_MESSAGE, game);
        return false;
    }
    if (!game.inviteMessage) {
        try {
            const fetched = await interaction.fetchReply?.();
            if (typeof fetched?.edit === 'function') game.inviteMessage = fetched;
        } catch (error) {
            logDiscordFailure(game, 'fetch-invitation-panel', error, userId);
        }
    }
    if (!game.inviteMessage && typeof interaction.editReply === 'function') {
        game.inviteMessage = { edit: payload => interaction.editReply(payload) };
    }
    if (!game.inviteMessage) {
        await cleanupDuelGame(game);
        await rejectDeferredStart(interaction, GENERIC_FAILURE_MESSAGE, game);
        return false;
    }

    game.invitationTimer = setTimeout(() => {
        return expireInvitation(game).catch(error => {
            logDiscordFailure(game, 'invitation-timer', error);
            return cleanupDuelGame(game);
        });
    }, INVITATION_DURATION_MS);
    game.invitationTimer.unref?.();
    game.timers.add(game.invitationTimer);
    return true;
}

function parseParts(parts) {
    const input = (Array.isArray(parts) ? parts : [parts]).filter(part => typeof part === 'string');
    const tokens = input.flatMap(part => part.split(':')).filter(Boolean);
    if (tokens[0]?.startsWith('mystery_duel_')) {
        tokens[0] = tokens[0].slice('mystery_duel_'.length);
    }
    while (tokens[0] === 'mystery' || tokens[0] === 'duel') tokens.shift();
    return {
        action: tokens[0],
        gameId: tokens[1],
        roundId: tokens[2],
        choice: tokens[3],
    };
}

async function handleAccept(interaction, game) {
    const userId = interaction.user?.id;
    let rejection = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'inviting') rejection = EXPIRED_MESSAGE;
        else if (userId === game.initiatorId) rejection = SELF_ACCEPT_MESSAGE;
        else if (game.requestedOpponentId && userId !== game.requestedOpponentId) {
            rejection = WRONG_INVITEE_MESSAGE;
        }
    });
    if (rejection) {
        await safeEphemeralReply(interaction, rejection, game);
        return false;
    }

    const member = await safeFetchMember(game, userId);
    let accepted = false;
    let round = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'inviting') {
            rejection = EXPIRED_MESSAGE;
            return;
        }
        if (userId === game.initiatorId) {
            rejection = SELF_ACCEPT_MESSAGE;
            return;
        }
        if (game.requestedOpponentId && userId !== game.requestedOpponentId) {
            rejection = WRONG_INVITEE_MESSAGE;
            return;
        }
        const owner = gameManager.getPlayerGame(game.guildId, userId);
        if (owner && owner !== game) {
            rejection = PLAYER_BUSY_MESSAGE;
            return;
        }
        if (!isCurrentGuildMember(game, member, userId)) {
            rejection = isActivelyTimedOut(member) ? TIMEOUT_BLOCKED_MESSAGE : INVALID_OPPONENT_MESSAGE;
            return;
        }
        if (!gameManager.addPlayer(game, userId)) {
            rejection = PLAYER_BUSY_MESSAGE;
            return;
        }

        clearTimer(game, game.invitationTimer);
        game.invitationTimer = null;
        game.opponentId = userId;
        game.opponentInteraction = interaction;
        game.scores = { [game.initiatorId]: 0, [userId]: 0 };
        game.state = 'round';
        round = createRound(game);
        game.round = round;
        accepted = true;
    });

    if (!accepted) {
        await safeEphemeralReply(interaction, rejection || EXPIRED_MESSAGE, game);
        return false;
    }

    const invitationDisabled = await disableInvitationWithRetry(game);
    if (!invitationDisabled) {
        await gameManager.runExclusive(game, () => {
            if (!game.ended && game.state === 'round' && game.round === round) {
                game.state = 'ended';
            }
        });
        await cleanupDuelGame(game);
        await safeEphemeralReply(interaction, EXPIRED_MESSAGE, game);
        return false;
    }
    const delivered = await deliverRoundPanels(game, round);
    return delivered === true;
}

async function handleChoice(interaction, game, roundId, choice) {
    const userId = interaction.user?.id;
    let rejection = null;
    let accepted = false;
    let snapshot = null;
    await gameManager.runExclusive(game, () => {
        if (
            game.ended
            || game.state !== 'round'
            || game.round?.id !== roundId
            || !game.participantIds.includes(userId)
        ) {
            rejection = EXPIRED_MESSAGE;
            return;
        }
        if (!Object.hasOwn(CHOICES, choice)) {
            rejection = INVALID_CHOICE_MESSAGE;
            return;
        }
        if (game.round.choices.has(userId)) {
            rejection = DUPLICATE_CHOICE_MESSAGE;
            return;
        }
        game.round.choices.set(userId, choice);
        accepted = true;
        if (game.round.choices.size === 2) {
            snapshot = claimRoundResolution(game, game.round, 'choices');
        }
    });

    if (!accepted) {
        await safeEphemeralReply(interaction, rejection || EXPIRED_MESSAGE, game);
        return false;
    }

    // The choice is authoritative once committed. A failed private acknowledgement
    // must never roll it back, reopen the round, or prevent an owned settlement.
    await safeEphemeralReply(interaction, CHOICE_RECORDED_MESSAGE, game);
    if (snapshot) await publishRoundResolution(game, snapshot);
    return true;
}

async function handleDuelInteraction(interaction, parts) {
    const parsed = parseParts(parts);
    const game = parsed.gameId && gameManager.getGame(parsed.gameId);
    if (!await deferEphemeralComponent(interaction, game)) return false;
    if (!game || game.type !== 'duel') {
        await safeEphemeralReply(interaction, EXPIRED_MESSAGE, game);
        return false;
    }
    if (parsed.action === 'accept') return handleAccept(interaction, game);
    if (parsed.action === 'choice') {
        return handleChoice(interaction, game, parsed.roundId, parsed.choice);
    }
    await safeEphemeralReply(interaction, EXPIRED_MESSAGE, game);
    return false;
}

async function handleDuelMemberInvalidated(game, userId, reason) {
    if (!game || game.type !== 'duel') return false;
    let cancelled = false;
    await gameManager.runExclusive(game, () => {
        if (
            game.ended
            || game.state === 'ended'
            || !game.participantIds.includes(userId)
        ) return;
        game.state = 'ended';
        clearTimer(game, game.invitationTimer);
        game.invitationTimer = null;
        clearTimer(game, game.round?.timer);
        if (game.round) game.round.timer = null;
        game.invalidationReason = reason;
        cancelled = true;
    });
    if (!cancelled) return false;

    await queuePublicWrite(game, async () => {
        if (game.opponentId) {
            return safeSend(
                game,
                { embeds: [makeEmbed(INVALIDATED_DESCRIPTION)] },
                'member-invalidated-cancel'
            );
        }
        const edited = await safeEdit(
            game.inviteMessage,
            invitationPayload(game, true, INVALIDATED_DESCRIPTION),
            game,
            'initiator-invalidated-cancel'
        );
        if (edited) game.componentsDisabled = true;
        return edited;
    });
    await cleanupDuelGame(game);
    return true;
}

module.exports = {
    startDuel,
    handleDuelInteraction,
    resolveChoices,
    handleDuelMemberInvalidated,
};
