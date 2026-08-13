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
const { defaultService: devilPunishmentService } = require('./devilRoulettePunishment');
const { createPanelRegistry } = defaultPanelLifecycle;

const INVITATION_DURATION_MS = 60_000;
const TURN_DURATION_MS = 60_000;
const TRANSITION_DELAY_MS = 2_000;
const MAX_HP = 3;
const MAX_INVENTORY = 4;
const ITEMS_PER_RELOAD = 2;
const CIGARETTE_HEAL = 1;

const PLAYER_BUSY_MESSAGE = '🚫 **一心不能二用。**\n你现在已经在一场神秘游戏里，先把那边活着玩完再说。';
const CHANNEL_BUSY_MESSAGE = '🎮 **这里已经有一场游戏在进行了。**\n等当前游戏结束后再开新的吧。';
const INVALID_OPPONENT_MESSAGE = '👿 **这个对手现在无法参加恶魔轮盘。**\n换个人再试试吧。';
const INVALID_INITIATOR_MESSAGE = '👿 **你现在无法发起恶魔轮盘。**';
const TIMEOUT_BLOCKED_MESSAGE = '👿 **你现在无法参加恶魔轮盘。**\n你当前还在禁言，暂时无法参加。';
const EXPIRED_MESSAGE = '⌛ **这场恶魔轮盘已经结束或失效了。**';
const SELF_ACCEPT_MESSAGE = '😐 **你已经坐在桌边了。**\n不用自己接受自己的邀请。';
const SELF_JOIN_MESSAGE = '😐 **你已经在桌上了。**\n我暂时还没学会复制一个你出来当对手。';
const WRONG_INVITEE_MESSAGE = '👀 **枪不是递给你的。**\n这场邀请已经有名字了，围观就好。';
const NOT_YOUR_TURN_MESSAGE = '✋ **枪现在不在你手上。**\n等轮到你再动。';
const STALE_PANEL_MESSAGE = '⌛ **这张面板已经过期了。**\n请使用最新的恶魔轮盘面板继续操作。';
const SURRENDER_CONFIRM_PROMPT = [
    '## 🏳️ 要投降吗？',
    '',
    '确认后你会**立即判负**。',
    '对手将获得本局的处罚裁决权。',
    '',
    '你的回合计时**不会因为这个面板暂停**。',
].join('\n');
const SURRENDER_CANCEL_MESSAGE = '🔫 **那就继续。**\n枪还在桌上。';
const CIGARETTE_FULL_HP_MESSAGE = '🚬 **你现在一颗心都没少。**\n这根烟先留着，别浪费。';
const CIGARETTE_USED_MESSAGE = '🚬 **这一轮你已经抽过了。**\n再抽就不是回血，是单纯烟瘾大。';
const SAW_STACKED_MESSAGE = '🔪 **这把枪已经够短了。**\n手锯效果不能叠加。';
const HANDCUFF_STACKED_MESSAGE = '⛓️ **他已经被铐着了。**\n再铐一副也不会让他多长一只手。';
const GENERIC_FAILURE_MESSAGE = '❌ **处理这次操作时出了点问题，请稍后再试。**';

const ITEM_LABELS = Object.freeze({
    magnifier: '🔍 放大镜',
    beer: '🍺 啤酒',
    cigarette: '🚬 香烟',
    saw: '🔪 手锯',
    handcuff: '⛓️ 手铐',
});
const ITEM_ORDER = Object.freeze(['magnifier', 'beer', 'cigarette', 'saw', 'handcuff']);
// 独立加权抽取概率
const ITEM_WEIGHTS = Object.freeze({
    magnifier: 0.25,
    beer: 0.25,
    cigarette: 0.20,
    saw: 0.15,
    handcuff: 0.15,
});

// ── 可测试的确定性 RNG 纯函数 ────────────────────────────────────────────────

// 弹仓总弹数：3 发 30%、4 发 40%、5 发 30%。
function rollChamberSize(randomValue) {
    if (randomValue < 0.30) return 3;
    if (randomValue < 0.70) return 4;
    return 5;
}

// 各弹数构成（实弹数, 空包弹数），保证至少 1 实 1 空。
function rollChamberComposition(size, randomValue) {
    if (size === 3) {
        return randomValue < 0.50 ? { live: 1, blank: 2 } : { live: 2, blank: 1 };
    }
    if (size === 4) {
        if (randomValue < 0.60) return { live: 2, blank: 2 };
        if (randomValue < 0.80) return { live: 1, blank: 3 };
        return { live: 3, blank: 1 };
    }
    if (randomValue < 0.35) return { live: 2, blank: 3 };
    if (randomValue < 0.70) return { live: 3, blank: 2 };
    if (randomValue < 0.85) return { live: 1, blank: 4 };
    return { live: 4, blank: 1 };
}

function shuffleRounds(rounds, random = Math.random) {
    const copy = [...rounds];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

function buildChamber(random = Math.random) {
    const size = rollChamberSize(random());
    const composition = rollChamberComposition(size, random());
    const rounds = [];
    for (let i = 0; i < composition.live; i++) rounds.push('live');
    for (let i = 0; i < composition.blank; i++) rounds.push('blank');
    return {
        rounds: shuffleRounds(rounds, random),
        liveCount: composition.live,
        blankCount: composition.blank,
    };
}

function rollItem(randomValue) {
    let cumulative = 0;
    for (const item of ITEM_ORDER) {
        cumulative += ITEM_WEIGHTS[item];
        if (randomValue < cumulative) return item;
    }
    return ITEM_ORDER[ITEM_ORDER.length - 1];
}

function drawItems(count, random = Math.random) {
    const items = [];
    for (let i = 0; i < count; i++) {
        items.push(rollItem(random()));
    }
    return items;
}

// ── 基础工具 ────────────────────────────────────────────────────────────────

function logDiscordFailure(game, action, error, userId = 'system') {
    console.error(
        `[MysteryDevilRoulette] Discord API 失败 (guild=${game?.guildId || 'unknown'}, game=${game?.id || 'unknown'}, user=${userId}, action=${action}):`,
        error
    );
}

function nowFor(game) {
    return typeof game?.now === 'function' ? game.now() : Date.now();
}

function randomFor(game) {
    return typeof game?.random === 'function' ? game.random : Math.random;
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

// 私密消息默认 2 分钟后自动删除：私密面板不长期堆积在用户的交互消息里。
const PRIVATE_PANEL_TTL_MS = 2 * 60 * 1000;

async function sendPrivateMessage(interaction, payload, game) {
    try {
        if (interaction.deferred && !interaction.replied && typeof interaction.editReply === 'function') {
            await interaction.editReply(payload);
            return await interaction.fetchReply?.() || null;
        } else if (interaction.replied && typeof interaction.followUp === 'function') {
            return await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral }) || null;
        } else if (!interaction.replied && typeof interaction.reply === 'function') {
            await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
            return await interaction.fetchReply?.() || null;
        }
        return null;
    } catch (error) {
        logDiscordFailure(game, 'private-reply', error, interaction.user?.id);
        return null;
    }
}

async function sendPrivate(interaction, payload, game) {
    const message = await sendPrivateMessage(interaction, payload, game);
    // 所有私密消息统一定时清理（复用公共 panelLifecycle 的延迟删除）。
    if (message && typeof message.delete === 'function') {
        defaultPanelLifecycle.deleteMessageAfter(message, PRIVATE_PANEL_TTL_MS, {
            action: 'devil-private-cleanup',
            guildId: game?.guildId,
            gameId: game?.id,
        });
    }
    return Boolean(message);
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

function clearTimer(game, timer) {
    if (!timer) return;
    clearTimeout(timer);
    game.timers?.delete(timer);
}

// ── 面板构建 ────────────────────────────────────────────────────────────────

function heartLine(game, userId) {
    const hp = game.hp?.[userId] ?? 0;
    return `<@${userId}>　${'❤️'.repeat(Math.max(0, hp))}`;
}

function chamberLine(game) {
    return [
        '🔫 **剩余：**',
        `🔴 ×${game.liveCount}`,
        `⚪ ×${game.blankCount}`,
    ].join(' ');
}

function inventoryLine(game, userId) {
    const counts = new Map();
    for (const item of game.inventory?.get(userId) || []) {
        counts.set(item, (counts.get(item) || 0) + 1);
    }
    const parts = [];
    for (const item of ITEM_ORDER) {
        const count = counts.get(item) || 0;
        if (count > 0) parts.push(`${ITEM_LABELS[item]} ×${count}`);
    }
    return parts.length > 0 ? parts.join(' ') : '（空）';
}

function statusEffectLines(game) {
    const lines = [];
    if (game.saw) lines.push(`🔪 <@${game.saw}>：下一枪强化`);
    if (game.handcuff) lines.push(`⛓️ <@${game.handcuff}>：下一回合跳过`);
    return lines;
}

function stateSummary(game) {
    const [a, b] = game.participantIds;
    const lines = [
        heartLine(game, a),
        heartLine(game, b),
        '',
        chamberLine(game),
        '',
        `🎒 <@${a}>：${inventoryLine(game, a)}`,
        `🎒 <@${b}>：${inventoryLine(game, b)}`,
    ];
    const effects = statusEffectLines(game);
    if (effects.length > 0) {
        lines.push('', ...effects);
    }
    return lines;
}

function turnDescription(game) {
    const deadline = Math.floor(game.turnDeadlineAt / 1000);
    return [
        `🎯 **轮到 <@${game.currentTurn}> 了。**`,
        '',
        ...stateSummary(game),
        '',
        `⏳ **本回合结束：<t:${deadline}:R>**`,
        '',
        '**你的选择：**',
        '🔫 **射对手**　💀 **射自己**　🎒 **使用道具**　🏳️ **投降**',
    ].join('\n');
}

const RULES_DESCRIPTION = [
    '## 📖 恶魔轮盘 · 游戏规则',
    '',
    '### ❤️ 胜负',
    '',
    '双方开局都有 **3 点生命**。',
    '',
    '任意一方生命归零，立即落败。',
    '',
    '---',
    '',
    '### 🔫 霰弹枪',
    '',
    '每次装填会随机放入 **3～5 发子弹**，其中至少包含：',
    '',
    '🔴 **1 发实弹**',
    '⚪ **1 发空包弹**',
    '',
    '实弹和空包弹的**剩余数量会公开显示**，但顺序完全随机。',
    '',
    '每次重新装弹后，都会重新随机决定先手。',
    '',
    '---',
    '',
    '### 🎯 你的回合',
    '',
    '每回合有 **60 秒**。',
    '',
    '你可以：',
    '',
    '🔫 **射对手**',
    '💀 **射自己**',
    '🎒 **使用道具**',
    '🏳️ **投降**',
    '',
    '**射对手**',
    '',
    '- 实弹 → 对手掉血，换对方行动',
    '- 空包 → 无伤害，换对方行动',
    '',
    '**射自己**',
    '',
    '- 实弹 → 自己掉血，换对方行动',
    '- 空包 → 你没事，并且获得一个新的 **60 秒回合**',
    '',
    '60 秒内没有开枪，Bot 会替你**自动射向对手**。',
    '',
    '---',
    '',
    '### 🎒 道具',
    '',
    '每次装弹时，双方都会随机获得 **2 个道具**。',
    '',
    '每人最多携带 **4 个**，未使用的道具会保留下来。',
    '',
    '🔍 **放大镜**',
    '',
    '私下查看当前下一发是实弹还是空包弹。',
    '',
    '🍺 **啤酒**',
    '',
    '直接退出当前子弹，并公开它是实弹还是空包弹。',
    '',
    '🚬 **香烟**',
    '',
    '恢复 1 点生命，最高恢复至 **3 点**。',
    '',
    '每次装弹周期最多使用 1 次。',
    '',
    '🔪 **手锯**',
    '',
    '强化下一次真正的射击。',
    '',
    '如果是实弹，伤害提升至 **2 点**。',
    '',
    '空包弹也会消耗强化。',
    '',
    '⛓️ **手铐**',
    '',
    '让对手的下一次行动机会直接跳过。',
    '',
    '---',
    '',
    '### 👿 败者处罚',
    '',
    '游戏结束后，赢家可以选择：',
    '',
    '🔇 **禁言败者 5 分钟**',
    '',
    '或',
    '',
    '✏️ **给败者改名 10 分钟**',
    '',
    '赢家有 **30 秒**决定处罚。',
    '',
    '超时没有选择，将自动执行：',
    '',
    '**禁言 5 分钟**',
    '',
    '---',
    '',
    '### 🏳️ 投降',
    '',
    '对局开始后可以随时投降。',
    '',
    '投降会经过一次确认。',
    '',
    '确认后立即判负，对手获得处罚权。',
    '',
    '---',
    '',
    '### ⏳ 其他说明',
    '',
    '使用道具**不会暂停或延长你的 60 秒回合**。',
    '',
    '对局正式开始后，双方都会进入本游戏冷却。',
    '',
    '**枪已经放在桌上了。剩下的，看你敢不敢扣扳机。**',
].join('\n');

function invitationRow(game, designated) {
    const row = new ActionRowBuilder();
    if (designated) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_devil_roulette_accept:${game.id}`)
                .setLabel('🔫 接受')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`mystery_devil_roulette_reject:${game.id}`)
                .setLabel('👋 拒绝')
                .setStyle(ButtonStyle.Secondary)
        );
    } else {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_devil_roulette_accept:${game.id}`)
                .setLabel('🪑 坐上赌桌')
                .setStyle(ButtonStyle.Danger)
        );
    }
    row.addComponents(
        new ButtonBuilder()
            .setCustomId(`mystery_devil_roulette_rules:${game.id}`)
            .setLabel('📖 详细规则')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`mystery_devil_roulette_cancel:${game.id}`)
            .setLabel('✖️ 取消邀请')
            .setStyle(ButtonStyle.Secondary)
    );
    return row;
}

function designatedInvitationDescription(initiatorId, opponentId) {
    return [
        '## 👿 恶魔轮盘',
        '',
        `<@${initiatorId}> 把枪推到了 <@${opponentId}> 面前。`,
        '',
        '**双方各有 ❤️❤️❤️，轮流拿起一把装有实弹与空包弹的霰弹枪。**',
        '你可以把枪口对准**对手**，也可以赌一把——**对准自己**。',
        '',
        '🔫 谁先失去全部生命，谁就输掉这局。',
        '🎒 对局中还会获得各种道具，帮你看弹、退弹、回血，或者让下一枪更狠。',
        '',
        '**败者将接受赢家的处罚：禁言 5 分钟，或改名 10 分钟。**',
        '',
        '⏳ 邀请将在 **60秒后**失效。',
        '',
        '**敢坐下吗？**',
    ].join('\n');
}

function openInvitationDescription(initiatorId) {
    return [
        '## 👿 恶魔轮盘',
        '',
        `<@${initiatorId}> 拉开了赌桌对面的椅子。`,
        '',
        '**双方各有 ❤️❤️❤️，轮流拿起一把装有实弹与空包弹的霰弹枪。**',
        '枪可以对准**对手**，也可以对准**自己**。',
        '',
        '🔫 谁先失去全部生命，谁就输掉这局。',
        '🎒 放大镜、啤酒、香烟、手锯、手铐——桌上的东西，都可能救你一命。',
        '',
        '**败者将接受赢家的处罚：禁言 5 分钟，或改名 10 分钟。**',
        '',
        '⏳ **60秒内**没人坐下，这桌就散。',
        '',
        '**还差一个人。**',
    ].join('\n');
}

function invitationPayload(game) {
    const designated = Boolean(game.requestedOpponentId);
    const description = designated
        ? designatedInvitationDescription(game.initiatorId, game.requestedOpponentId)
        : openInvitationDescription(game.initiatorId);
    return {
        embeds: [makeEmbed(description)],
        components: [invitationRow(game, designated)],
    };
}

function turnRow(game) {
    const token = game.turnToken;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`mystery_devil_roulette_shoot:${game.id}:${token}:opponent`)
            .setLabel('🔫 射对手')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`mystery_devil_roulette_shoot:${game.id}:${token}:self`)
            .setLabel('💀 射自己')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`mystery_devil_roulette_items:${game.id}:${token}`)
            .setLabel('🎒 使用道具')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`mystery_devil_roulette_surrender:${game.id}:${token}`)
            .setLabel('🏳️ 投降')
            .setStyle(ButtonStyle.Secondary)
    );
}

// ── 过程面板生命周期 ────────────────────────────────────────────────────────

function trackProcessPanel(game, message, action) {
    if (!message) return;
    game.panelRegistry?.track(message, {
        context: { action, guildId: game.guildId, gameId: game.id },
    });
}

async function publishPublicPanel(game, payload, action, { track = true, invalidatePrevious = true } = {}) {
    // 公开动作默认先失效旧过程面板的按钮（保留消息可见），再发新面板。
    // 道具效果面板不失效旧面板：道具不推进 token，当前回合面板必须保持可用。
    if (track && invalidatePrevious) {
        await game.panelRegistry?.stageAll();
    }
    const message = await queuePublicWrite(game, () => safeSend(game, payload, action));
    if (message && track) trackProcessPanel(game, message, action);
    return message;
}

// ── 射击与回合 ──────────────────────────────────────────────────────────────

function opponentOf(game, userId) {
    return game.participantIds.find(id => id !== userId);
}

function countInventory(game, userId) {
    return game.inventory?.get(userId)?.length ?? 0;
}

function grantItems(game) {
    const random = randomFor(game);
    game.inventory ||= new Map();
    game.cigaretteUsed ||= new Map();
    for (const userId of game.participantIds) {
        const inventory = game.inventory.get(userId) || [];
        // 每人 +2，最多 4；库存 3 只补 1，4 不补。
        const space = Math.max(0, MAX_INVENTORY - inventory.length);
        const grantCount = Math.min(ITEMS_PER_RELOAD, space);
        if (grantCount > 0) {
            inventory.push(...drawItems(grantCount, random));
        }
        game.inventory.set(userId, inventory);
        game.cigaretteUsed.set(userId, false);
    }
}

function installReload(game) {
    const chamber = buildChamber(randomFor(game));
    game.chamber = chamber.rounds;
    game.liveCount = chamber.liveCount;
    game.blankCount = chamber.blankCount;
    game.reloadNumber = (game.reloadNumber || 0) + 1;
    // 手锯与手铐跨 reload 保留；香烟 cycle 重置；道具补充。
    grantItems(game);
    // 重新随机先手。
    const index = Math.floor(randomFor(game)() * game.participantIds.length);
    game.currentTurn = game.participantIds[index];
}

function advanceTurnToken(game) {
    game.turnToken = randomUUID().replaceAll('-', '').slice(0, 12);
}

function clearTurnTimer(game) {
    clearTimer(game, game.turnTimer);
    game.turnTimer = null;
}

function armTurnTimer(game) {
    clearTurnTimer(game);
    // 道具不刷新 deadline：计时器按实际剩余时间（turnDeadlineAt）对齐。
    const delay = Math.max(0, Math.min(game.turnDeadlineAt - nowFor(game), 2 ** 31 - 1));
    const timer = setTimeout(() => {
        game.timers.delete(timer);
        handleTurnTimeout(game).catch(error =>
            logDiscordFailure(game, 'turn-timer', error)
        );
    }, delay);
    timer.unref?.();
    game.timers.add(timer);
    game.turnTimer = timer;
}

function delayTransition(game, delayMs = game.transitionDelayMs ?? TRANSITION_DELAY_MS) {
    return new Promise(resolve => {
        let finished = false;
        let timer;
        const finish = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            game.timers.delete(timer);
            resolve();
        };
        timer = setTimeout(finish, delayMs);
        timer.unref?.();
        game.timers.add(timer);
    });
}

async function startTurn(game, { preserveDeadline = false } = {}) {
    if (!preserveDeadline) {
        game.turnDeadlineAt = nowFor(game) + TURN_DURATION_MS;
    }
    advanceTurnToken(game);
    const payload = {
        embeds: [makeEmbed(turnDescription(game))],
        components: [turnRow(game)],
    };
    await publishPublicPanel(game, payload, 'turn-panel');
    armTurnTimer(game);
}

// 手铐跳过：被铐玩家失去本次行动机会。
async function skipHandcuffedTurn(game, handcuffedId) {
    game.handcuff = null;
    game.turnDeadlineAt = nowFor(game) + TURN_DURATION_MS;
    advanceTurnToken(game);
    const other = opponentOf(game, handcuffedId);
    const description = [
        `⛓️ **轮到 <@${handcuffedId}> 了。**`,
        '',
        '……本来应该是。',
        '',
        '手铐还挂在桌边。',
        '',
        `**<@${handcuffedId}> 的本回合被跳过。**`,
        '',
        `🔫 枪重新回到 <@${other}> 手里。`,
    ].join('\n');
    await publishPublicPanel(game, { embeds: [makeEmbed(description)], components: [] }, 'handcuff-skip');
    await delayTransition(game);
    await startTurn(game);
}

async function beginTurnFor(game, nextUserId) {
    if (game.ended || game.state !== 'playing') return;
    if (game.handcuff === nextUserId) {
        await skipHandcuffedTurn(game, nextUserId);
        return;
    }
    game.currentTurn = nextUserId;
    await startTurn(game);
}

function removeItem(game, userId, item) {
    const inventory = game.inventory.get(userId) || [];
    const index = inventory.indexOf(item);
    if (index !== -1) inventory.splice(index, 1);
    game.inventory.set(userId, inventory);
}

// ── 射击结算 ────────────────────────────────────────────────────────────────

function shootDescription(game, actorId, targetId, bullet, opts = {}) {
    const { saw = false, auto = false } = opts;
    const damage = saw ? 2 : 1;
    if (targetId === actorId) {
        if (bullet === 'live') {
            return [
                '💥 **砰！**',
                '',
                saw ? '💥 **砰！！**\n\n这把锯短的枪，对准的是自己。' : `<@${actorId}> 把枪口顶向了自己。`,
                '',
                `## 🔴 实弹${saw ? ' · 手锯强化' : ''}`,
                '',
                `<@${actorId}> **失去 ${damage} 点生命。**`,
                '',
                '赌错了。',
                '',
                '枪换手。',
            ].join('\n');
        }
        return [
            '**咔哒。**',
            '',
            `<@${actorId}> 对自己扣下扳机。`,
            '',
            '## ⚪ 空包弹',
            '',
            '他还站着。',
            '',
            '**而且枪还在他手上。**',
        ].join('\n');
    }
    if (bullet === 'live') {
        return [
            '💥 **砰！**',
            '',
            saw
                ? `锯短的枪管几乎贴到了 <@${targetId}> 面前。`
                : `<@${actorId}> 把枪口对准了 <@${targetId}>。`,
            '',
            `## 🔴 实弹${saw ? ' · 手锯强化' : ''}`,
            '',
            `<@${targetId}> **失去 ${damage} 点生命。**`,
            '',
            `<@${targetId}>　${'❤️'.repeat(Math.max(0, game.hp?.[targetId] ?? 0))}`,
            '',
            '枪换手。',
        ].join('\n');
    }
    return [
        '**咔哒。**',
        '',
        `<@${actorId}> 对着 <@${targetId}> 扣下扳机。`,
        '',
        '## ⚪ 空包弹',
        '',
        '什么都没发生。',
        '',
        `除了枪现在该交给 <@${targetId}> 了。`,
    ].join('\n');
}

function autoShootDescription(actorId, targetId) {
    return [
        `⏳ **<@${actorId}> 犹豫得太久了。**`,
        '',
        '既然不肯扣扳机——',
        '',
        '**那就让恶魔替你。**',
        '',
        `🔫 枪口自动转向 <@${targetId}>。`,
    ].join('\n');
}

function reloadDescription(game, viaBeer = false) {
    const lines = viaBeer
        ? [
            '🍺 **最后一发也被退了出来。**',
            '',
            '弹仓彻底空了。',
            '',
            '## 🔄 重新装填',
        ]
        : [
            '## 🔄 弹仓空了',
            '',
            '枪被重新拿回桌面中央。',
            '',
            '**咔。咔。咔。**',
            '',
            '新一轮装填：',
        ];
    lines.push(
        '',
        `🔴 实弹 ×${game.liveCount}`,
        `⚪ 空包弹 ×${game.blankCount}`,
        '',
        '🎒 双方获得新的道具。',
        '',
        '🎲 **重新决定先手……**',
    );
    return lines.join('\n');
}

async function performReload(game, viaBeer = false) {
    clearTurnTimer(game);
    installReload(game);
    await publishPublicPanel(
        game,
        { embeds: [makeEmbed(reloadDescription(game, viaBeer))], components: [] },
        'reload-panel'
    );
    await delayTransition(game);
    // reload 后重新随机先手；如果抽中被铐玩家则立即跳过。
    await beginTurnFor(game, game.currentTurn);
}

// 真正开枪（含自动开枪）。所有状态变更在 runExclusive 内认领。
async function performShot(game, input) {
    const { actorId, target: targetChoice, auto = false, turnToken } = input;
    let shot = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') return;
        if (game.turnToken !== turnToken) return;
        if (game.currentTurn !== actorId) return;

        clearTurnTimer(game);

        const bullet = game.chamber.shift();
        const targetId = targetChoice === 'self' ? actorId : opponentOf(game, actorId);
        const sawActive = game.saw === actorId;
        if (sawActive) game.saw = null;
        if (bullet === 'live') {
            game.liveCount -= 1;
        } else {
            game.blankCount -= 1;
        }

        const damage = sawActive ? 2 : 1;
        let hpZero = false;
        let selfBlank = false;
        if (bullet === 'live') {
            const nextHp = Math.max(0, (game.hp?.[targetId] ?? MAX_HP) - damage);
            game.hp[targetId] = nextHp;
            hpZero = nextHp <= 0;
        } else if (targetId === actorId) {
            selfBlank = true;
        }

        game.turnToken = randomUUID().replaceAll('-', '').slice(0, 12);

        shot = {
            actorId,
            targetId,
            bullet,
            sawActive,
            damage,
            auto,
            hpZero,
            selfBlank,
        };
    });

    if (!shot) return false;

    if (auto) {
        await publishPublicPanel(
            game,
            { embeds: [makeEmbed(autoShootDescription(shot.actorId, shot.targetId))], components: [] },
            'auto-shoot-intro'
        );
    }

    const chamberEmpty = game.chamber.length === 0;

    if (shot.hpZero) {
        // 致死：立即进入最终结算，不再有 2 秒过渡。
        return finishWithShotDeath(game, shot);
    }

    const description = shootDescription(game, shot.actorId, shot.targetId, shot.bullet, { saw: shot.sawActive, auto: shot.auto });
    await publishPublicPanel(game, { embeds: [makeEmbed(description)], components: [] }, 'shot-result');

    if (shot.selfBlank) {
        // 射自己空包：继续当前玩家，全新 60 秒；若恰好打空弹仓则先 reload。
        await delayTransition(game);
        if (chamberEmpty) {
            await performReload(game, false);
            return true;
        }
        await beginTurnFor(game, shot.actorId);
        return true;
    }

    await delayTransition(game);
    if (chamberEmpty) {
        await performReload(game, false);
        return true;
    }
    // 射自己实弹：回合交给对方；射对手：回合交给对手。
    const nextUserId = shot.targetId === shot.actorId
        ? opponentOf(game, shot.actorId)
        : shot.targetId;
    await beginTurnFor(game, nextUserId);
    return true;
}

async function finishWithShotDeath(game, shot) {
    const winnerId = opponentOf(game, shot.targetId);
    const loserId = shot.targetId;
    const description = shot.sawActive
        ? [
            '## 👿 恶魔轮盘结束',
            '',
            '💥 **实弹 · 手锯强化**',
            '',
            `这一枪没给 <@${loserId}> 留第二次机会。`,
        ]
        : [
            '## 👿 恶魔轮盘结束',
            '',
            '💥 最后一发是 **🔴 实弹**。',
            '',
            `<@${loserId}> 的最后一颗心熄灭了。`,
        ];
    return concludeGame(game, { winnerId, loserId, introLines: description, shot });
}

// ── 终局与处罚 ──────────────────────────────────────────────────────────────

const PENDING_JUDGMENT_LINES = [
    '',
    `⚖️ **赢家正在决定败者的命运……**`,
];

async function concludeGame(game, { winnerId, loserId, introLines, skipPunishment = false }) {
    clearTurnTimer(game);
    let concluded = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') return;
        game.state = 'ended';
        game.winnerId = winnerId;
        game.loserId = loserId;
        concluded = true;
    });
    if (!concluded) return false;

    const lines = [
        ...introLines,
        '',
        `🏆 <@${winnerId}> **获胜**`,
        `💀 <@${loserId}> **落败**`,
    ];
    // 赢家裁决能力：按 Bot 权限 + loser 锁状态评估。
    const capabilities = !skipPunishment
        ? devilPunishmentService.evaluateCapabilities({ guild: game.guild, loserId })
        : null;
    if (!skipPunishment && capabilities && !capabilities.anyPossible) {
        lines.push('', '⚠️ Bot 当前无法对败者执行处罚。', '', '**本局仅结算胜负。**');
    } else if (!skipPunishment) {
        lines.push(...PENDING_JUDGMENT_LINES);
    }
    const entryComponents = capabilities?.anyPossible
        ? [devilPunishmentService.buildEntryRow(`devil-${game.id}`, game.turnToken)]
        : [];

    const finalMessage = await publishPublicPanel(
        game,
        { embeds: [makeEmbed(lines.join('\n'))], components: entryComponents },
        'final-result',
        { track: false }
    );

    // 解锁游戏锁与过程面板清理：惩罚会话独立于游戏锁继续。
    game.finalMessage = finalMessage;
    if (!skipPunishment && finalMessage && capabilities?.anyPossible) {
        game.punishmentSession = devilPunishmentService.start({
            id: `devil-${game.id}`,
            guildId: game.guildId,
            winnerId,
            loserId,
            effectToken: game.turnToken,
            finalMessage,
            guild: game.guild,
            client: game.guild?.client,
            channelId: game.channelId,
        });
    }
    await cleanupDevilRouletteGame(game, { preserveFinal: true });
    return true;
}

// ── 邀请流程 ────────────────────────────────────────────────────────────────

async function cleanupDevilRouletteGame(game, { preserveFinal = false } = {}) {
    if (!game || game.cleanupPromise) return game?.cleanupPromise;
    game.cleanupStarted = true;
    game.cleanupPromise = (async () => {
        activeGames.delete(game);
        clearTurnTimer(game);
        clearTimer(game, game.invitationTimer);
        game.invitationTimer = null;
        // 所有过程面板（邀请 + 回合 + 动作结果）统一失效按钮后延迟删除；最终结算消息不入 registry，永久保留。
        await game.panelRegistry?.stageAll();
        await gameManager.cleanupGame(game);
        game.panelRegistry?.armAll();
    })().catch(error => {
        logDiscordFailure(game, 'cleanup', error);
    });
    return game.cleanupPromise;
}

function invitationExpiredDescription() {
    return '⌛ **没人坐下。**\n\n枪已经收回去了，本次恶魔轮盘取消。';
}

async function cancelInvitation(game, description, action) {
    let cancelled = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'inviting') return;
        game.state = 'ended';
        clearTimer(game, game.invitationTimer);
        game.invitationTimer = null;
        cancelled = true;
    });
    if (!cancelled) return false;
    await publishPublicPanel(
        game,
        { embeds: [makeEmbed(description)], components: [] },
        action
    );
    await cleanupDevilRouletteGame(game);
    return true;
}

async function expireInvitation(game) {
    return cancelInvitation(game, invitationExpiredDescription(), 'invitation-timeout');
}

// ── 正式开局 ────────────────────────────────────────────────────────────────

const OPENING_LINES = (initiatorId, opponentId) => [
    '## 👿 恶魔轮盘开始',
    '',
    heartLine({ hp: { [initiatorId]: MAX_HP, [opponentId]: MAX_HP } }, initiatorId),
    heartLine({ hp: { [initiatorId]: MAX_HP, [opponentId]: MAX_HP } }, opponentId),
    '',
    '**咔。咔。咔。**',
    '',
    '霰弹枪重新装填……',
];

async function beginGame(game) {
    let began = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'inviting') return;
        game.state = 'playing';
        game.hp = {
            [game.initiatorId]: MAX_HP,
            [game.opponentId]: MAX_HP,
        };
        game.saw = null;
        game.handcuff = null;
        game.surrendered = null;
        installReload(game);
        began = true;
    });
    if (!began) return false;

    // 正式开局：双方进入冷却（由指令层按频道配置写入）。
    try {
        game.onGameStarted?.([game.initiatorId, game.opponentId]);
    } catch (error) {
        logDiscordFailure(game, 'on-game-started', error, game.initiatorId);
    }

    const [a, b] = [game.initiatorId, game.opponentId];
    const opening = [
        ...OPENING_LINES(a, b),
        '',
        `🔴 实弹：**${game.liveCount}**`,
        `⚪ 空包弹：**${game.blankCount}**`,
        '',
        '🎒 双方获得了新的道具。',
        '',
        '🎲 正在决定谁先碰枪……',
    ].join('\n');
    await publishPublicPanel(game, { embeds: [makeEmbed(opening)], components: [] }, 'opening-panel');
    await delayTransition(game);
    await beginTurnFor(game, game.currentTurn);
    return true;
}

// ── 启动入口 ────────────────────────────────────────────────────────────────

async function startDevilRoulette(interaction, requestedOpponent, {
    onGameStarted,
    panelLifecycle = defaultPanelLifecycle,
} = {}) {
    const userId = interaction.user?.id;
    const guildId = interaction.guildId || interaction.guild?.id;
    const channelId = interaction.channelId;
    const provisionalGame = {
        id: randomUUID(),
        type: 'devil_roulette',
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
        panelRegistry: createPanelRegistry({ lifecycle: panelLifecycle }),
        originInteraction: interaction,
        onGameStarted,
        random: Math.random,
        now: Date.now,
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
            await handleDevilRouletteMemberInvalidated(game, invalidUserId, 'member-invalidated');
        }
    };
    provisionalGame.disableComponents = () => {
        clearTurnTimer(game);
        clearTimer(game, game?.invitationTimer);
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
    registerActiveGame(game);

    try {
        const replyResult = await interaction.editReply(invitationPayload(game));
        const responseMessage = replyResult?.resource?.message || replyResult;
        if (typeof responseMessage?.edit === 'function') game.inviteMessage = responseMessage;
    } catch (error) {
        logDiscordFailure(game, 'invitation-panel', error, userId);
        await cleanupDevilRouletteGame(game);
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
    if (!game.inviteMessage) {
        await cleanupDevilRouletteGame(game);
        await rejectDeferredStart(interaction, GENERIC_FAILURE_MESSAGE, game);
        return false;
    }
    game.panelRegistry.track(game.inviteMessage, {
        disablePayload: { components: [] },
        context: { action: 'devil-invitation', guildId, gameId: game.id },
    });

    game.invitationTimer = setTimeout(() => {
        return expireInvitation(game).catch(error => {
            logDiscordFailure(game, 'invitation-timer', error);
            return cleanupDevilRouletteGame(game);
        });
    }, INVITATION_DURATION_MS);
    game.invitationTimer.unref?.();
    game.timers.add(game.invitationTimer);
    return true;
}

// ── 交互解析 ────────────────────────────────────────────────────────────────

function parseParts(parts) {
    const input = (Array.isArray(parts) ? parts : [parts]).filter(part => typeof part === 'string');
    const tokens = input.flatMap(part => part.split(':')).filter(Boolean);
    if (tokens[0]?.startsWith('mystery_devil_roulette_')) {
        tokens[0] = tokens[0].slice('mystery_devil_roulette_'.length);
    }
    while (tokens[0] === 'mystery' || tokens[0] === 'devil' || tokens[0] === 'roulette') tokens.shift();
    return {
        action: tokens[0],
        gameId: tokens[1],
        turnToken: tokens[2],
        argument: tokens[3],
    };
}

// ── 邀请交互 ────────────────────────────────────────────────────────────────

async function handleRulesButton(interaction, game) {
    await safeEphemeralReply(interaction, RULES_DESCRIPTION, game);
    return true;
}

async function handleCancelButton(interaction, game) {
    if (interaction.user?.id !== game.initiatorId) {
        await safeEphemeralReply(interaction, WRONG_INVITEE_MESSAGE, game);
        return false;
    }
    const description = `🪑 <@${game.initiatorId}> 把赌桌收了。\n\n**这枪今天先不响。**`;
    const cancelled = await cancelInvitation(game, description, 'initiator-cancelled');
    if (!cancelled) {
        await safeEphemeralReply(interaction, EXPIRED_MESSAGE, game);
    }
    return cancelled;
}

async function handleRejectButton(interaction, game) {
    const userId = interaction.user?.id;
    if (!game.requestedOpponentId) {
        await safeEphemeralReply(interaction, EXPIRED_MESSAGE, game);
        return false;
    }
    if (userId !== game.requestedOpponentId) {
        await safeEphemeralReply(interaction, WRONG_INVITEE_MESSAGE, game);
        return false;
    }
    let ownsReject = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'inviting') return;
        game.state = 'ended';
        clearTimer(game, game.invitationTimer);
        game.invitationTimer = null;
        ownsReject = true;
    });
    if (!ownsReject) {
        await safeEphemeralReply(interaction, EXPIRED_MESSAGE, game);
        return false;
    }
    const description = [
        `👋 <@${userId}> 看了一眼桌上的枪。`,
        '',
        '**然后把椅子推了回去。**',
        '',
        '本次邀请取消。',
    ].join('\n');
    await publishPublicPanel(game, { embeds: [makeEmbed(description)], components: [] }, 'invite-rejected');
    await cleanupDevilRouletteGame(game);
    return true;
}

async function handleAcceptButton(interaction, game) {
    const userId = interaction.user?.id;
    let rejection = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'inviting') rejection = EXPIRED_MESSAGE;
        else if (userId === game.initiatorId) {
            rejection = game.requestedOpponentId ? SELF_ACCEPT_MESSAGE : SELF_JOIN_MESSAGE;
        } else if (game.requestedOpponentId && userId !== game.requestedOpponentId) {
            rejection = WRONG_INVITEE_MESSAGE;
        }
    });
    if (rejection) {
        await safeEphemeralReply(interaction, rejection, game);
        return false;
    }

    const member = await safeFetchMember(game, userId);
    let accepted = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'inviting') {
            rejection = EXPIRED_MESSAGE;
            return;
        }
        if (userId === game.initiatorId) {
            rejection = game.requestedOpponentId ? SELF_ACCEPT_MESSAGE : SELF_JOIN_MESSAGE;
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
        accepted = true;
    });

    if (!accepted) {
        await safeEphemeralReply(interaction, rejection || EXPIRED_MESSAGE, game);
        return false;
    }

    const began = await beginGame(game);
    if (!began) {
        await safeEphemeralReply(interaction, EXPIRED_MESSAGE, game);
        return false;
    }
    return true;
}

// ── 对局交互 ────────────────────────────────────────────────────────────────

async function handleShootButton(interaction, game, turnToken, targetChoice) {
    const userId = interaction.user?.id;
    let rejection = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') rejection = EXPIRED_MESSAGE;
        else if (game.turnToken !== turnToken) rejection = STALE_PANEL_MESSAGE;
        else if (game.currentTurn !== userId) rejection = NOT_YOUR_TURN_MESSAGE;
    });
    if (rejection) {
        await safeEphemeralReply(interaction, rejection, game);
        return false;
    }
    const shot = await performShot(game, {
        actorId: userId,
        target: targetChoice,
        auto: false,
        turnToken,
    });
    if (!shot) {
        await safeEphemeralReply(interaction, STALE_PANEL_MESSAGE, game);
    }
    return Boolean(shot);
}

function itemButtonsRow(game, turnToken, userId) {
    const counts = new Map();
    for (const item of game.inventory?.get(userId) || []) {
        counts.set(item, (counts.get(item) || 0) + 1);
    }
    const row = new ActionRowBuilder();
    for (const item of ITEM_ORDER) {
        if ((counts.get(item) || 0) === 0) continue;
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_devil_roulette_item:${game.id}:${turnToken}:${item}`)
                .setLabel(`${ITEM_LABELS[item]} ×${counts.get(item)}`)
                .setStyle(ButtonStyle.Secondary)
        );
    }
    return row;
}

function itemPanelDescription(game, userId) {
    return [
        '## 🎒 你的道具',
        '',
        '你可以在本回合继续使用道具。',
        '',
        '⏳ **使用道具不会延长回合时间。**',
        '',
        '**当前持有：**',
        inventoryLine(game, userId) || '（空）',
    ].join('\n');
}

// 道具面板：按钮绑定最新 token；使用道具后原地刷新，
// 同一个私密面板在本回合内可以连续使用多个道具。
function itemPanelPayload(game, userId, turnToken, extraEmbeds = []) {
    const row = itemButtonsRow(game, turnToken, userId);
    const payload = { embeds: [...extraEmbeds, makeEmbed(itemPanelDescription(game, userId))] };
    if (row.components.length > 0) payload.components = [row];
    return payload;
}

async function refreshItemPanel(interaction, game, userId, extraEmbeds = []) {
    return sendPrivate(interaction, itemPanelPayload(game, userId, game.turnToken, extraEmbeds), game);
}

async function handleItemsButton(interaction, game, turnToken) {
    const userId = interaction.user?.id;
    let rejection = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') rejection = EXPIRED_MESSAGE;
        else if (game.turnToken !== turnToken) rejection = STALE_PANEL_MESSAGE;
        else if (game.currentTurn !== userId) rejection = NOT_YOUR_TURN_MESSAGE;
    });
    if (rejection) {
        await safeEphemeralReply(interaction, rejection, game);
        return false;
    }

    await sendPrivate(interaction, itemPanelPayload(game, userId, game.turnToken), game);
    return true;
}

async function handleItemButton(interaction, game, turnToken, item) {
    const userId = interaction.user?.id;
    if (!ITEM_ORDER.includes(item)) {
        await safeEphemeralReply(interaction, STALE_PANEL_MESSAGE, game);
        return false;
    }
    let rejection = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') rejection = EXPIRED_MESSAGE;
        else if (game.turnToken !== turnToken) rejection = STALE_PANEL_MESSAGE;
        else if (game.currentTurn !== userId) rejection = NOT_YOUR_TURN_MESSAGE;
    });
    if (rejection) {
        await safeEphemeralReply(interaction, rejection, game);
        return false;
    }

    if (item === 'magnifier') return useMagnifier(interaction, game, userId, turnToken);
    if (item === 'beer') return useBeer(interaction, game, userId, turnToken);
    if (item === 'cigarette') return useCigarette(interaction, game, userId, turnToken);
    if (item === 'saw') return useSaw(interaction, game, userId, turnToken);
    if (item === 'handcuff') return useHandcuff(interaction, game, userId, turnToken);
    return false;
}

// 道具认领与效果在同一 runExclusive 内原子完成；失败不消耗、不改状态。
// 使用道具不改变 deadline；turnToken 推进使旧道具面板与旧操作面板全部失效。
async function claimItemEffect(game, userId, turnToken, item) {
    const outcome = { ok: false, reason: 'stale', effect: null };
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') return;
        if (game.turnToken !== turnToken || game.currentTurn !== userId) return;

        // 业务拒绝优先（可重试场景给出明确文案），再由库存检查兜底双击安全：
        // 所有道具要么消耗库存、要么设置一次性状态（saw/handcuff/cigarette），
        // 配合 runExclusive 串行，双击不可能重复生效。
        if (item === 'cigarette') {
            if ((game.hp?.[userId] ?? MAX_HP) >= MAX_HP) {
                outcome.reason = 'full_hp';
                return;
            }
            if (game.cigaretteUsed?.get(userId)) {
                outcome.reason = 'cigarette_used';
                return;
            }
        }
        if (item === 'saw') {
            if (game.saw) {
                outcome.reason = 'saw_stacked';
                return;
            }
        }
        if (item === 'handcuff') {
            if (game.handcuff) {
                outcome.reason = 'handcuff_stacked';
                return;
            }
        }

        const inventory = game.inventory.get(userId) || [];
        if (!inventory.includes(item)) return;

        if (item === 'magnifier') {
            const bullet = game.chamber[0] || null;
            if (!bullet) return;
            removeItem(game, userId, item);
            // 道具不推进 turnToken：回合面板保持有效，deadline 不刷新。
            outcome.ok = true;
            outcome.effect = { bullet };
            return;
        }
        if (item === 'beer') {
            const ejected = game.chamber.shift() || null;
            if (!ejected) return;
            if (ejected === 'live') game.liveCount -= 1;
            else game.blankCount -= 1;
            removeItem(game, userId, item);
            outcome.ok = true;
            outcome.effect = { ejected, chamberEmpty: game.chamber.length === 0 };
            return;
        }
        if (item === 'cigarette') {
            removeItem(game, userId, item);
            game.hp[userId] = Math.min(MAX_HP, (game.hp?.[userId] ?? 0) + CIGARETTE_HEAL);
            game.cigaretteUsed.set(userId, true);
            outcome.ok = true;
            outcome.effect = { healed: true };
            return;
        }
        if (item === 'saw') {
            removeItem(game, userId, item);
            game.saw = userId;
            outcome.ok = true;
            outcome.effect = { saw: true };
            return;
        }
        if (item === 'handcuff') {
            const targetId = opponentOf(game, userId);
            removeItem(game, userId, item);
            game.handcuff = targetId;
            outcome.ok = true;
            outcome.effect = { targetId };
            return;
        }
    });
    return outcome;
}

async function useMagnifier(interaction, game, userId, turnToken) {
    const outcome = await claimItemEffect(game, userId, turnToken, 'magnifier');
    if (!outcome.ok) {
        await safeEphemeralReply(interaction, STALE_PANEL_MESSAGE, game);
        return false;
    }
    const { bullet } = outcome.effect;
    const privateDescription = bullet === 'live'
        ? [
            '🔍 **你看清了。**',
            '',
            '当前这一发是：',
            '',
            '## 🔴 实弹',
            '',
            '至于要把枪口对准谁，是另一回事。',
        ].join('\n')
        : [
            '🔍 **你看清了。**',
            '',
            '当前这一发是：',
            '',
            '## ⚪ 空包弹',
            '',
            '这个秘密现在只有你知道。',
        ].join('\n');
    // 私密结果先行（快速），公开面板随后发布；道具不推进 token，回合面板保持有效。
    await refreshItemPanel(interaction, game, userId, [makeEmbed(privateDescription)]);
    await publishPublicPanel(game, {
        embeds: [makeEmbed(`🔍 **<@${userId}> 拿起放大镜看了一眼枪膛。**\n\n他看到了什么？\n\n**只有他自己知道。**`)],
        components: [],
    }, 'magnifier-public', { invalidatePrevious: false });
    return true;
}

async function useBeer(interaction, game, userId, turnToken) {
    const outcome = await claimItemEffect(game, userId, turnToken, 'beer');
    if (!outcome.ok) {
        await safeEphemeralReply(interaction, STALE_PANEL_MESSAGE, game);
        return false;
    }
    const { ejected, chamberEmpty } = outcome.effect;
    const description = ejected === 'live'
        ? `🍺 **<@${userId}> 喝了一口，然后直接拉开了枪机。**\n\n一发 **🔴 实弹** 被退了出来。`
        : `🍺 **<@${userId}> 拉开枪机。**\n\n一发 **⚪ 空包弹** 掉在了桌上。`;
    if (chamberEmpty) {
        await sendPrivate(interaction, { content: '🍺 **已退出当前子弹。**\n弹仓空了，正在重新装填。' }, game);
        await publishPublicPanel(game, { embeds: [makeEmbed(description)], components: [] }, 'beer-eject', { invalidatePrevious: false });
        await performReload(game, true);
        return true;
    }
    await refreshItemPanel(interaction, game, userId);
    await publishPublicPanel(game, { embeds: [makeEmbed(description)], components: [] }, 'beer-eject', { invalidatePrevious: false });
    return true;
}

async function useCigarette(interaction, game, userId, turnToken) {
    const outcome = await claimItemEffect(game, userId, turnToken, 'cigarette');
    if (!outcome.ok) {
        const content = outcome.reason === 'full_hp'
            ? CIGARETTE_FULL_HP_MESSAGE
            : outcome.reason === 'cigarette_used'
                ? CIGARETTE_USED_MESSAGE
                : STALE_PANEL_MESSAGE;
        await safeEphemeralReply(interaction, content, game);
        return false;
    }
    await refreshItemPanel(interaction, game, userId);
    await publishPublicPanel(game, {
        embeds: [makeEmbed(`🚬 **<@${userId}> 点了根烟。**\n\n深吸一口。\n\n❤️ **恢复 1 点生命。**`)],
        components: [],
    }, 'cigarette-use', { invalidatePrevious: false });
    return true;
}

async function useSaw(interaction, game, userId, turnToken) {
    const outcome = await claimItemEffect(game, userId, turnToken, 'saw');
    if (!outcome.ok) {
        const content = outcome.reason === 'saw_stacked' ? SAW_STACKED_MESSAGE : STALE_PANEL_MESSAGE;
        await safeEphemeralReply(interaction, content, game);
        return false;
    }
    await refreshItemPanel(interaction, game, userId);
    await publishPublicPanel(game, {
        embeds: [makeEmbed([
            `🔪 **<@${userId}> 把手锯架在了枪管上。**`,
            '',
            '下一次真正扣下扳机时：',
            '',
            '**🔴 实弹伤害提升至 2 点。**',
            '',
            '空包弹也会消耗这次强化。',
        ].join('\n'))],
        components: [],
    }, 'saw-use', { invalidatePrevious: false });
    return true;
}

async function useHandcuff(interaction, game, userId, turnToken) {
    const outcome = await claimItemEffect(game, userId, turnToken, 'handcuff');
    if (!outcome.ok) {
        const content = outcome.reason === 'handcuff_stacked' ? HANDCUFF_STACKED_MESSAGE : STALE_PANEL_MESSAGE;
        await safeEphemeralReply(interaction, content, game);
        return false;
    }
    await refreshItemPanel(interaction, game, userId);
    await publishPublicPanel(game, {
        embeds: [makeEmbed([
            `⛓️ **<@${userId}> 把 <@${outcome.effect.targetId}> 的一只手铐在了桌边。**`,
            '',
            `<@${outcome.effect.targetId}> 的**下一次行动机会将被跳过。**`,
        ].join('\n'))],
        components: [],
    }, 'handcuff-use', { invalidatePrevious: false });
    return true;
}

// ── 投降 ────────────────────────────────────────────────────────────────────

async function handleSurrenderButton(interaction, game, turnToken) {
    const userId = interaction.user?.id;
    let rejection = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') rejection = EXPIRED_MESSAGE;
        else if (!game.participantIds.includes(userId)) rejection = EXPIRED_MESSAGE;
        else if (game.turnToken !== turnToken) rejection = STALE_PANEL_MESSAGE;
    });
    if (rejection) {
        await safeEphemeralReply(interaction, rejection, game);
        return false;
    }
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`mystery_devil_roulette_surrender_confirm:${game.id}:${turnToken}:yes`)
            .setLabel('🏳️ 确认投降')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`mystery_devil_roulette_surrender_confirm:${game.id}:${turnToken}:no`)
            .setLabel('🔫 继续游戏')
            .setStyle(ButtonStyle.Primary)
    );
    await sendPrivate(interaction, {
        embeds: [makeEmbed(SURRENDER_CONFIRM_PROMPT)],
        components: [row],
    }, game);
    return true;
}

async function handleSurrenderConfirm(interaction, game, turnToken, confirm) {
    const userId = interaction.user?.id;
    if (confirm !== 'yes' && confirm !== 'no') {
        await safeEphemeralReply(interaction, STALE_PANEL_MESSAGE, game);
        return false;
    }
    let rejection = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') rejection = EXPIRED_MESSAGE;
        else if (!game.participantIds.includes(userId)) rejection = EXPIRED_MESSAGE;
        else if (game.turnToken !== turnToken) rejection = STALE_PANEL_MESSAGE;
    });
    if (rejection) {
        await safeEphemeralReply(interaction, rejection, game);
        return false;
    }
    if (confirm === 'no') {
        await safeEphemeralReply(interaction, SURRENDER_CANCEL_MESSAGE, game);
        return true;
    }

    let concluded = false;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') return;
        if (game.turnToken !== turnToken) return;
        concluded = true;
    });
    if (!concluded) {
        await safeEphemeralReply(interaction, STALE_PANEL_MESSAGE, game);
        return false;
    }

    const loserId = userId;
    const winnerId = opponentOf(game, loserId);
    const introLines = [
        `🏳️ **<@${loserId}> 把枪放下了。**`,
        '',
        '他选择离开赌桌。',
    ];
    await safeEphemeralReply(interaction, '🏳️ **你已投降。**', game);
    await concludeGame(game, { winnerId, loserId, introLines });
    return true;
}

// ── 回合超时：自动射对手 ─────────────────────────────────────────────────────

async function handleTurnTimeout(game) {
    let snapshot = null;
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') return;
        snapshot = { actorId: game.currentTurn, turnToken: game.turnToken };
    });
    if (!snapshot) return false;
    await performShot(game, {
        actorId: snapshot.actorId,
        target: 'opponent',
        auto: true,
        turnToken: snapshot.turnToken,
    });
    return true;
}

// ── 成员失效 ────────────────────────────────────────────────────────────────

async function handleDevilRouletteMemberInvalidated(game, userId, reason) {
    if (!game || game.type !== 'devil_roulette') return false;
    let outcome = null;
    await gameManager.runExclusive(game, () => {
        if (
            game.ended
            || !['inviting', 'playing'].includes(game.state)
            || !game.participantIds.includes(userId)
        ) return;
        if (game.state === 'inviting') {
            game.state = 'ended';
            clearTimer(game, game.invitationTimer);
            game.invitationTimer = null;
            outcome = 'invite_cancel';
            return;
        }
        outcome = 'forfeit';
    });
    if (!outcome) return false;
    if (outcome === 'invite_cancel') {
        await publishPublicPanel(game, {
            embeds: [makeEmbed('🧯 **邀请已经失效。**\n\n有参与者离开了服务器，本局取消。')],
            components: [],
        }, 'invite-invalidated');
        await cleanupDevilRouletteGame(game);
        return true;
    }

    const winnerId = opponentOf(game, userId);
    clearTurnTimer(game);
    await gameManager.runExclusive(game, () => {
        if (game.ended || game.state !== 'playing') return;
        game.state = 'ended';
        game.winnerId = winnerId;
        game.loserId = userId;
    });
    const description = [
        '## 👿 恶魔轮盘结束',
        '',
        `🏆 <@${winnerId}> **获胜**`,
        '',
        `<@${userId}> 已经离开服务器，无法继续本局。`,
        '',
        '本局**不执行败者处罚**。',
    ].join('\n');
    const finalMessage = await publishPublicPanel(
        game,
        { embeds: [makeEmbed(description)], components: [] },
        'member-left-final',
        { track: false }
    );
    game.finalMessage = finalMessage;
    await cleanupDevilRouletteGame(game);
    return true;
}

// ── 交互分发 ────────────────────────────────────────────────────────────────

async function handleDevilRouletteInteraction(interaction, parts) {
    const parsed = parseParts(parts);
    const game = parsed.gameId && gameManager.getGame(parsed.gameId);
    if (!await deferEphemeralComponent(interaction, game)) return false;
    if (!game || game.type !== 'devil_roulette') {
        await safeEphemeralReply(interaction, EXPIRED_MESSAGE, game);
        return false;
    }
    if (parsed.action === 'accept') return handleAcceptButton(interaction, game);
    if (parsed.action === 'reject') return handleRejectButton(interaction, game);
    if (parsed.action === 'cancel') return handleCancelButton(interaction, game);
    if (parsed.action === 'rules') return handleRulesButton(interaction, game);
    if (parsed.action === 'shoot') {
        return handleShootButton(interaction, game, parsed.turnToken, parsed.argument);
    }
    if (parsed.action === 'items') return handleItemsButton(interaction, game, parsed.turnToken);
    if (parsed.action === 'item') return handleItemButton(interaction, game, parsed.turnToken, parsed.argument);
    if (parsed.action === 'surrender') return handleSurrenderButton(interaction, game, parsed.turnToken);
    if (parsed.action === 'surrender_confirm') {
        return handleSurrenderConfirm(interaction, game, parsed.turnToken, parsed.argument);
    }
    await safeEphemeralReply(interaction, EXPIRED_MESSAGE, game);
    return false;
}

// ── 重启中止 ────────────────────────────────────────────────────────────────

const activeGames = new Set();

function registerActiveGame(game) {
    activeGames.add(game);
}

// 从 gameManager 的角度无法枚举游戏，这里在创建时登记，cleanup 时移除。
async function shutdownAll() {
    const games = [...activeGames];
    for (const game of games) {
        try {
            let aborted = false;
            await gameManager.runExclusive(game, () => {
                if (game.ended || !['inviting', 'playing'].includes(game.state)) return;
                game.state = 'ended';
                clearTimer(game, game.invitationTimer);
                clearTurnTimer(game);
                aborted = true;
            });
            if (!aborted) continue;
            if (game.state === 'ended' && game.winnerId) continue; // 已结算，不覆盖结果
            try {
                await game.channel?.send({
                    embeds: [makeEmbed([
                        '## ⚠️ 恶魔轮盘已中止',
                        '',
                        'Bot 发生重启，本局无法继续。',
                        '',
                        '**双方均不计胜负，也不会执行任何处罚。**',
                        '',
                        '可以重新发起一局。',
                    ].join('\n'))],
                    components: [],
                });
            } catch (error) {
                logDiscordFailure(game, 'shutdown-notice', error);
            }
        } catch (error) {
            logDiscordFailure(game, 'shutdown', error);
        }
    }
    await Promise.allSettled(games.map(game => cleanupDevilRouletteGame(game)));
}

module.exports = {
    startDevilRoulette,
    handleDevilRouletteInteraction,
    handleDevilRouletteMemberInvalidated,
    registerActiveGame,
    shutdownAll,
    // For testing
    buildChamber,
    rollChamberSize,
    rollChamberComposition,
    rollItem,
    drawItems,
    claimItemEffect,
    performShot,
    ITEM_WEIGHTS,
    ITEM_ORDER,
    INVITATION_DURATION_MS,
    TURN_DURATION_MS,
    MAX_HP,
    MAX_INVENTORY,
    ITEMS_PER_RELOAD,
};
