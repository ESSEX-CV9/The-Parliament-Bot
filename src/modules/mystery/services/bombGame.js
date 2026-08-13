const { randomInt, randomUUID } = require('node:crypto');
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    StringSelectMenuBuilder,
} = require('discord.js');
const gameManager = require('./mysteryGameManager');
const defaultPanelLifecycle = require('./panelLifecycle');
const defaultCooldownStore = require('../utils/bombCooldownStore');

const RECRUITMENT_DURATION_MS = 3 * 60 * 1000;
const BOMB_TIMEOUT_DURATION_MS = 5 * 60 * 1000;
const DEFUSE_FAILURE_TIMEOUT_DURATION_MS = 10 * 60 * 1000;
const DEFUSE_TARGET_DURATION_MS = 30 * 1000;
const BOMB_TIMEOUT_REASON = '神秘指令：传炸弹';
const MIN_PARTICIPANTS = 3;
const MAX_PARTICIPANTS = 8;
const cooldownLoadPromises = new WeakMap();
const PANEL_SKIPPED = Symbol('panel-skipped');

const PLAYER_BUSY_MESSAGE = '🚫 **一心不能二用。**\n你现在已经在一场神秘游戏里，先把那边活着玩完再说。';
const CHANNEL_BUSY_MESSAGE = '🎮 **这里已经有一场游戏在进行了。**\n等当前游戏结束后再开新的吧。';
function cooldownMessage(expiresAt) {
    return `⏳ **这个神秘指令还在冷却中。**\n可再次使用：<t:${Math.floor(expiresAt / 1000)}:R>`;
}
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

function randomExplosionDelayMs(randomValue = Math.random(), randomIntValue) {
    const intFn = typeof randomIntValue === 'function' ? randomIntValue : randomInt;
    let minSec, maxSec;
    if (randomValue < 0.15) { minSec = 1; maxSec = 50; }
    else if (randomValue < 0.50) { minSec = 51; maxSec = 100; }
    else { minSec = 101; maxSec = 150; }
    return (minSec + intFn(0, maxSec - minSec)) * 1000;
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
        '- 炸弹最多撑 **150 秒**；爆炸时持有炸弹的人将被 **禁言 5 分钟**',
        '- 面板上的 🟢🟡🔴 是危险等级提示，不会显示准确剩余时间',
        '- 拿到炸弹的人可以把它传给其他参与者',
        '- 但不能把炸弹原路传回上一位持有者',
        '- 本局第一次拿到炸弹时拆弹尚未解锁',
        '- 第二次及以后拿到，永久解锁拆弹（成功率 **50%**）',
        '- 拆弹失败会当场爆炸，拆弹者被 **禁言 10 分钟**',
        '- 拆弹成功可在 30 秒内指定其他参与者；目标会立刻爆炸并被 **禁言 5 分钟**',
        '- 超时未指定则随机选择目标；没有其他有效目标时由拆弹者承担',
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

function firstHolderDescription(game, snapshot) {
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
        '',
        dangerDescription(game),
        holdCountDescription(game, snapshot.currentHolderId),
    ].join('\n');
}

function passDescription(game, fromId, toId, count, randomValue) {
    const copy = PASS_COPY_BUILDERS[randomIndex(PASS_COPY_BUILDERS.length, randomValue)](fromId, toId);
    return [
        copy,
        '',
        dangerDescription(game),
        holdCountDescription(game, toId),
        '',
        `**当前持有者：<@${toId}>**`,
        `**已传递：${count} 次**`,
    ].join('\n');
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

function reassignmentDescription(game, userId, holderId, reason) {
    const baseLines = reason === 'timeout' || reason === 'member-timeout'
        ? [
            `🔇 **<@${userId}> 突然失去了说话的资格。**`,
            '',
            '他已从本局游戏中移除。',
            '',
            `💣 炸弹随机落到了 **<@${holderId}>** 手里。`,
        ]
        : [
            `🚪 **<@${userId}> 带着跑路的想法离开了服务器。**`,
            '',
            '可惜炸弹不能就这么消失。',
            '',
            `💣 炸弹随机落到了 **<@${holderId}>** 手里。`,
        ];
    return [
        ...baseLines,
        '',
        dangerDescription(game),
        holdCountDescription(game, holderId),
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

const DEFUSE_LOCKED_MESSAGE = '🔒 **你还没摸熟这东西。**\n\n这是你本局第一次拿到炸弹。\n至少活着再接到一次，才能尝试拆弹。';
const IMMEDIATE_RETURN_MESSAGE = '↩️ **这锅不能原路退回。**\n\n炸弹刚从对方手里过来，\n至少先祸害一下别人。';

function dangerLevel(game) {
    const elapsed = Math.max(0, Math.floor((nowFor(game) - game.startedAt) / 1000));
    if (elapsed <= 50) return 'green';
    if (elapsed <= 100) return 'yellow';
    return 'red';
}

function dangerDescription(game) {
    const level = dangerLevel(game);
    if (level === 'green') {
        return '🟢 **炸弹状态：暂时还算安分**\n滴答声听起来还没那么着急。';
    }
    if (level === 'yellow') {
        return '🟡 **炸弹状态：开始不太对劲了**\n滴答声明显快了不少，建议别拿太久。';
    }
    return '🔴 **炸弹状态：非常危险**\n这东西现在在谁手里，谁最好别想太久。';
}

function holdCountDescription(game, userId) {
    const count = game.holdCount?.get(userId) || 0;
    const canDefuse = count >= 2;
    const lines = [
        '',
        `这是你本局第 **${count} 次**拿到炸弹。`,
    ];
    if (!canDefuse) {
        lines.push('');
        lines.push('🔒 **拆弹尚未解锁**');
        lines.push('活着再接到一次，才能尝试拆弹。');
    } else {
        lines.push('');
        lines.push('🛡️ **拆弹已解锁**');
    }
    return lines.join('\n');
}

function passRow(gameId, messageToken, { disabled = false, defuseLocked = false } = {}) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`mystery_bomb_pass:${gameId}:${messageToken}`)
            .setLabel('💣 传炸弹')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`mystery_bomb_defuse:${gameId}:${messageToken}`)
            .setLabel(disabled ? '🛡️ 拆弹' : (defuseLocked ? '🔒 拆弹未解锁' : '🛡️ 拆弹'))
            .setStyle(ButtonStyle.Success)
            .setDisabled(disabled || defuseLocked)
    );
}

function defuseDescription(game, timeoutFailed) {
    const durationSeconds = Math.max(
        0,
        Math.floor(((game.defuseClaimedAt ?? nowFor(game)) - game.startedAt) / 1000)
    );
    const succeeded = game.defuseOutcome === 'defuse_success';
    const lines = succeeded
        ? [
            '🛠️ **拆弹成功！**',
            '',
            `<@${game.finalHolderId}> 在最后关头成功拆除了炸弹。`,
            '',
            '**本局统计**',
            `- 总传递次数：**${game.passCount} 次**`,
            `- 本局持续时间：**${durationSeconds} 秒**`,
            `- 拆弹者：<@${game.finalHolderId}>`,
        ]
        : [
            '💥 **拆弹失败！**',
            '',
            `<@${game.finalHolderId}> 剪错了线，炸弹当场爆炸。`,
            '',
            '奖励：**禁言 10 分钟。**',
            '',
            '**本局统计**',
            `- 总传递次数：**${game.passCount} 次**`,
            `- 本局持续时间：**${durationSeconds} 秒**`,
            `- 拆弹者：<@${game.finalHolderId}>`,
        ];
    if (timeoutFailed) lines.push('', TIMEOUT_FAILURE_LINE);
    return lines.join('\n');
}

function defuseTargetingDescription(game) {
    return [
        '🛠️ **拆弹成功！但事情还没结束。**',
        '',
        `<@${game.defuseActorId}> 获得了指定爆炸目标的机会。`,
        '',
        '目标选定后炸弹将立刻爆炸；30 秒未选择则随机指定。',
    ].join('\n');
}

function forcedExplosionDescription(game, timeoutFailed) {
    const lines = [
        '💥 **拆弹后的最后惊喜！**',
        '',
        `<@${game.defuseActorId}> 指定了 <@${game.finalHolderId}>。`,
        '炸弹在目标手中立刻爆炸。',
        '',
        '奖励：**禁言 5 分钟。**',
        '',
        '**本局统计**',
        `- 总传递次数：**${game.passCount} 次**`,
        `- 拆弹者：<@${game.defuseActorId}>`,
        `- 最终目标：<@${game.finalHolderId}>`,
    ];
    if (timeoutFailed) lines.push('', TIMEOUT_FAILURE_LINE);
    return lines.join('\n');
}

function defuseSucceeds(game) {
    const randomInteger = typeof game?.randomInt === 'function' ? game.randomInt : randomInt;
    return randomInteger(0, 2) === 0;
}

function recruitmentPayload(game, disabled = false, description = recruitmentDescription(game)) {
    return {
        embeds: [makeEmbed(description)],
        components: [joinRow(game.id, disabled)],
    };
}

function bombPayload(gameId, messageToken, description, { disabled = false, defuseLocked = false } = {}) {
    return {
        embeds: [makeEmbed(description)],
        components: [passRow(gameId, messageToken, { disabled, defuseLocked })],
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

function lifecycleFor(game) {
    return game?.panelLifecycle || defaultPanelLifecycle;
}

function panelContext(game, action) {
    return { action, guildId: game?.guildId, gameId: game?.id };
}

function invalidateRecruitmentPanel(game, action, {
    keepMessage = false,
    disablePayload = { components: [joinRow(game.id, true)] },
} = {}) {
    if (!game?.recruitmentMessage) return Promise.resolve(false);
    return lifecycleFor(game).invalidatePanel(game.recruitmentMessage, {
        keepMessage,
        disablePayload,
        context: panelContext(game, action),
    });
}

function invalidateBombMessage(game, message, token, action, keepMessage = false) {
    if (!message) return Promise.resolve(false);
    return lifecycleFor(game).invalidatePanel(message, {
        keepMessage,
        disablePayload: { components: [passRow(game.id, token, { disabled: true })] },
        context: panelContext(game, action),
    });
}

async function stagePanelDeletion(game, message, options) {
    if (!message) return false;
    game.pendingPanelDeletions ||= new Map();
    if (!game.pendingPanelDeletions.has(message)) {
        game.pendingPanelDeletions.set(message, {
            message,
            context: panelContext(game, options.action),
        });
    }
    if (options.kind === 'recruitment') {
        return invalidateRecruitmentPanel(game, options.action, { keepMessage: true });
    }
    return invalidateBombMessage(game, message, options.token, options.action, true);
}

async function disableAllComponents(game, action = 'game-final') {
    try {
        await game.panelWriteQueue;
        await game.publicWriteQueue;
    } catch (error) {
        logDiscordFailure(game, 'wait-component-writes', error);
    }
    const invalidations = [stagePanelDeletion(game, game.recruitmentMessage, {
        kind: 'recruitment',
        action: `${action}-recruitment`,
    })];
    const messages = [...(game.bombMessages || [])];
    invalidations.push(...messages.map(message => stagePanelDeletion(game, message, {
        kind: 'holder',
        token: message.bombMessageToken ?? game.messageToken,
        action: `${action}-holder`,
    })));
    await Promise.all(invalidations);
}

function armPanelDeletions(game) {
    for (const pending of game.pendingPanelDeletions?.values?.() || []) {
        if (pending.armed) continue;
        pending.armed = true;
        lifecycleFor(game).deleteMessageAfter(pending.message, 5_000, pending.context);
    }
}

async function cleanupBombGame(game) {
    if (!game || game.cleanupPromise) return game?.cleanupPromise;
    let operation;
    operation = (async () => {
        await disableAllComponents(game, 'game-cleanup');
        await gameManager.cleanupGame(game);
        game.state = 'ended';
        armPanelDeletions(game);
    })().catch(error => {
        logDiscordFailure(game, 'cleanup', error);
    });
    game.cleanupPromise = operation;
    return operation;
}

function claimNaturalExplosion(game, currentTime) {
    if (game.ended || game.state !== 'active' || currentTime < game.explodeAt) return false;
    game.state = 'exploding';
    game.finalHolderId = game.currentHolderId;
    game.explosionClaimedAt = currentTime;
    game.settlementCount = (game.settlementCount || 0) + 1;
    return true;
}

async function claimExplosion(game, currentTime) {
    let claimed = false;
    await gameManager.runExclusive(game, () => {
        claimed = claimNaturalExplosion(game, currentTime);
    });
    return claimed;
}

async function finishExplosion(game) {
    if (game.explosionPromise) return game.explosionPromise;
    let operation;
    operation = (async () => {
        try {
            await game.publicWriteQueue;
            await disableAllComponents(game);

            const resultMessage = await queuePublicWrite(game, () => safeSend(
                game,
                { embeds: [makeEmbed(explosionDescription(game, false))], components: [] },
                'explosion-result'
            ));
            if (!resultMessage || resultMessage === PANEL_SKIPPED) return;

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
        } finally {
            await cleanupBombGame(game);
        }
    })().catch(error => {
        logDiscordFailure(game, 'finish-explosion', error);
    });
    game.explosionPromise = operation;
    return operation;
}

async function finishDefuse(game) {
    if (game.defusePromise) return game.defusePromise;
    let operation;
    operation = (async () => {
        try {
            await game.publicWriteQueue;
            await disableAllComponents(game);

            const resultMessage = await queuePublicWrite(game, () => safeSend(
                game,
                { embeds: [makeEmbed(defuseDescription(game, false))], components: [] },
                'defuse-result'
            ));
            if (!resultMessage || resultMessage === PANEL_SKIPPED) return;
            if (game.defuseOutcome !== 'defuse_failure') return;

            let timeoutFailed = false;
            const member = await safeFetchMember(game, game.finalHolderId);
            if (!member?.moderatable || typeof member.timeout !== 'function') {
                timeoutFailed = true;
            } else {
                try {
                    await member.timeout(
                        DEFUSE_FAILURE_TIMEOUT_DURATION_MS,
                        BOMB_TIMEOUT_REASON
                    );
                } catch (error) {
                    timeoutFailed = true;
                    logDiscordFailure(game, 'timeout-failed-defuser', error, game.finalHolderId);
                }
            }

            if (timeoutFailed) {
                const appended = await queuePublicWrite(game, () => safeEdit(
                    resultMessage,
                    { embeds: [makeEmbed(defuseDescription(game, true))], components: [] },
                    game,
                    'append-defuse-timeout-failure'
                ));
                if (!appended) {
                    await queuePublicWrite(game, () => safeSend(
                        game,
                        { content: TIMEOUT_FAILURE_LINE, components: [] },
                        'defuse-timeout-failure-supplement'
                    ));
                }
            }
        } finally {
            await cleanupBombGame(game);
        }
    })().catch(error => {
        logDiscordFailure(game, 'finish-defuse', error);
    });
    game.defusePromise = operation;
    return operation;
}

function clearDefuseTargetTimer(game) {
    if (!game?.defuseTargetTimer) return;
    const clearTimer = game.clearTimeoutImpl || clearTimeout;
    clearTimer(game.defuseTargetTimer);
    game.timers?.delete(game.defuseTargetTimer);
    game.defuseTargetTimer = null;
}

async function finishForcedExplosion(game) {
    if (game.forcedExplosionPromise) return game.forcedExplosionPromise;
    const operation = (async () => {
        try {
            await game.publicWriteQueue;
            await disableAllComponents(game);
            const resultMessage = await queuePublicWrite(game, () => safeSend(
                game,
                { embeds: [makeEmbed(forcedExplosionDescription(game, false))], components: [] },
                'forced-explosion-result'
            ));
            if (!resultMessage || resultMessage === PANEL_SKIPPED) return;

            let timeoutFailed = false;
            const member = await safeFetchMember(game, game.finalHolderId);
            if (!member?.moderatable || typeof member.timeout !== 'function') {
                timeoutFailed = true;
            } else {
                try {
                    await member.timeout(BOMB_TIMEOUT_DURATION_MS, BOMB_TIMEOUT_REASON);
                } catch (error) {
                    timeoutFailed = true;
                    logDiscordFailure(game, 'timeout-forced-target', error, game.finalHolderId);
                }
            }
            if (timeoutFailed) {
                await safeEdit(
                    resultMessage,
                    { embeds: [makeEmbed(forcedExplosionDescription(game, true))], components: [] },
                    game,
                    'append-forced-timeout-failure'
                );
            }
        } finally {
            await cleanupBombGame(game);
        }
    })().catch(error => logDiscordFailure(game, 'finish-forced-explosion', error));
    game.forcedExplosionPromise = operation;
    return operation;
}

async function submitDefuseTarget(game, input = {}) {
    const targetMember = input.targetId ? await safeFetchMember(game, input.targetId) : null;
    let result = { accepted: false, outcome: 'rejected', reason: 'expired' };
    await gameManager.runExclusive(game, () => {
        if (
            gameManager.getGame(game.id) !== game
            || game.ended
            || game.state !== 'defuse_targeting'
            || game.defuseActorId !== input.actorId
            || game.messageToken !== input.messageToken
        ) return;
        if (
            input.targetId === input.actorId
            || !game.participantIds.includes(input.targetId)
            || !isValidHumanMember(targetMember)
        ) {
            result = { accepted: false, outcome: 'rejected', reason: 'target' };
            return;
        }
        clearDefuseTargetTimer(game);
        game.state = 'exploding';
        game.finalHolderId = input.targetId;
        game.explosionClaimedAt = nowFor(game);
        result = { accepted: true, outcome: 'forced_explosion' };
    });
    if (result.accepted) await finishForcedExplosion(game);
    return result;
}

async function settleDefuseTargetFallback(game) {
    const candidates = [];
    for (const userId of game.participantIds || []) {
        if (userId === game.defuseActorId) continue;
        const member = await safeFetchMember(game, userId);
        if (isValidHumanMember(member)) candidates.push(userId);
    }
    const targetId = candidates.length > 0
        ? candidates[randomIndex(candidates.length, randomFor(game))]
        : game.defuseActorId;
    if (targetId === game.defuseActorId) {
        let claimed = false;
        await gameManager.runExclusive(game, () => {
            if (game.ended || game.state !== 'defuse_targeting') return;
            clearDefuseTargetTimer(game);
            game.state = 'exploding';
            game.finalHolderId = game.defuseActorId;
            game.explosionClaimedAt = nowFor(game);
            claimed = true;
        });
        if (claimed) await finishForcedExplosion(game);
        return claimed;
    }
    const result = await submitDefuseTarget(game, {
        actorId: game.defuseActorId,
        targetId,
        messageToken: game.messageToken,
    });
    return result.accepted;
}

async function beginDefuseTargeting(game) {
    if (game.explosionTimer) {
        const clearTimer = game.clearTimeoutImpl || clearTimeout;
        clearTimer(game.explosionTimer);
        game.timers?.delete(game.explosionTimer);
        game.explosionTimer = null;
    }
    await disableAllComponents(game, 'defuse-targeting');
    const statusMessage = await queuePublicWrite(game, () => safeSend(
        game,
        { embeds: [makeEmbed(defuseTargetingDescription(game))], components: [] },
        'defuse-targeting-status'
    ));
    if (statusMessage && statusMessage !== PANEL_SKIPPED) game.bombMessages?.add(statusMessage);
    const setTimer = game.setTimeoutImpl || setTimeout;
    game.defuseTargetTimer = setTimer(() => {
        return settleDefuseTargetFallback(game)
            .catch(error => logDiscordFailure(game, 'defuse-target-timeout', error));
    }, DEFUSE_TARGET_DURATION_MS);
    game.defuseTargetTimer?.unref?.();
    game.timers?.add(game.defuseTargetTimer);
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
    await queuePublicWrite(game, () => safeSend(
        game,
        { embeds: [makeEmbed(description)], components: [] },
        recruitment ? 'recruitment-cancelled' : 'active-game-cancelled'
    ));
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
        game.explodeAt = currentTime + randomExplosionDelayMs(randomFor(game), game.randomInt);
        game.currentHolderId = game.participantIds[randomIndex(game.participantIds.length, randomFor(game))];
        game.previousHolderId = null;
        game.holderSince = currentTime;
        game.passCount = 0;
        game.messageToken = 1;
        game.holdCount = new Map([[game.currentHolderId, 1]]);
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
        firstHolderDescription(game, activationSnapshot),
        { defuseLocked: true }
    );
    const firstMessage = await queuePublicWrite(game, async () => {
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
    if (firstMessage === null) {
        await abortAfterCriticalPanelFailure(game);
        return false;
    }
    if (firstMessage !== PANEL_SKIPPED) {
        await invalidateRecruitmentPanel(game, 'close-recruitment', {
            disablePayload: recruitmentPayload(
                game,
                true,
                recruitmentClosedDescription(activationSnapshot.participantIds.length)
            ),
        });

        // 开局真实 Ping 一次
        try {
            await game.channel?.send({
                content: '💣 **「传炸弹」开始了！**\n'
                    + activationSnapshot.participantIds.map(id => `<@${id}>`).join(' ')
                    + '\n\n别聊忘了，炸弹可不等人。',
                allowedMentions: { parse: [], users: activationSnapshot.participantIds },
            });
        } catch (error) {
            logDiscordFailure(game, 'start-ping', error);
        }
    }
    return firstMessage !== PANEL_SKIPPED;
}

async function startBomb(interaction, {
    cooldownMs = defaultCooldownStore.DEFAULT_COOLDOWN_DURATION_MS,
    panelLifecycle = defaultPanelLifecycle,
} = {}) {
    const userId = interaction.user?.id;
    const guildId = interaction.guildId || interaction.guild?.id;
    const channelId = interaction.channelId;
    const cooldownStore = interaction.bombCooldownStore || defaultCooldownStore;
    // 该频道解析出来的冷却为 0 时，检查和写入都跳过。
    const useCooldown = Number.isFinite(cooldownMs) && cooldownMs > 0;
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
        panelLifecycle,
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
    if (useCooldown && !await ensureCooldownStoreLoaded(cooldownStore, provisionalGame, userId)) {
        await failDeferredStart(interaction, INVALID_MEMBER_MESSAGE, provisionalGame);
        return false;
    }
    if (useCooldown) {
        try {
            const expiresAt = cooldownStore.getExpiresAt(guildId, userId, channelId);
            if (expiresAt !== null) {
                await failDeferredStart(interaction, cooldownMessage(expiresAt), provisionalGame);
                return false;
            }
        } catch (error) {
            logDiscordFailure(provisionalGame, 'cooldown-check', error, userId);
            await failDeferredStart(interaction, INVALID_MEMBER_MESSAGE, provisionalGame);
            return false;
        }
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
    provisionalGame.disableComponents = () => cleanupBombGame(game);

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
    if (useCooldown) {
        try {
            await cooldownStore.startCooldown(guildId, userId, channelId, cooldownMs);
        } catch (error) {
            logDiscordFailure(game, 'cooldown-start', error, userId);
        }
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
        if (userId === game.previousHolderId) continue;
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

async function submitBombMutation(game, input = {}) {
    if (!game || game.type !== 'bomb') {
        return { accepted: false, outcome: 'rejected', reason: 'expired' };
    }

    const targetMember = input.kind === 'pass'
        ? await safeFetchMember(game, input.targetId)
        : null;
    let result = { accepted: false, outcome: 'rejected', reason: 'expired' };
    let passCommit = null;

    await gameManager.runExclusive(game, () => {
        const currentTime = input.now ?? nowFor(game);
        if (
            gameManager.getGame(game.id) !== game
            || game.ended
            || game.state !== 'active'
        ) return;

        if (claimNaturalExplosion(game, currentTime)) {
            result = { accepted: true, outcome: 'natural_explosion' };
            return;
        }
        if (game.currentHolderId !== input.userId) {
            result = { accepted: false, outcome: 'rejected', reason: 'holder' };
            return;
        }
        if (game.messageToken !== input.messageToken) {
            result = { accepted: false, outcome: 'rejected', reason: 'stale' };
            return;
        }

        if (input.kind === 'defuse') {
            const holderCount = game.holdCount?.get(input.userId) || 0;
            if (holderCount < 2) {
                result = { accepted: false, outcome: 'rejected', reason: 'defuse_locked' };
                return;
            }
            const outcome = defuseSucceeds(game) ? 'defuse_success' : 'defuse_failure';
            game.state = outcome === 'defuse_success' ? 'defuse_targeting' : 'defusing';
            game.finalHolderId = game.currentHolderId;
            game.defuseActorId = game.currentHolderId;
            game.defuseClaimedAt = currentTime;
            game.defuseOutcome = outcome;
            game.settlementCount = (game.settlementCount || 0) + 1;
            result = { accepted: true, outcome };
            return;
        }
        if (input.kind !== 'pass') {
            result = { accepted: false, outcome: 'rejected', reason: 'kind' };
            return;
        }
        if (input.targetId === game.previousHolderId) {
            result = { accepted: false, outcome: 'rejected', reason: 'immediate_return' };
            return;
        }
        if (
            input.targetId === input.userId
            || !game.participantIds.includes(input.targetId)
            || !isValidHumanMember(targetMember)
        ) {
            result = { accepted: false, outcome: 'rejected', reason: 'target' };
            return;
        }

        const oldMessage = game.currentMessage;
        const oldToken = game.messageToken;
        const randomValue = randomFor(game);
        const fromId = game.currentHolderId;
        game.previousHolderId = fromId;
        game.currentHolderId = input.targetId;
        game.holderSince = currentTime;
        game.passCount += 1;
        game.messageToken += 1;
        game.holdCount ||= new Map();
        game.holdCount.set(input.targetId, (game.holdCount.get(input.targetId) || 0) + 1);
        passCommit = {
            fromId,
            toId: input.targetId,
            oldMessage,
            oldToken,
            newToken: game.messageToken,
            passCount: game.passCount,
            randomValue,
        };
        result = { accepted: true, outcome: 'pass' };
    });

    if (result.outcome === 'natural_explosion') {
        await finishExplosion(game);
        return result;
    }
    if (result.outcome === 'defuse_success') {
        await beginDefuseTargeting(game);
        return result;
    }
    if (result.outcome === 'defuse_failure') {
        await finishDefuse(game);
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
        const newHolderCount = game.holdCount?.get(passCommit.toId) || 0;
        const payload = {
            embeds: [makeEmbed(passDescription(
                game,
                passCommit.fromId,
                passCommit.toId,
                passCommit.passCount,
                passCommit.randomValue
            ))],
            components: [passRow(game.id, passCommit.newToken, { defuseLocked: newHolderCount < 2 })],
        };
        const message = await safeSend(game, payload, 'pass-message');
        if (message) {
            message.bombMessageToken = passCommit.newToken;
            game.currentMessage = message;
            game.bombMessages ||= new Set();
            game.bombMessages.add(message);
            game.messageByToken ||= new Map();
            game.messageByToken.set(passCommit.newToken, message);
            const oldMessage = game.messageByToken?.get(passCommit.oldToken) || passCommit.oldMessage;
            await invalidateBombMessage(
                game,
                oldMessage,
                passCommit.oldToken,
                'pass-previous-holder'
            );
        }
        return message;
    });
    if (deliveredMessage === null) {
        await abortAfterCriticalPanelFailure(game);
        return { accepted: false, outcome: 'rejected', reason: 'delivery' };
    }
    return result;
}

async function submitBombTarget(game, input) {
    const result = await submitBombMutation(game, {
        kind: 'pass',
        userId: input.actorId,
        targetId: input.targetId,
        messageToken: input.messageToken,
        now: input.now,
    });
    if (result.accepted && result.outcome === 'pass') return { ok: true };
    if (result.outcome === 'natural_explosion') return { ok: false, reason: 'exploded' };
    return { ok: false, reason: result.reason || 'expired' };
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
            : result.reason === 'immediate_return'
                ? IMMEDIATE_RETURN_MESSAGE
                : EXPIRED_MESSAGE;
    await safeEphemeralReply(interaction, content, game);
    return false;
}

async function handleDefuseButton(interaction, game, messageToken) {
    const result = await submitBombMutation(game, {
        kind: 'defuse',
        userId: interaction.user?.id,
        messageToken,
    });
    if (!result.accepted && result.reason === 'defuse_locked') {
        await safeEphemeralReply(interaction, DEFUSE_LOCKED_MESSAGE, game);
        return false;
    }
    if (result.accepted && result.outcome === 'defuse_success') {
        const options = [];
        for (const userId of game.participantIds || []) {
            if (userId === interaction.user?.id) continue;
            const member = await safeFetchMember(game, userId);
            if (!isValidHumanMember(member)) continue;
            const label = member.displayName || member.user.globalName || member.user.username || userId;
            options.push({ label: String(label).slice(0, 100), value: userId });
        }
        if (options.length > 0) {
            const select = new StringSelectMenuBuilder()
                .setCustomId(`mystery_bomb_defuse_target:${game.id}:${messageToken}`)
                .setPlaceholder('选择必爆目标')
                .addOptions(options);
            await safeEphemeralReply(
                interaction,
                '🛠️ **拆弹成功。请选择一名必爆目标；30 秒后将随机选择。**',
                game,
                [new ActionRowBuilder().addComponents(select)]
            );
            return true;
        }
        await safeEphemeralReply(interaction, '🛠️ **拆弹成功，但没有其他有效目标。**', game);
        return true;
    }
    if (result.accepted && result.outcome === 'defuse_failure') {
        await safeEphemeralReply(interaction, '🛠️ **拆弹结果已经揭晓。**', game);
        return true;
    }
    await safeEphemeralReply(interaction, EXPIRED_MESSAGE, game);
    return false;
}

async function handleDefuseTargetSelect(interaction, game, messageToken) {
    const result = await submitDefuseTarget(game, {
        actorId: interaction.user?.id,
        targetId: interaction.values?.[0],
        messageToken,
    });
    if (result.accepted) {
        await safeEphemeralReply(interaction, '💥 **已指定目标，炸弹已经爆炸。**', game);
        return true;
    }
    await safeEphemeralReply(
        interaction,
        result.reason === 'target' ? TARGET_INVALID_MESSAGE : EXPIRED_MESSAGE,
        game
    );
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
    if (parsed.action === 'defuse') return handleDefuseButton(interaction, game, parsed.messageToken);
    if (parsed.action === 'defuse_target') return handleDefuseTargetSelect(interaction, game, parsed.messageToken);
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
            || !['recruiting', 'active', 'defuse_targeting'].includes(game.state)
            || !game.participantIds.includes(userId)
        ) return;
        if (game.state === 'defuse_targeting') {
            removed = gameManager.removePlayer(game, userId);
            game.memberById?.delete(userId);
            if (removed) outcome = 'defuse_fallback';
            return;
        }
        const currentTime = nowFor(game);
        if (claimNaturalExplosion(game, currentTime)) {
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
        game.previousHolderId = null;
        game.currentHolderId = newHolderId;
        game.holderSince = currentTime;
        game.messageToken += 1;
        game.holdCount ||= new Map();
        game.holdCount.set(newHolderId, (game.holdCount.get(newHolderId) || 0) + 1);
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
    if (outcome === 'defuse_fallback') {
        await settleDefuseTargetFallback(game);
    } else if (outcome === 'recruiting') {
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
            const newHolderCount = game.holdCount?.get(reassignment.newHolderId) || 0;
            const payload = {
                embeds: [makeEmbed(reassignmentDescription(game, userId, reassignment.newHolderId, reason))],
                components: [passRow(game.id, reassignment.newToken, { defuseLocked: newHolderCount < 2 })],
            };
            const message = await safeSend(game, payload, 'member-invalidated-reassignment');
            if (message) {
                message.bombMessageToken = reassignment.newToken;
                game.currentMessage = message;
                game.bombMessages ||= new Set();
                game.bombMessages.add(message);
                game.messageByToken ||= new Map();
                game.messageByToken.set(reassignment.newToken, message);
                const oldMessage = game.messageByToken?.get(reassignment.oldToken) || reassignment.oldMessage;
                await invalidateBombMessage(
                    game,
                    oldMessage,
                    reassignment.oldToken,
                    'member-invalidated-previous-holder'
                );
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
    bombPayload,
    recruitmentPayload,
    startBomb,
    handleBombInteraction,
    randomExplosionDelayMs,
    submitBombMutation,
    submitDefuseTarget,
    submitBombTarget,
    handleBombMemberInvalidated,
};
