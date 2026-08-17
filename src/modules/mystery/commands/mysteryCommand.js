const {
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder,
} = require('discord.js');
const cooldown = require('../utils/cooldown');
const gameManager = require('../services/mysteryGameManager');
const { startRoulette } = require('../services/rouletteGame');
const { startBomb } = require('../services/bombGame');
const { startDuel } = require('../services/duelGame');
const { startDevilRoulette } = require('../services/devilRouletteGame');
const { startPressureRoulette } = require('../services/pressureRouletteGame');
const { getNames } = require('../services/namePoolStore');
const { resolveMysterySettings } = require('../services/channelAccessService');
const { defaultChannelAccessStore } = require('../utils/channelAccessStore');
const { MYSTERY_GAMES, MULTIPLAYER_GAME_NAMES, MYSTERY_GAME_NAMES } = require('../utils/mysteryGames');
const defaultPanelLifecycle = require('../services/panelLifecycle');

const SUBCOMMAND_SELF_TIMEOUT = MYSTERY_GAMES.SELF_TIMEOUT;
const SUBCOMMAND_RANDOM_NICKNAME = MYSTERY_GAMES.RANDOM_NICKNAME;
const SUBCOMMAND_ROULETTE = MYSTERY_GAMES.ROULETTE;
const SUBCOMMAND_BOMB = MYSTERY_GAMES.BOMB;
const SUBCOMMAND_DUEL = MYSTERY_GAMES.DUEL;
const SUBCOMMAND_DEVIL_ROULETTE = MYSTERY_GAMES.DEVIL_ROULETTE;
const SUBCOMMAND_PRESSURE = MYSTERY_GAMES.PRESSURE;
const VALID_SUBCOMMANDS = MYSTERY_GAME_NAMES;
// 传炸弹用的是跨重启持久化的独立冷却存储，其余游戏走内存冷却。
const IN_MEMORY_COOLDOWN_SUBCOMMANDS = new Set(
    MYSTERY_GAME_NAMES.filter(name => name !== SUBCOMMAND_BOMB)
);
const MULTIPLAYER_SUBCOMMANDS = new Set(MULTIPLAYER_GAME_NAMES);
// 这些多人游戏的冷却推迟到正式开局（拒绝/取消/超时不扣）。
const DEFERRED_COOLDOWN_SUBCOMMANDS = new Set([
    SUBCOMMAND_DUEL,
    SUBCOMMAND_DEVIL_ROULETTE,
    SUBCOMMAND_PRESSURE,
]);
const SELF_TIMEOUT_DURATION_MS = 5 * 60 * 1000;
const SELF_TIMEOUT_REASON = '神秘指令：自刎归天';
const PROCESSING_MESSAGE = '⏳ **上一条神秘指令正在处理中。**\n请等上一条处理完成后再试。';
const CHANNEL_ACCESS_DENIED_MESSAGE = '🚫 **此频道未开放神秘指令。**\n可以让管理员调整频道设置，或让本子区/帖子的发起人用 `/神秘指令设置 允许` 开启。';
const TIMEOUT_FAILURE_MESSAGE = '❌ 神秘力量失效了，我无法对你施加禁言。\n可能是机器人权限或身份组层级不足。';
const NICKNAME_FAILURE_MESSAGE = '❌ 名字取好了，但我改不了你的昵称。\n可能是机器人权限或身份组层级不足。';
const GENERIC_FAILURE_MESSAGE = '❌ 处理神秘指令时出现错误，请稍后重试。';
const PLAYER_BUSY_MESSAGE = '🚫 **一心不能二用。**\n你现在已经在一场神秘游戏里，先把那边活着玩完再说。';
const initiationQueues = new Map();

const data = new SlashCommandBuilder()
    .setName('神秘指令')
    .setDescription('触发一个神秘的娱乐效果')
    .addSubcommand(subcommand => subcommand
        .setName(SUBCOMMAND_SELF_TIMEOUT)
        .setDescription('让自己暂时归天五分钟'))
    .addSubcommand(subcommand => subcommand
        .setName(SUBCOMMAND_RANDOM_NICKNAME)
        .setDescription('随机决定自己的服务器昵称'))
    .addSubcommand(subcommand => subcommand
        .setName(SUBCOMMAND_ROULETTE)
        .setDescription('参加一场紧张刺激的运气轮盘'))
    .addSubcommand(subcommand => subcommand
        .setName(SUBCOMMAND_BOMB)
        .setDescription('参加一场紧张刺激的传炸弹游戏'))
    .addSubcommand(subcommand => subcommand
        .setName(SUBCOMMAND_DUEL)
        .setDescription('向一名成员发起死斗，或等待其他人应战')
        .addUserOption(option => option
            .setName('对手')
            .setDescription('指定要挑战的对手（留空则公开招募）')
            .setRequired(false)))
    .addSubcommand(subcommand => subcommand
        .setName(SUBCOMMAND_DEVIL_ROULETTE)
        .setDescription('把枪放在桌上，和一名成员赌一把命运（留空则公屏摆擂）')
        .addUserOption(option => option
            .setName('对手')
            .setDescription('坐在你对面的倒霉蛋（留空则等勇士上桌）')
            .setRequired(false)))
    .addSubcommand(subcommand => subcommand
        .setName(SUBCOMMAND_PRESSURE)
        .setDescription('参加一场加压俄罗斯轮盘，自己往枪里加子弹'));

function botHasPermission(interaction, permission) {
    return interaction.guild.members.me?.permissions?.has(permission) === true;
}

function getPreflightFailure(interaction, subcommand) {
    const member = interaction.member;
    if (subcommand === SUBCOMMAND_SELF_TIMEOUT) {
        return botHasPermission(interaction, PermissionFlagsBits.ModerateMembers) && member?.moderatable
            ? null
            : TIMEOUT_FAILURE_MESSAGE;
    }
    return botHasPermission(interaction, PermissionFlagsBits.ManageNicknames) && member?.manageable
        ? null
        : NICKNAME_FAILURE_MESSAGE;
}

async function replacePublicDeferWithPrivateFailure(interaction, content) {
    try {
        await interaction.deleteReply();
    } catch (error) {
        console.error(`[Mystery] 删除公开等待面板失败 (guild=${interaction.guild.id}, user=${interaction.user.id}):`, error);
        return;
    }
    try {
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } catch (error) {
        console.error(`[Mystery] 发送私密失败面板失败 (guild=${interaction.guild.id}, user=${interaction.user.id}):`, error);
    }
}

async function replyWithUnexpectedError(interaction) {
    try {
        if (interaction.deferred) {
            await replacePublicDeferWithPrivateFailure(interaction, GENERIC_FAILURE_MESSAGE);
        } else if (interaction.replied) {
            await interaction.followUp({ content: GENERIC_FAILURE_MESSAGE, flags: MessageFlags.Ephemeral });
        } else {
            await interaction.reply({ content: GENERIC_FAILURE_MESSAGE, flags: MessageFlags.Ephemeral });
        }
    } catch (replyError) {
        console.error('[Mystery] 回复异常提示失败:', replyError);
    }
}

async function executeSelfTimeout(interaction) {
    try {
        await interaction.member.timeout(SELF_TIMEOUT_DURATION_MS, SELF_TIMEOUT_REASON);
    } catch (error) {
        console.error(`[Mystery] 自刎归天 Timeout 失败 (guild=${interaction.guild.id}, user=${interaction.user.id}):`, error);
        return null;
    }
    return {
        publicEmbed: new EmbedBuilder().setDescription(
            `⚰️ **他选择了结束这一切。**\n\n<@${interaction.user.id}> 已自刎归天，**5分钟后还魂**。`
        ),
        privateContent: '👻 **你已成功归天。**\n\n接下来的 **5分钟**，你将无法在服务器内正常发言。\n\n**5分钟后会自动还魂。**',
    };
}

function selectRandomNickname(names, currentDisplayName) {
    const candidates = names.length > 1
        ? names.filter(name => name !== currentDisplayName)
        : names;
    const effectiveCandidates = candidates.length > 0 ? candidates : names;
    return effectiveCandidates[Math.floor(Math.random() * effectiveCandidates.length)];
}

async function executeRandomNickname(interaction) {
    const member = interaction.member;
    const names = await getNames();
    const selectedName = selectRandomNickname(names, member.displayName);
    try {
        await member.setNickname(selectedName);
    } catch (error) {
        console.error(`[Mystery] 修改昵称失败 (guild=${interaction.guild.id}, user=${interaction.user.id}):`, error);
        return null;
    }
    return {
        publicEmbed: new EmbedBuilder().setDescription(
            `📝 **看得出来你确实懒得取名字。**\n已替你决定：**「${selectedName}」**`
        ),
        privateContent: [
            '✏️ **不喜欢这个名字？**', '', '你可以随时把自己的服务器昵称改回来，本指令不会锁定你的昵称。', '',
            '**电脑 / 网页版**', '右键自己的头像或名字 → **编辑服务器个人资料** → 修改 **服务器昵称** → 保存', '',
            '**手机端**', '在服务器内点击自己的头像 → **编辑服务器个人资料** → 修改 **服务器昵称** → 保存', '',
            '本次改名不会自动恢复。',
        ].join('\n'),
    };
}

async function sendSuccessPanels(interaction, result, panelLifecycle) {
    let publicMessage;
    try {
        const replyResult = await interaction.editReply({ embeds: [result.publicEmbed] });
        publicMessage = replyResult?.resource?.message || replyResult;
    } catch (error) {
        console.error(`[Mystery] 发送公开面板失败 (guild=${interaction.guild.id}, user=${interaction.user.id}):`, error);
        await replacePublicDeferWithPrivateFailure(interaction, result.privateContent);
        return;
    }
    panelLifecycle.deleteMessageAfter(publicMessage, 15_000, {
        action: 'single-player-success',
        guildId: interaction.guild.id,
        userId: interaction.user.id,
    });
    try {
        await interaction.followUp({
            content: result.privateContent,
            flags: MessageFlags.Ephemeral,
        });
    } catch (error) {
        console.error(`[Mystery] 发送私密面板失败 (guild=${interaction.guild.id}, user=${interaction.user.id}):`, error);
    }
}

function cooldownMessage(expiresAt) {
    return `⏳ **这个神秘指令还在冷却中。**\n可再次使用：<t:${Math.floor(expiresAt / 1000)}:R>`;
}

async function startMultiplayerGame(interaction, subcommand, onGameStarted, cooldownMs, services) {
    if (subcommand === SUBCOMMAND_ROULETTE) {
        return services.startRoulette(interaction);
    }
    if (subcommand === SUBCOMMAND_BOMB) {
        return services.startBomb(interaction, { cooldownMs });
    }
    if (subcommand === SUBCOMMAND_PRESSURE) {
        return services.startPressureRoulette(interaction, { onGameStarted });
    }
    if (subcommand === SUBCOMMAND_DEVIL_ROULETTE) {
        return services.startDevilRoulette(interaction, interaction.options.getUser('对手'), { onGameStarted });
    }
    return services.startDuel(interaction, interaction.options.getUser('对手'), { onGameStarted });
}

async function acquireInitiationLock(guildId, userId) {
    const key = `${guildId}:${userId}`;
    const previous = initiationQueues.get(key) || Promise.resolve();
    let releaseGate;
    const gate = new Promise(resolve => {
        releaseGate = resolve;
    });
    initiationQueues.set(key, gate);
    await previous;

    let released = false;
    return () => {
        if (released) return;
        released = true;
        releaseGate();
        if (initiationQueues.get(key) === gate) {
            initiationQueues.delete(key);
        }
    };
}

function createMysteryCommand({
    channelAccessStore = defaultChannelAccessStore,
    cooldown: cooldownUtils = cooldown,
    gameManager: gameManagerImpl = gameManager,
    startRoulette: startRouletteGame = startRoulette,
    startBomb: startBombGame = startBomb,
    startDuel: startDuelGame = startDuel,
    startDevilRoulette: startDevilRouletteGame = startDevilRoulette,
    startPressureRoulette: startPressureRouletteGame = startPressureRoulette,
    panelLifecycle = defaultPanelLifecycle,
} = {}) {
    const services = {
        startRoulette: startRouletteGame,
        startBomb: startBombGame,
        startDuel: startDuelGame,
        startDevilRoulette: startDevilRouletteGame,
        startPressureRoulette: startPressureRouletteGame,
    };

    async function execute(interaction) {
        let guildId = null;
        let userId = interaction.user?.id || 'unknown';
        let subcommand = null;
        let lockAcquired = false;
        let releaseInitiationLock = null;
        try {
            if (!interaction.inGuild()) {
                await interaction.reply({ content: '❌ 此指令只能在服务器中使用。', flags: MessageFlags.Ephemeral });
                return;
            }
            subcommand = interaction.options.getSubcommand(false);
            if (!VALID_SUBCOMMANDS.includes(subcommand)) {
                await interaction.reply({ content: '❌ 未知的神秘指令。', flags: MessageFlags.Ephemeral });
                return;
            }
            guildId = interaction.guild.id;
            userId = interaction.user.id;
            const channelId = interaction.channelId;

            // 三层设置：子区/帖子 → 文字频道/论坛 → 服务器默认，逐级继承。
            await channelAccessStore.ensureLoaded();
            const settings = resolveMysterySettings(
                interaction.channel,
                channelAccessStore.getGuildConfig(guildId),
            );
            if (!settings.allowed) {
                await interaction.reply({ content: CHANNEL_ACCESS_DENIED_MESSAGE, flags: MessageFlags.Ephemeral });
                return;
            }
            // 冷却时长取本频道解析结果；0 表示该频道不进冷却，检查和写入都跳过。
            const { cooldownMs } = settings.cooldownFor(subcommand);
            const cooldownEnabled = Number.isFinite(cooldownMs) && cooldownMs > 0;

            lockAcquired = cooldownUtils.acquireInFlight(guildId, userId, subcommand);
            if (!lockAcquired) {
                await interaction.reply({ content: PROCESSING_MESSAGE, flags: MessageFlags.Ephemeral });
                return;
            }
            releaseInitiationLock = await acquireInitiationLock(guildId, userId);
            if (gameManagerImpl.getPlayerGame(guildId, userId)) {
                await interaction.reply({ content: PLAYER_BUSY_MESSAGE, flags: MessageFlags.Ephemeral });
                return;
            }
            const usesInMemoryCooldown = cooldownEnabled && IN_MEMORY_COOLDOWN_SUBCOMMANDS.has(subcommand);
            const expiresAt = usesInMemoryCooldown
                ? cooldownUtils.getCooldownExpiresAt(guildId, userId, subcommand)
                : null;
            if (expiresAt !== null) {
                await interaction.reply({ content: cooldownMessage(expiresAt), flags: MessageFlags.Ephemeral });
                return;
            }
            const isMultiplayer = MULTIPLAYER_SUBCOMMANDS.has(subcommand);
            if (isMultiplayer) {
                // 死斗/恶魔轮盘/加压轮盘的冷却推迟到正式开局：拒绝/取消/超时/人数不足不扣。
                // 死斗与恶魔轮盘正式开局时双方都进冷却；冷却按 guild+user+game 全服生效。
                const deferCooldown = DEFERRED_COOLDOWN_SUBCOMMANDS.has(subcommand);
                const beginCooldownFor = userIds => {
                    if (!usesInMemoryCooldown) return;
                    for (const targetId of userIds || []) {
                        if (!targetId) continue;
                        cooldownUtils.startCooldown(guildId, targetId, subcommand, cooldownMs);
                    }
                };
                const onGameStarted = deferCooldown && usesInMemoryCooldown
                    ? userIds => beginCooldownFor(userIds?.length ? userIds : [userId])
                    : undefined;
                const started = await startMultiplayerGame(
                    interaction,
                    subcommand,
                    onGameStarted,
                    cooldownEnabled ? cooldownMs : 0,
                    services,
                );
                if (started && usesInMemoryCooldown && !deferCooldown) {
                    cooldownUtils.startCooldown(guildId, userId, subcommand, cooldownMs);
                }
                return;
            }
            const preflightFailure = getPreflightFailure(interaction, subcommand);
            if (preflightFailure) {
                await interaction.reply({ content: preflightFailure });
                return;
            }
            await interaction.deferReply();
            const result = subcommand === SUBCOMMAND_SELF_TIMEOUT
                ? await executeSelfTimeout(interaction)
                : await executeRandomNickname(interaction);
            if (!result) {
                const failureMessage = subcommand === SUBCOMMAND_SELF_TIMEOUT
                    ? TIMEOUT_FAILURE_MESSAGE
                    : NICKNAME_FAILURE_MESSAGE;
                await interaction.editReply({ content: failureMessage });
                return;
            }
            if (usesInMemoryCooldown) {
                cooldownUtils.startCooldown(guildId, userId, subcommand, cooldownMs);
            }
            await sendSuccessPanels(interaction, result, panelLifecycle);
        } catch (error) {
            console.error(
                `[Mystery] 执行指令失败 (guild=${guildId || interaction.guild?.id || 'dm'}, user=${userId}, subcommand=${subcommand || 'unknown'}):`,
                error
            );
            await replyWithUnexpectedError(interaction);
        } finally {
            releaseInitiationLock?.();
            if (lockAcquired) cooldownUtils.releaseInFlight(guildId, userId, subcommand);
        }
    }

    return { data, execute };
}

const command = createMysteryCommand();

module.exports = {
    ...command,
    createMysteryCommand,
};
