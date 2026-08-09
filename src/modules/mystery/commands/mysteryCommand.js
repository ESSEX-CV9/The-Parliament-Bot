const {
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder,
} = require('discord.js');
const {
    isOnCooldown,
    startCooldown,
    acquireInFlight,
    releaseInFlight,
} = require('../utils/cooldown');
const gameManager = require('../services/mysteryGameManager');
const { startRoulette } = require('../services/rouletteGame');
const { startBomb } = require('../services/bombGame');
const { startDuel } = require('../services/duelGame');
const { startPressureRoulette } = require('../services/pressureRouletteGame');
const { getNames } = require('../services/namePoolStore');

const SUBCOMMAND_SELF_TIMEOUT = '自刎归天';
const SUBCOMMAND_RANDOM_NICKNAME = '取名字好麻烦';
const SUBCOMMAND_ROULETTE = '运气轮盘';
const SUBCOMMAND_BOMB = '传炸弹';
const SUBCOMMAND_DUEL = '死斗';
const SUBCOMMAND_PRESSURE = '加压轮盘';
const VALID_SUBCOMMANDS = [
    SUBCOMMAND_SELF_TIMEOUT,
    SUBCOMMAND_RANDOM_NICKNAME,
    SUBCOMMAND_ROULETTE,
    SUBCOMMAND_BOMB,
    SUBCOMMAND_DUEL,
    SUBCOMMAND_PRESSURE,
];
const IN_MEMORY_COOLDOWN_SUBCOMMANDS = new Set([
    SUBCOMMAND_SELF_TIMEOUT,
    SUBCOMMAND_RANDOM_NICKNAME,
    SUBCOMMAND_ROULETTE,
    SUBCOMMAND_DUEL,
    SUBCOMMAND_PRESSURE,
]);
const SELF_TIMEOUT_DURATION_MS = 5 * 60 * 1000;
const SELF_TIMEOUT_REASON = '神秘指令：自刎归天';
const COOLDOWN_MESSAGE = '⏳ **这个神秘指令还在冷却中**， **30分钟后才能再次使用**。';
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

async function sendSuccessPanels(interaction, result) {
    try {
        await interaction.editReply({ embeds: [result.publicEmbed] });
    } catch (error) {
        console.error(`[Mystery] 发送公开面板失败 (guild=${interaction.guild.id}, user=${interaction.user.id}):`, error);
        await replacePublicDeferWithPrivateFailure(interaction, result.privateContent);
        return;
    }
    try {
        await interaction.followUp({
            content: result.privateContent,
            flags: MessageFlags.Ephemeral,
        });
    } catch (error) {
        console.error(`[Mystery] 发送私密面板失败 (guild=${interaction.guild.id}, user=${interaction.user.id}):`, error);
    }
}

async function startMultiplayerGame(interaction, subcommand, onGameStarted) {
    if (subcommand === SUBCOMMAND_ROULETTE) {
        return startRoulette(interaction);
    }
    if (subcommand === SUBCOMMAND_BOMB) {
        return startBomb(interaction);
    }
    if (subcommand === SUBCOMMAND_PRESSURE) {
        return startPressureRoulette(interaction, { onGameStarted });
    }
    return startDuel(interaction, interaction.options.getUser('对手'));
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
        lockAcquired = acquireInFlight(guildId, userId, subcommand);
        if (!lockAcquired) {
            await interaction.reply({ content: COOLDOWN_MESSAGE, flags: MessageFlags.Ephemeral });
            return;
        }
        releaseInitiationLock = await acquireInitiationLock(guildId, userId);
        if (gameManager.getPlayerGame(guildId, userId)) {
            await interaction.reply({ content: PLAYER_BUSY_MESSAGE, flags: MessageFlags.Ephemeral });
            return;
        }
        const usesInMemoryCooldown = IN_MEMORY_COOLDOWN_SUBCOMMANDS.has(subcommand);
        if (usesInMemoryCooldown && isOnCooldown(guildId, userId, subcommand)) {
            await interaction.reply({ content: COOLDOWN_MESSAGE, flags: MessageFlags.Ephemeral });
            return;
        }
        const isMultiplayer = subcommand === SUBCOMMAND_ROULETTE
            || subcommand === SUBCOMMAND_BOMB
            || subcommand === SUBCOMMAND_DUEL
            || subcommand === SUBCOMMAND_PRESSURE;
        if (isMultiplayer) {
            // 加压轮盘的冷却推迟到真正开局时才扣：招募人数不足被取消的话不消耗冷却。
            const deferCooldown = subcommand === SUBCOMMAND_PRESSURE;
            const beginCooldown = () => {
                if (usesInMemoryCooldown) startCooldown(guildId, userId, subcommand);
            };
            const started = await startMultiplayerGame(
                interaction,
                subcommand,
                deferCooldown ? beginCooldown : undefined
            );
            if (started && usesInMemoryCooldown && !deferCooldown) {
                startCooldown(guildId, userId, subcommand);
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
        startCooldown(guildId, userId, subcommand);
        await sendSuccessPanels(interaction, result);
    } catch (error) {
        console.error(
            `[Mystery] 执行指令失败 (guild=${guildId || interaction.guild?.id || 'dm'}, user=${userId}, subcommand=${subcommand || 'unknown'}):`,
            error
        );
        await replyWithUnexpectedError(interaction);
    } finally {
        releaseInitiationLock?.();
        if (lockAcquired) releaseInFlight(guildId, userId, subcommand);
    }
}

module.exports = { data, execute };
