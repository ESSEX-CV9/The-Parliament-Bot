const { randomUUID } = require('node:crypto');
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    StringSelectMenuBuilder,
} = require('discord.js');
const gameManager = require('./mysteryGameManager');
const defaultCooldownStore = require('../utils/bombCooldownStore');

const RECRUITMENT_DURATION_MS = 3 * 60 * 1000;
const BOMB_TIMEOUT_DURATION_MS = 5 * 60 * 1000;
const BOMB_TIMEOUT_REASON = '神秘指令：传炸弹';
const MIN_PARTICIPANTS = 3;
const MAX_PARTICIPANTS = 8;
const cooldownLoadPromises = new WeakMap();
const PANEL_SKIPPED = Symbol('panel-skipped');

const PLAYER_BUSY_MESSAGE = '🚫 **一心不能二用。**\n你现在已经在一场神秘游戏里，先把那边活着玩完再说。';
const CHANNEL_BUSY_MESSAGE = '🎮 **这里已经有一场游戏在进行了。**\n等当前游戏结束后再开新的吧。';
const COOLDOWN_MESSAGE = '⏳ **这个神秘指令还在冷却中**， **30分钟后才能再次使用**。';
const TIMEOUT_BLOCKED_MESSAGE = '💣 **炸弹拒绝了你。**\n你当前还在禁言，暂时无法参加。';
const INVALID_MEMBER_MESSAGE = '⚠️ **你现在无法参加这场传炸弹游戏。**';
const EXPIRED_MESSAGE = '⌛ **这场传炸弹游戏已经结束或失效了。**';
const DUPLICATE_MESSAGE = '👀 **你已经在车上了。**\n再点也不会多一条命。';
const FULL_MESSAGE = '💣 **这场传炸弹已经满员了。**';
const JOINED_MESSAGE = '💣 **炸弹已经记住你了。**\n\n你已成功加入本局。\n现在退出已经来不及了。';
const NOT_HOLDER_MESSAGE = '✋ **炸弹又不在你手里。**\n别这么积极。';
const TOO_FAST_MESSAGE = '⏳ **手别这么快。**\n炸弹刚到你手里，等一下再扔。';
const TARGET_INVALID_MESSAGE = '⚠️ **这个人现在接不了炸弹。**\n请重新选择一名参与者。';
const TIMEOUT_FAILURE_LINE = '🛡️ **但禁言被神秘力量阻挡，未能生效。**';

const PASS_COPY_BUILDERS = [
    (from, to) => `💨 **<@${from}> 毫不犹豫地把炸弹塞给了 <@${to}>。**\n看得出来，这段友情不太牢固。`,
    (from, to) => `📦 **<@${from}> 发起了一笔特殊快递。**\n收件人：<@${to}>\n包裹内容：💣`,
    (from, to) => `🤝 **<@${from}> 十分友善地把炸弹交给了 <@${to}>。**\n<@${to}> 应该会很感动。`,
    (from, to) => `🎁 **<@${from}> 给 <@${to}> 准备了一份惊喜。**\n就是这个惊喜一直在滴滴响。`,
    (from, to) => `🏃 **<@${from}> 把炸弹往 <@${to}> 怀里一塞，转身就跑。**\n动作十分熟练。`,
    (from, to) => `💣 **<@${from}>：这个我不要了，你拿着。**\n<@${to}>：？`,
    (from, to) => `🫴 **<@${from}> 将烫手山芋正式移交给 <@${to}>。**\n当然，这个比山芋稍微危险一点。`,
    (from, to) => `🧾 **责任转移成功。**\n当前责任人：**<@${to}>**\n前任责任人：<@${from}>`,
    (from, to) => `🚚 **<@${from}> 的炸弹已成功送达。**\n<@${to}>，记得五星好评。`,
    (from, to) => `🥰 **<@${from}> 想了想，还是觉得好东西应该和 <@${to}> 分享。**\n💣`,
    (from, to) => `🧠 **经过深思熟虑，<@${from}> 决定让 <@${to}> 来处理这个问题。**\n非常合理。`,
    (from, to) => `📞 **<@${from}>：喂？这里有你的快递。**\n<@${to}>：我没买东西啊。\n💣`,
    (from, to) => `🏅 **恭喜 <@${to}> 成为本轮最新炸弹持有者。**\n<@${from}> 已安全下车。`,
    (from, to) => `🫡 **<@${from}> 完成战略撤退。**\n炸弹现已由 <@${to}> 接管。`,
    (from, to) => `👋 **<@${from}> 和炸弹进行了友好告别。**\n然后把它留给了 <@${to}>。`,
];

function logDiscordFailure(game, action, error, userId = 'system') {
    console.error(
        `[MysteryBomb] Discord API 失败 (guild=${game?.guildId || 'unknown'}, game=${game?.id || 'unknown'}, user=${userId}, action=${action}):`,
        error
    );
}

function nowFor(game) {
    return typeof game?.now === 'function' ? game.now() : Date.now();
}

function randomFor(game) {
    return typeof game?.random === 'function' ? game.random() : Math.random();
}

function randomIndex(length, randomValue) {
    return Math.min(length - 1, Math.max(0, Math.floor(randomValue * length)));
}

function randomExplosionDelayMs(random = Math.random) {
    return (30 + randomIndex(91, random())) * 1000;
}

function makeEmbed(description) {
    return new EmbedBuilder().setDescription(description);
}

function recruitmentDescription(game, participantCount = game.participantIds.length) {
    const startsAt = Math.floor(game.recruitmentEndsAt / 1000);
    return [
        '💣 **有人捡到了一颗来历不明的炸弹**',
        '',
        `<@${game.initiatorId}> 不知道从哪里搞来了一颗正在倒计时的炸弹。`,
        '',
        '**游戏规则**',
        '- 本游戏为自愿参加',
        '- 最少 **3 人**，最多 **8 人**',
        '- 满 **8 人**立即开始',
        '- 未满 8 人将在 **3 分钟后**尝试开始',
        '- 开局后炸弹会随机出现在一名玩家手中',
        '- 拿到炸弹的人可以把它传给其他参与者',
        '- 炸弹什么时候爆炸，没人知道',
        '- 爆炸时持有炸弹的人将被 **禁言 5 分钟**',
        '',
        `**当前人数：${participantCount} / 8**`,
        `⏳ **预计开始：<t:${startsAt}:R>**`,
    ].join('\n');
}

function cancellationDescription() {
    return '💣 **炸弹：所以没人陪我玩是吧？**\n\n3 分钟过去了，人数不足，本局自动取消。';
}

function recruitmentClosedDescription(count) {
    return [
        '🔒 **报名已结束**',
        '',
        '本局传炸弹已经开始。',
        '',
        `**最终参与人数：${count} 人**`,
        '',
        '招募已关闭，无法继续加入。',
    ].join('\n');
}

function firstHolderDescription(snapshot) {
    return [
        `💣 **恭喜 <@${snapshot.currentHolderId}> 成为第一位倒霉蛋。**`,
        '',
        '这东西现在归你了。',
        '',
        '**参与者**',
        snapshot.participantIds.map(userId => `<@${userId}>`).join(' · '),
        '',
        `**当前持有者：<@${snapshot.currentHolderId}>**`,
        '**已传递：0 次**',
    ].join('\n');
}

function passDescription(fromId, toId, count, randomValue) {
    const copy = PASS_COPY_BUILDERS[randomIndex(PASS_COPY_BUILDERS.length, randomValue)](fromId, toId);
    return `${copy}\n\n**当前持有者：<@${toId}>**\n**已传递：${count} 次**`;
}

function explosionDescription(game, timeoutFailed) {
    const durationSeconds = Math.max(
        0,
        Math.floor(((game.explosionClaimedAt ?? nowFor(game)) - game.startedAt) / 1000)
    );
    const lines = [
        '💥 **BOOOOOOM！！**',
        '',
        `很遗憾，炸弹最终选择了 <@${game.finalHolderId}>。`,
        '',
        '奖励：**禁言 5 分钟。**',
        '',
        '**本局统计**',
        `- 总传递次数：**${game.passCount} 次**`,
        `- 本局持续时间：**${durationSeconds} 秒**`,
        `- 最终持有者：<@${game.finalHolderId}>`,
    ];
    if (timeoutFailed) lines.push('', TIMEOUT_FAILURE_LINE);
    return lines.join('\n');
}

function cancellationAfterInvalidationDescription() {
    return [
        '🧯 **这局玩不下去了。**',
        '',
        '由于有参与者离开服务器，当前剩余人数已不足 **3 人**。',
        '',
        '**本局游戏自动取消。**',
        '',
        '炸弹今天算是捡回一条命。',
    ].join('\n');
}

function reassignmentDescription(userId, holderId, reason) {
    if (reason === 'timeout' || reason === 'member-timeout') {
        return [
            `🔇 **<@${userId}> 突然失去了说话的资格。**`,
            '',
            '他已从本局游戏中移除。',
            '',
            `💣 炸弹随机落到了 **<@${holderId}>** 手里。`,
        ].join('\n');
    }
    return [
        `🚪 **<@${userId}> 带着跑路的想法离开了服务器。**`,
        '',
        '可惜炸弹不能就这么消失。',
        '',
        `💣 炸弹随机落到了 **<@${holderId}>** 手里。`,
    ].join('\n');
}

function joinRow(gameId, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`mystery_bomb_join:${gameId}`)
            .setLabel('💣 接过炸弹')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled)
    );
}

function passRow(gameId, messageToken, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`mystery_bomb_pass:${gameId}:${messageToken}`)
            .setLabel('💣 传炸弹')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled)
    );
}

function recruitmentPayload(game, disabled = false, description = recruitmentDescription(game)) {
    return {
        embeds: [makeEmbed(description)],
        components: [joinRow(game.id, disabled)],
    };
}

function bombPayload(gameId, messageToken, description, disabled = false) {
    return {
        embeds: [makeEmbed(description)],
        components: [passRow(gameId, messageToken, disabled)],
    };
}

function isActivelyTimedOut(member, now = Date.now()) {
    return Number(member?.communicationDisabledUntilTimestamp) > now;
}

function isValidHumanMember(member, now = Date.now()) {
    return Boolean(member?.id && member.user && !member.user.bot && !isActivelyTimedOut(member, now));
}

async function safeFetchMember(game, userId) {
    try {
        const member = await game.guild?.members?.fetch(userId);
        game.memberById?.set(userId, member);
        return member;
    } catch (error) {
        logDiscordFailure(game, 'fetch-member', error, userId);
        return null;
    }
}

async function ensureCooldownStoreLoaded(store, game, userId) {
    if (!store || typeof store.load !== 'function') return true;
    let loadPromise = cooldownLoadPromises.get(store);
    if (!loadPromise) {
        loadPromise = Promise.resolve().then(() => store.load());
        cooldownLoadPromises.set(store, loadPromise);
    }
    try {
        await loadPromise;
        return true;
    } catch (error) {
        logDiscordFailure(game, 'cooldown-load', error, userId);
        return false;
    }
}

async function deferPublicCommand(interaction, game) {
    if (interaction.deferred || interaction.replied) return true;
    if (typeof interaction.deferReply !== 'function') return false;
    try {
        await interaction.deferReply();
        return true;
    } catch (error) {
        logDiscordFailure(game, 'defer-command-reply', error, interaction.user?.id);
        return false;
    }
}

async function failDeferredStart(interaction, content, game) {
    try {
        await interaction.deleteReply?.();
    } catch (error) {
        logDiscordFailure(game, 'delete-command-placeholder', error, interaction.user?.id);
    }
    try {
        await interaction.followUp?.({ content, flags: MessageFlags.Ephemeral });
    } catch (error) {
        logDiscordFailure(game, 'command-failure-follow-up', error, interaction.user?.id);
    }
}

async function safeEphemeralReply(interaction, content, game, components) {
    const response = { content };
    if (components) response.components = components;
    try {
        if (interaction.deferred && !interaction.replied && typeof interaction.editReply === 'function') {
            await interaction.editReply(response);
        } else if (interaction.replied) {
            await interaction.followUp?.({ ...response, flags: MessageFlags.Ephemeral });
        } else {
            await interaction.reply?.({ ...response, flags: MessageFlags.Ephemeral });
        }
    } catch (error) {
        logDiscordFailure(game, 'ephemeral-reply', error, interaction.user?.id);
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

function queuePanelWrite(game, operation) {
    const previous = game.panelWriteQueue || Promise.resolve();
    const queued = previous
        .catch(error => logDiscordFailure(game, 'panel-write-queue', error))
        .then(operation)
        .catch(error => {
            logDiscordFailure(game, 'panel-write-queue', error);
            return false;
        });
    game.panelWriteQueue = queued;
    return queued;
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

async function disableBombMessage(game, message, token) {
    if (!message) return false;
    return safeEdit(message, {
        components: [passRow(game.id, token, true)],
    }, game, 'disable-bomb-message');
}

async function disableAllComponents(game) {
    try {
        await game.panelWriteQueue;
        await game.publicWriteQueue;
    } catch (error) {
        logDiscordFailure(game, 'wait-component-writes', error);
    }
    await safeEdit(game.recruitmentMessage, {
        components: [joinRow(game.id, true)],
    }, game, 'disable-recruitment-message');
    const messages = [...(game.bombMessages || [])];
    await Promise.all(messages.map(message => disableBombMessage(
        game,
        message,
        message.bombMessageToken ?? game.messageToken
    )));
}

async function cleanupBombGame(game) {
    if (!game || game.cleanupPromise) return game?.cleanupPromise;
    let operation;
    operation = (async () => {
        await disableAllComponents(game);
        await gameManager.cleanupGame(game);
        game.state = 'ended';
    })().catch(error => {
        logDiscordFailure(game, 'cleanup', error);
    });
    game.cleanupPromise = operation;
    return operation;
}

async function claimExplosion(game, currentTime) {
    let claimed = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'active' || currentTime < game.explodeAt) return;
        game.state = 'exploding';
        game.finalHolderId = game.currentHolderId;
        game.explosionClaimedAt = currentTime;
        claimed = true;
    });
    return claimed;
}

async function finishExplosion(game) {
    if (game.explosionPromise) return game.explosionPromise;
    let operation;
    operation = (async () => {
        await game.publicWriteQueue;
        await disableAllComponents(game);

        const resultMessage = await queuePublicWrite(game, () => safeSend(
            game,
            { embeds: [makeEmbed(explosionDescription(game, false))], components: [] },
            'explosion-result'
        ));
        if (!resultMessage || resultMessage === PANEL_SKIPPED) {
            await cleanupBombGame(game);
            return;
        }

        let timeoutFailed = false;
        const member = await safeFetchMember(game, game.finalHolderId);
        if (!member?.moderatable || typeof member.timeout !== 'function') {
            timeoutFailed = true;
        } else {
            try {
                await member.timeout(BOMB_TIMEOUT_DURATION_MS, BOMB_TIMEOUT_REASON);
            } catch (error) {
                timeoutFailed = true;
                logDiscordFailure(game, 'timeout-final-holder', error, game.finalHolderId);
            }
        }

        if (timeoutFailed) {
            const appended = await queuePublicWrite(game, () => safeEdit(
                resultMessage,
                { embeds: [makeEmbed(explosionDescription(game, true))], components: [] },
                game,
                'append-timeout-failure'
            ));
            if (!appended) {
                await queuePublicWrite(game, () => safeSend(
                    game,
                    { content: TIMEOUT_FAILURE_LINE, components: [] },
                    'timeout-failure-supplement'
                ));
            }
        }
        await cleanupBombGame(game);
    })().catch(async error => {
        logDiscordFailure(game, 'finish-explosion', error);
        await cleanupBombGame(game);
    });
    game.explosionPromise = operation;
    return operation;
}

async function explodeBomb(game, currentTime = nowFor(game)) {
    if (await claimExplosion(game, currentTime)) {
        await finishExplosion(game);
        return true;
    }
    if (game.state === 'exploding') {
        await finishExplosion(game);
    }
    return false;
}

function installExplosionTimer(game) {
    if (game.ended || game.state !== 'active' || game.explosionTimer) return false;
    const delay = Math.max(0, game.explodeAt - nowFor(game));
    game.explosionTimer = setTimeout(() => {
        void explodeBomb(game, nowFor(game))
            .catch(error => logDiscordFailure(game, 'explosion-timer', error));
    }, delay);
    game.timers.add(game.explosionTimer);
    return true;
}

async function abortAfterCriticalPanelFailure(game) {
    let claimed = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state === 'ended' || game.state === 'exploding') return;
        game.state = 'cancelling';
        claimed = true;
    });
    if (claimed) await cleanupBombGame(game);
    return claimed;
}

async function cancelForTooFew(game, recruitment = false) {
    const description = recruitment ? cancellationDescription() : cancellationAfterInvalidationDescription();
    if (recruitment) {
        await queuePanelWrite(game, () => safeEdit(
            game.recruitmentMessage,
            recruitmentPayload(game, true, description),
            game,
            'recruitment-cancelled'
        ));
    } else {
        await queuePublicWrite(game, () => safeSend(
            game,
            { embeds: [makeEmbed(description)], components: [] },
            'active-game-cancelled'
        ));
    }
    await cleanupBombGame(game);
}

async function fetchValidParticipants(game, ids) {
    const valid = [];
    for (const userId of ids) {
        const member = await safeFetchMember(game, userId);
        if (isValidHumanMember(member)) valid.push(userId);
    }
    return valid;
}

async function finishRecruitment(game) {
    let snapshot = [];
    await gameManager.runExclusive(game, () => {
        if (!game.ended && game.state === 'recruiting' && !game.recruitmentClosing) {
            if (game.pendingJoinReservations?.size > 0) {
                game.recruitmentStartRequested = true;
                return;
            }
            game.recruitmentClosing = true;
            snapshot = [...game.participantIds];
        }
    });
    if (snapshot.length === 0) return false;

    const validIds = await fetchValidParticipants(game, snapshot);
    let outcome = null;
    let activationSnapshot = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'recruiting') return;
        for (const userId of [...game.participantIds]) {
            if (!validIds.includes(userId)) gameManager.removePlayer(game, userId);
        }
        if (game.participantIds.length < MIN_PARTICIPANTS) {
            game.state = 'cancelling';
            outcome = 'cancel';
            return;
        }

        const currentTime = nowFor(game);
        game.state = 'active';
        game.startedAt = currentTime;
        game.explodeAt = currentTime + randomExplosionDelayMs(game.random);
        game.currentHolderId = game.participantIds[randomIndex(game.participantIds.length, randomFor(game))];
        game.holderSince = currentTime;
        game.passCount = 0;
        game.messageToken = 1;
        installExplosionTimer(game);
        activationSnapshot = {
            participantIds: [...game.participantIds],
            currentHolderId: game.currentHolderId,
            messageToken: game.messageToken,
        };
        outcome = 'active';
    });

    if (outcome === 'cancel') {
        await cancelForTooFew(game, true);
        return false;
    }
    if (outcome !== 'active') return false;

    const firstPayload = bombPayload(
        game.id,
        activationSnapshot.messageToken,
        firstHolderDescription(activationSnapshot)
    );
    const firstMessagePromise = queuePublicWrite(game, async () => {
        if (
            game.ended
            || game.state !== 'active'
            || game.messageToken !== activationSnapshot.messageToken
            || game.currentHolderId !== activationSnapshot.currentHolderId
        ) return PANEL_SKIPPED;
        const message = await safeSend(game, firstPayload, 'first-holder-message');
        if (message) {
            message.bombMessageToken = activationSnapshot.messageToken;
            game.currentMessage = message;
            game.bombMessages.add(message);
            game.messageByToken.set(activationSnapshot.messageToken, message);
        }
        return message;
    });
    const closePanelPromise = queuePanelWrite(game, () => safeEdit(
        game.recruitmentMessage,
        recruitmentPayload(
            game,
            true,
            recruitmentClosedDescription(activationSnapshot.participantIds.length)
        ),
        game,
        'close-recruitment'
    ));
    const firstMessage = await firstMessagePromise;
    if (firstMessage === null) {
        await abortAfterCriticalPanelFailure(game);
        await closePanelPromise;
        return false;
    }
    await closePanelPromise;
    return firstMessage !== PANEL_SKIPPED;
}

async function startBomb(interaction) {
    const userId = interaction.user?.id;
    const guildId = interaction.guildId || interaction.guild?.id;
    const channelId = interaction.channelId;
    const cooldownStore = interaction.bombCooldownStore || defaultCooldownStore;
    const provisionalGame = {
        id: randomUUID(),
        type: 'bomb',
        guildId,
        channelId,
        guild: interaction.guild,
        channel: interaction.channel,
        initiatorId: userId,
        participantIds: [userId],
        state: 'recruiting',
        random: Math.random,
        now: Date.now,
        timers: new Set(),
        bombMessages: new Set(),
        messageByToken: new Map(),
        memberById: new Map(),
        pendingJoinReservations: new Map(),
        joinReservationVersion: 0,
        recruitmentStartRequested: false,
        panelWriteQueue: Promise.resolve(),
        publicWriteQueue: Promise.resolve(),
    };

    if (!await deferPublicCommand(interaction, provisionalGame)) return false;

    const member = await safeFetchMember(provisionalGame, userId);
    if (!isValidHumanMember(member)) {
        await failDeferredStart(
            interaction,
            isActivelyTimedOut(member) ? TIMEOUT_BLOCKED_MESSAGE : INVALID_MEMBER_MESSAGE,
            provisionalGame
        );
        return false;
    }
    provisionalGame.memberById.set(userId, member);
    if (!await ensureCooldownStoreLoaded(cooldownStore, provisionalGame, userId)) {
        await failDeferredStart(interaction, INVALID_MEMBER_MESSAGE, provisionalGame);
        return false;
    }
    try {
        if (cooldownStore.isOnCooldown(guildId, userId)) {
            await failDeferredStart(interaction, COOLDOWN_MESSAGE, provisionalGame);
            return false;
        }
    } catch (error) {
        logDiscordFailure(provisionalGame, 'cooldown-check', error, userId);
        await failDeferredStart(interaction, INVALID_MEMBER_MESSAGE, provisionalGame);
        return false;
    }

    let game;
    provisionalGame.onMemberInvalidated = async (invalidMember, oldMember) => {
        const invalidUserId = invalidMember?.id || invalidMember?.user?.id;
        if (invalidUserId) {
            await handleBombMemberInvalidated(
                game,
                invalidUserId,
                oldMember ? 'timeout' : 'member-remove'
            );
        }
    };
    provisionalGame.disableComponents = () => {
        void disableAllComponents(game);
    };

    const currentMember = await safeFetchMember(provisionalGame, userId);
    if (!isValidHumanMember(currentMember)) {
        await failDeferredStart(
            interaction,
            isActivelyTimedOut(currentMember) ? TIMEOUT_BLOCKED_MESSAGE : INVALID_MEMBER_MESSAGE,
            provisionalGame
        );
        return false;
    }
    provisionalGame.memberById.set(userId, currentMember);
    const created = gameManager.createGame(provisionalGame);
    if (!created.ok) {
        await failDeferredStart(
            interaction,
            created.reason === 'player' ? PLAYER_BUSY_MESSAGE : CHANNEL_BUSY_MESSAGE,
            provisionalGame
        );
        return false;
    }
    game = created.game;
    game.recruitmentEndsAt = nowFor(game) + RECRUITMENT_DURATION_MS;
    game.recruitmentPayload = recruitmentPayload(game);

    try {
        const replyResult = await interaction.editReply(game.recruitmentPayload);
        game.recruitmentMessage = replyResult?.resource?.message || replyResult;
        if (typeof game.recruitmentMessage?.edit !== 'function' && typeof interaction.editReply === 'function') {
            game.recruitmentMessage = { edit: payload => interaction.editReply(payload) };
        }
    } catch (error) {
        logDiscordFailure(game, 'recruitment-panel', error, userId);
        await cleanupBombGame(game);
        await failDeferredStart(interaction, INVALID_MEMBER_MESSAGE, game);
        return false;
    }
    try {
        await cooldownStore.startCooldown(guildId, userId);
    } catch (error) {
        logDiscordFailure(game, 'cooldown-start', error, userId);
    }
    try {
        const fetched = await interaction.fetchReply?.();
        if (typeof fetched?.edit === 'function') game.recruitmentMessage = fetched;
    } catch (error) {
        logDiscordFailure(game, 'fetch-recruitment-panel', error, userId);
        if (!game.recruitmentMessage) {
            await cleanupBombGame(game);
            return false;
        }
    }

    game.recruitmentTimer = setTimeout(() => {
        void finishRecruitment(game).catch(error => logDiscordFailure(game, 'recruitment-timer', error));
    }, RECRUITMENT_DURATION_MS);
    game.timers.add(game.recruitmentTimer);
    return true;
}

function parseParts(parts) {
    const input = (Array.isArray(parts) ? parts : [parts]).filter(part => typeof part === 'string');
    const tokens = input.flatMap(part => part.split(':')).filter(Boolean);
    if (tokens[0]?.startsWith('mystery_bomb_')) {
        tokens[0] = tokens[0].slice('mystery_bomb_'.length);
    }
    while (tokens[0] === 'mystery' || tokens[0] === 'bomb') tokens.shift();
    return { action: tokens[0], gameId: tokens[1], messageToken: Number(tokens[2]) };
}

async function handleJoin(interaction, game) {
    const userId = interaction.user?.id;
    let rejection = null;
    const inspect = () => {
        if (
            game.ended
            || game.state !== 'recruiting'
            || game.recruitmentClosing
            || interaction.channelId !== game.channelId
            || (interaction.guildId || interaction.guild?.id) !== game.guildId
        ) return EXPIRED_MESSAGE;
        if (
            game.participantIds.includes(userId)
            || game.pendingJoinReservations?.has(userId)
        ) return DUPLICATE_MESSAGE;
        if (game.participantIds.length >= MAX_PARTICIPANTS) return FULL_MESSAGE;
        return null;
    };
    await gameManager.runExclusive(game, () => { rejection = inspect(); });
    if (rejection) {
        await safeEphemeralReply(interaction, rejection, game);
        return false;
    }

    const member = await safeFetchMember(game, userId);
    if (!isValidHumanMember(member)) {
        await safeEphemeralReply(
            interaction,
            isActivelyTimedOut(member) ? TIMEOUT_BLOCKED_MESSAGE : INVALID_MEMBER_MESSAGE,
            game
        );
        return false;
    }

    let reservation = null;
    await gameManager.runExclusive(game, () => {
        rejection = inspect();
        if (rejection) return;
        if (!isValidHumanMember(member)) {
            rejection = isActivelyTimedOut(member) ? TIMEOUT_BLOCKED_MESSAGE : INVALID_MEMBER_MESSAGE;
            return;
        }
        const owner = gameManager.getPlayerGame(game.guildId, userId);
        if (owner && owner !== game) {
            rejection = PLAYER_BUSY_MESSAGE;
            return;
        }
        if (!gameManager.addPlayer(game, userId)) {
            rejection = PLAYER_BUSY_MESSAGE;
            return;
        }
        game.memberById?.set(userId, member);
        game.pendingJoinReservations ||= new Map();
        game.joinReservationVersion = (game.joinReservationVersion || 0) + 1;
        reservation = { userId, token: game.joinReservationVersion };
        game.pendingJoinReservations.set(userId, reservation);
    });
    if (!reservation) {
        await safeEphemeralReply(interaction, rejection || EXPIRED_MESSAGE, game);
        return false;
    }

    let joined = false;
    let rollbackFailed = false;
    let shouldStart = false;
    let finalized = false;
    const finalizeReservation = async panelUpdated => {
        await gameManager.runExclusive(game, () => {
            const current = game.pendingJoinReservations?.get(userId);
            if (current?.token !== reservation.token) return;
            game.pendingJoinReservations.delete(userId);
            joined = Boolean(
                panelUpdated
                && !game.ended
                && game.state === 'recruiting'
                && !game.recruitmentClosing
                && game.participantIds.includes(userId)
            );
            if (!joined && game.participantIds.includes(userId)) {
                gameManager.removePlayer(game, userId);
            }
            if (!joined) game.memberById?.delete(userId);
            rollbackFailed = !joined && (
                gameManager.getPlayerGame(game.guildId, userId) === game
                || (!game.ended && game.participantIds.includes(userId))
            );
            game.recruitmentPayload = recruitmentPayload(game);
            shouldStart = !game.ended
                && game.state === 'recruiting'
                && !game.recruitmentClosing
                && game.pendingJoinReservations.size === 0
                && (game.recruitmentStartRequested || game.participantIds.length === MAX_PARTICIPANTS);
            finalized = true;
        });
    };

    const panelResult = await queuePanelWrite(game, async () => {
        let payload = null;
        await gameManager.runExclusive(game, () => {
            const current = game.pendingJoinReservations?.get(userId);
            if (
                current?.token !== reservation.token
                || game.ended
                || game.state !== 'recruiting'
                || game.recruitmentClosing
                || !game.participantIds.includes(userId)
            ) return;
            const visibleCount = game.participantIds.filter(participantId => (
                participantId === userId
                || !game.pendingJoinReservations.has(participantId)
            )).length;
            payload = recruitmentPayload(
                game,
                false,
                recruitmentDescription(game, visibleCount)
            );
        });
        const panelUpdated = payload
            ? await safeEdit(game.recruitmentMessage, payload, game, 'join-count-panel')
            : false;
        await finalizeReservation(panelUpdated);
        return panelUpdated;
    });
    if (!finalized) await finalizeReservation(false);
    if (rollbackFailed) await abortAfterCriticalPanelFailure(game);

    await safeEphemeralReply(interaction, joined ? JOINED_MESSAGE : EXPIRED_MESSAGE, game);
    if (shouldStart) await finishRecruitment(game);
    return Boolean(panelResult && joined);
}

async function handlePassButton(interaction, game, messageToken) {
    const actorId = interaction.user?.id;
    const currentTime = nowFor(game);
    if (currentTime >= game.explodeAt) {
        await explodeBomb(game, currentTime);
        await safeEphemeralReply(interaction, EXPIRED_MESSAGE, game);
        return false;
    }

    let rejection = null;
    let participantIds = [];
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'active') rejection = EXPIRED_MESSAGE;
        else if (game.messageToken !== messageToken) rejection = EXPIRED_MESSAGE;
        else if (game.currentHolderId !== actorId) rejection = NOT_HOLDER_MESSAGE;
        else if (currentTime - game.holderSince < 1_000) rejection = TOO_FAST_MESSAGE;
        else participantIds = [...game.participantIds];
    });
    if (rejection) {
        await safeEphemeralReply(interaction, rejection, game);
        return false;
    }

    const options = [];
    for (const userId of participantIds) {
        if (userId === actorId) continue;
        const member = await safeFetchMember(game, userId);
        if (!isValidHumanMember(member)) continue;
        const label = member.displayName || member.user.globalName || member.user.username || userId;
        options.push({ label: String(label).slice(0, 100), value: userId });
    }

    await gameManager.runExclusive(game, () => {
        const freshTime = nowFor(game);
        if (game.ended || game.state !== 'active' || freshTime >= game.explodeAt) rejection = EXPIRED_MESSAGE;
        else if (game.messageToken !== messageToken) rejection = EXPIRED_MESSAGE;
        else if (game.currentHolderId !== actorId) rejection = NOT_HOLDER_MESSAGE;
        else if (freshTime - game.holderSince < 1_000) rejection = TOO_FAST_MESSAGE;
    });
    if (rejection) {
        if (nowFor(game) >= game.explodeAt) await explodeBomb(game, nowFor(game));
        await safeEphemeralReply(interaction, rejection, game);
        return false;
    }
    if (options.length === 0) {
        await safeEphemeralReply(interaction, TARGET_INVALID_MESSAGE, game);
        return false;
    }

    const select = new StringSelectMenuBuilder()
        .setCustomId(`mystery_bomb_target:${game.id}:${messageToken}`)
        .setPlaceholder('选择一名参与者')
        .addOptions(options);
    await safeEphemeralReply(
        interaction,
        '💣 **你打算把这个祸害送给谁？**',
        game,
        [new ActionRowBuilder().addComponents(select)]
    );
    return true;
}

async function submitBombTarget(game, input) {
    if (!game || game.type !== 'bomb') return { ok: false, reason: 'expired' };
    const targetMember = await safeFetchMember(game, input.targetId);
    let result = { ok: false, reason: 'expired' };
    let passCommit = null;
    let explosionClaimed = false;

    await gameManager.runExclusive(game, () => {
        const currentTime = input.now ?? nowFor(game);
        if (game.ended || game.state !== 'active') return;
        if (currentTime >= game.explodeAt) {
            game.state = 'exploding';
            game.finalHolderId = game.currentHolderId;
            game.explosionClaimedAt = currentTime;
            explosionClaimed = true;
            result = { ok: false, reason: 'exploded' };
            return;
        }
        if (game.currentHolderId !== input.actorId) {
            result = { ok: false, reason: 'holder' };
            return;
        }
        if (game.messageToken !== input.messageToken) {
            result = { ok: false, reason: 'stale' };
            return;
        }
        if (
            input.targetId === input.actorId
            || !game.participantIds.includes(input.targetId)
            || !isValidHumanMember(targetMember)
        ) {
            result = { ok: false, reason: 'target' };
            return;
        }

        const oldMessage = game.currentMessage;
        const oldToken = game.messageToken;
        const randomValue = randomFor(game);
        game.currentHolderId = input.targetId;
        game.holderSince = currentTime;
        game.passCount += 1;
        game.messageToken += 1;
        passCommit = {
            fromId: input.actorId,
            toId: input.targetId,
            oldMessage,
            oldToken,
            newToken: game.messageToken,
            passCount: game.passCount,
            randomValue,
        };
        result = { ok: true };
    });

    if (explosionClaimed) {
        await finishExplosion(game);
        return result;
    }
    if (!passCommit) return result;

    const deliveredMessage = await queuePublicWrite(game, async () => {
        if (
            game.ended
            || game.state !== 'active'
            || game.messageToken !== passCommit.newToken
            || game.currentHolderId !== passCommit.toId
        ) return PANEL_SKIPPED;
        const oldMessage = game.messageByToken?.get(passCommit.oldToken) || passCommit.oldMessage;
        await disableBombMessage(game, oldMessage, passCommit.oldToken);
        const payload = {
            embeds: [makeEmbed(passDescription(
                passCommit.fromId,
                passCommit.toId,
                passCommit.passCount,
                passCommit.randomValue
            ))],
            components: [passRow(game.id, passCommit.newToken)],
        };
        const message = await safeSend(game, payload, 'pass-message');
        if (message) {
            message.bombMessageToken = passCommit.newToken;
            game.currentMessage = message;
            game.bombMessages ||= new Set();
            game.bombMessages.add(message);
            game.messageByToken ||= new Map();
            game.messageByToken.set(passCommit.newToken, message);
        }
        return message;
    });
    if (deliveredMessage === null) {
        await abortAfterCriticalPanelFailure(game);
        return { ok: false, reason: 'delivery' };
    }
    return result;
}

async function handleTargetSelect(interaction, game, messageToken) {
    const result = await submitBombTarget(game, {
        actorId: interaction.user?.id,
        targetId: interaction.values?.[0],
        messageToken,
    });
    if (result.ok) {
        await safeEphemeralReply(interaction, '💣 **炸弹已经成功转交。**', game);
        return true;
    }
    const content = result.reason === 'target'
        ? TARGET_INVALID_MESSAGE
        : result.reason === 'holder'
            ? NOT_HOLDER_MESSAGE
            : EXPIRED_MESSAGE;
    await safeEphemeralReply(interaction, content, game);
    return false;
}

async function handleBombInteraction(interaction, parts) {
    const parsed = parseParts(parts);
    const game = parsed.gameId && gameManager.getGame(parsed.gameId);
    if (!await deferEphemeralComponent(interaction, game)) return false;
    if (!game || game.type !== 'bomb') {
        await safeEphemeralReply(interaction, EXPIRED_MESSAGE, game);
        return false;
    }
    if (parsed.action === 'join') return handleJoin(interaction, game);
    if (parsed.action === 'pass') return handlePassButton(interaction, game, parsed.messageToken);
    if (parsed.action === 'target') return handleTargetSelect(interaction, game, parsed.messageToken);
    await safeEphemeralReply(interaction, EXPIRED_MESSAGE, game);
    return false;
}

async function handleBombMemberInvalidated(game, userId, reason) {
    if (!game || game.type !== 'bomb') return false;
    let removed = false;
    let outcome = null;
    let reassignment = null;
    let explosionClaimed = false;

    await gameManager.runExclusive(game, () => {
        if (
            game.ended
            || (game.state !== 'recruiting' && game.state !== 'active')
            || !game.participantIds.includes(userId)
        ) return;
        const currentTime = nowFor(game);
        if (game.state === 'active' && currentTime >= game.explodeAt) {
            game.state = 'exploding';
            game.finalHolderId = game.currentHolderId;
            game.explosionClaimedAt = currentTime;
            explosionClaimed = true;
            return;
        }

        const wasHolder = game.currentHolderId === userId;
        removed = gameManager.removePlayer(game, userId);
        game.memberById?.delete(userId);
        if (!removed) return;
        if (game.state === 'recruiting') {
            outcome = 'recruiting';
            return;
        }
        if (game.state !== 'active') return;
        if (wasHolder) {
            for (const participantId of [...game.participantIds]) {
                const knownMember = game.memberById?.get(participantId)
                    || game.guild?.members?.cache?.get(participantId);
                if (knownMember && !isValidHumanMember(knownMember)) {
                    gameManager.removePlayer(game, participantId);
                    game.memberById?.delete(participantId);
                }
            }
        }
        if (game.participantIds.length < MIN_PARTICIPANTS) {
            game.state = 'cancelling';
            outcome = 'cancel';
            return;
        }
        if (!wasHolder) {
            outcome = 'continue';
            return;
        }

        const oldMessage = game.currentMessage;
        const oldToken = game.messageToken;
        const newHolderId = game.participantIds[randomIndex(game.participantIds.length, randomFor(game))];
        game.currentHolderId = newHolderId;
        game.holderSince = currentTime;
        game.messageToken += 1;
        reassignment = {
            newHolderId,
            oldMessage,
            oldToken,
            newToken: game.messageToken,
        };
        outcome = 'reassign';
    });

    if (explosionClaimed) {
        await finishExplosion(game);
        return false;
    }
    if (!removed) return false;
    if (outcome === 'recruiting') {
        await queuePanelWrite(game, () => {
            if (game.state !== 'recruiting') return false;
            game.recruitmentPayload = recruitmentPayload(game);
            return safeEdit(game.recruitmentMessage, game.recruitmentPayload, game, 'member-left-recruitment');
        });
    } else if (outcome === 'cancel') {
        await cancelForTooFew(game, false);
    } else if (outcome === 'reassign') {
        const deliveredMessage = await queuePublicWrite(game, async () => {
            if (
                game.ended
                || game.state !== 'active'
                || game.messageToken !== reassignment.newToken
                || game.currentHolderId !== reassignment.newHolderId
            ) return PANEL_SKIPPED;
            const oldMessage = game.messageByToken?.get(reassignment.oldToken) || reassignment.oldMessage;
            await disableBombMessage(game, oldMessage, reassignment.oldToken);
            const payload = {
                embeds: [makeEmbed(reassignmentDescription(userId, reassignment.newHolderId, reason))],
                components: [passRow(game.id, reassignment.newToken)],
            };
            const message = await safeSend(game, payload, 'member-invalidated-reassignment');
            if (message) {
                message.bombMessageToken = reassignment.newToken;
                game.currentMessage = message;
                game.bombMessages ||= new Set();
                game.bombMessages.add(message);
                game.messageByToken ||= new Map();
                game.messageByToken.set(reassignment.newToken, message);
            }
            return message;
        });
        if (deliveredMessage === null) {
            await abortAfterCriticalPanelFailure(game);
        }
    }
    return true;
}

module.exports = {
    startBomb,
    handleBombInteraction,
    randomExplosionDelayMs,
    submitBombTarget,
    handleBombMemberInvalidated,
};
