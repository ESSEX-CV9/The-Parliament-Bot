const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    PermissionFlagsBits,
} = require('discord.js');
const nicknameLock = require('./mysteryNicknameLock');
const { ORDINARY_LOCK_TYPES } = require('./mysteryNicknameLockService');

const PUNISHMENT_CUSTOM_ID_PREFIX = 'mystery_devil_punishment';
const RENAME_MODAL_CUSTOM_ID_PREFIX = 'mystery_devil_rename';
const RENAME_INPUT_ID = 'devil_rename_input';

const DECISION_DURATION_MS = 30_000;
const RENAME_WINDOW_MS = 60_000;
const RENAME_LOCK_DURATION_MS = 10 * 60_000;
const MUTE_DURATION_MS = 5 * 60_000;

const MUTE_REASON = '神秘指令：恶魔轮盘';
const RENAME_APPLY_REASON = '神秘指令：恶魔轮盘 — 赢家裁决改名';
const RENAME_RESTORE_REASON = '神秘指令：恶魔轮盘 — 赢家裁决改名结束';
const RENAME_ENFORCE_REASON = '神秘指令：恶魔轮盘 — 赢家裁决改名';

const NOT_YOUR_RULING_MESSAGE = '🚫 **这不是你的裁决。**';
const RULING_CLOSED_MESSAGE = '⌛ **裁决窗口已经关闭。**';
const RULING_EXPIRED_MESSAGE = '⌛ **裁决已经过期或失效。**';
const EMPTY_NAME_MESSAGE = '✏️ **总得写点什么。**\n纯空格不算名字，再想一个。';
const NAME_TOO_LONG_MESSAGE = '✏️ **名字太长了。**\nDiscord 昵称最多 **32 个字符**。\n削短一点再来。';
const RENAME_LOCKED_MESSAGE = '🤡 **这名字暂时动不了。**\n对方当前还挂着**胆小鬼昵称锁**，这个牌子的优先级比你的改名裁决高。';
const RENAME_FAILED_MESSAGE = '❌ **改名失败。**\nBot 当前无法修改对方的服务器昵称。\n本局处罚不会自动切换成其他选项。';
const RENAME_PERSISTENCE_FAILED_MESSAGE = '❌ **改名保存失败。**\n本局处罚不会自动切换成其他选项。';
const LOSER_UNAVAILABLE_MESSAGE = '❌ **对方已不在服务器或无法被改名。**';
const COWARD_LOCKED_PROMPT = [
    '## 🤡 这名字暂时动不了',
    '',
    '对方当前还挂着**胆小鬼昵称锁**。',
    '这个牌子的优先级比你的改名裁决高。',
    '',
    '本局只能选择：',
    '**🔇 禁言 5 分钟**',
].join('\n');

function createDevilRoulettePunishmentService({
    nicknameLockService = nicknameLock.service,
    nicknameLockStore = nicknameLock.store,
    now = Date.now,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
} = {}) {
    const sessions = new Map();

    function logFailure(operation, session, error) {
        console.error(
            `[DevilRoulettePunishment] ${operation} (session=${session?.id || 'unknown'}, guild=${session?.guildId || 'unknown'}):`,
            error
        );
    }

    function enqueue(session, operation) {
        const next = session.queue.catch(() => undefined).then(operation);
        session.queue = next;
        return next;
    }

    function clearTimer(session, which) {
        const handle = session.timers?.[which];
        if (handle !== undefined && handle !== null) {
            clearTimeoutImpl(handle);
            session.timers[which] = null;
        }
    }

    function scheduleAutoMute(session) {
        clearTimer(session, 'autoMute');
        const handle = setTimeoutImpl(() => {
            session.timers.autoMute = null;
            return expire(session.id).catch(error => {
                logFailure('auto-mute timer', session, error);
            });
        }, Math.min(DECISION_DURATION_MS, 2 ** 31 - 1));
        handle?.unref?.();
        session.timers.autoMute = handle;
    }

    function scheduleRenameExpiry(session) {
        clearTimer(session, 'renameExpiry');
        const handle = setTimeoutImpl(() => {
            session.timers.renameExpiry = null;
            return enqueue(session, async () => {
                if (session.state !== 'rename_chosen') return false;
                // 60 秒未成功提交：自动切换为禁言 5 分钟。
                return claimRenameFallback(session);
            }).catch(error => {
                logFailure('rename-window timer', session, error);
            });
        }, Math.min(RENAME_WINDOW_MS, 2 ** 31 - 1));
        handle?.unref?.();
        session.timers.renameExpiry = handle;
    }

    function makeEmbed(description) {
        return new EmbedBuilder().setDescription(description);
    }

    function buildEntryRow(sessionId, token) {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`${PUNISHMENT_CUSTOM_ID_PREFIX}:${sessionId}:${token}:open`)
                .setLabel('⚖️ 赢家裁决')
                .setStyle(ButtonStyle.Primary)
        );
    }

    function buildDecisionRow(session) {
        const base = `${PUNISHMENT_CUSTOM_ID_PREFIX}:${session.id}:${session.effectToken}`;
        const row = new ActionRowBuilder();
        if (session.canMute) {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`${base}:mute`)
                    .setLabel('🔇 禁言 5 分钟')
                    .setStyle(ButtonStyle.Secondary)
            );
        }
        if (session.canRename) {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`${base}:rename`)
                    .setLabel('✏️ 改名 10 分钟')
                    .setStyle(ButtonStyle.Secondary)
            );
        }
        return row;
    }

    function buildRenameModal(session) {
        const input = new TextInputBuilder()
            .setCustomId(RENAME_INPUT_ID)
            .setLabel('新的服务器昵称')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(32)
            .setPlaceholder('1～32个字符');
        return new ModalBuilder()
            .setCustomId(`${RENAME_MODAL_CUSTOM_ID_PREFIX}:${session.id}:${session.effectToken}`)
            .setTitle('给败者留个名字')
            .addComponents(new ActionRowBuilder().addComponents(input));
    }

    function decisionPrompt(session) {
        const lines = [
            '## 👿 赌桌已经分出胜负',
            '',
            `<@${session.loserId}> 输了。`,
            '',
            '现在轮到你决定，他要从这里带走什么。',
            '',
            '**你有 30 秒。**',
        ];
        if (session.cowardLocked) {
            lines.push('', COWARD_LOCKED_PROMPT);
        } else if (session.canMute && session.canRename) {
            lines.push('', '🔇 **禁言 5 分钟** 或 ✏️ **改名 10 分钟**。');
        } else if (session.canMute) {
            lines.push('', '⚠️ Bot 当前无法修改对方昵称，只能：🔇 **禁言 5 分钟**。');
        } else if (session.canRename) {
            lines.push('', '⚠️ Bot 当前无法禁言对方，只能：✏️ **改名 10 分钟**。');
        }
        return lines.join('\n');
    }

    function muteAppliedDescription(mode) {
        const prefix = mode === 'auto'
            ? '⏳ 赢家迟迟没有下决定。\n\n🔇 **恶魔替他做了选择：败者禁言 5 分钟。**'
            : '🔇 **赢家裁决：败者禁言 5 分钟。**';
        return [prefix, '', '败者 5 分钟后自动解禁。'].join('\n');
    }

    function muteTimeoutFailedDescription(mode) {
        const prefix = mode === 'auto'
            ? '⏳ 赢家迟迟没有下决定，本应自动禁言败者 5 分钟。'
            : '🔇 **赢家裁决：败者应禁言 5 分钟。**';
        return [prefix, '', '⚠️ **禁言处罚执行失败。**\n本局胜负仍然有效。'].join('\n');
    }

    function renameAppliedDescription(name, winnerId, loserId) {
        return [
            '✏️ **赢家将败者改名为：**',
            '',
            `## 「${name}」`,
            '',
            '**持续 10 分钟。**',
            '',
            `—— <@${winnerId}> 的裁决，<@${loserId}> 的新名字。`,
        ].join('\n');
    }

    function renameExpiredDescription() {
        return [
            '⌛ 赢家想了太久，名字最终没写下来。',
            '',
            '🔇 **自动改为禁言 5 分钟。**',
        ].join('\n');
    }

    function renameTimeoutFailedDescription() {
        return [
            '⌛ 赢家想了太久，名字最终没写下来。',
            '',
            '本应自动改为禁言 5 分钟，但：',
            '⚠️ **禁言处罚执行失败。**\n本局胜负仍然有效。',
        ].join('\n');
    }

    function noPunishmentPossibleDescription() {
        return [
            '⚠️ Bot 当前无法对败者执行处罚。',
            '',
            '**本局仅结算胜负。**',
        ].join('\n');
    }

    // 私密裁决面板/回执 2 分钟后自动删除，避免堆积。
    const PRIVATE_TTL_MS = 2 * 60 * 1000;
    const privateDeleteTimers = new Set();

    function schedulePrivateCleanup(message) {
        if (!message || typeof message.delete !== 'function') return;
        const timer = setTimeoutImpl(() => {
            privateDeleteTimers.delete(timer);
            message.delete().catch(() => {});
        }, PRIVATE_TTL_MS);
        timer?.unref?.();
        privateDeleteTimers.add(timer);
    }

    async function safeReply(interaction, payload, fallbackContent) {
        if (!interaction) return false;
        try {
            let message = null;
            if (interaction.deferred && !interaction.replied && typeof interaction.editReply === 'function') {
                await interaction.editReply(payload);
                message = await interaction.fetchReply?.() || null;
            } else if (interaction.replied && typeof interaction.followUp === 'function') {
                message = await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral }) || null;
            } else if (!interaction.replied && typeof interaction.reply === 'function') {
                await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
                message = await interaction.fetchReply?.() || null;
            } else {
                return false;
            }
            schedulePrivateCleanup(message);
            return true;
        } catch (error) {
            logFailure('ephemeral reply', null, error);
            if (fallbackContent && typeof interaction?.reply === 'function') {
                try {
                    await interaction.reply({ content: fallbackContent, flags: MessageFlags.Ephemeral });
                    return true;
                } catch (_) {
                    return false;
                }
            }
            return false;
        }
    }

    async function deferEphemeral(interaction) {
        if (interaction.deferred || interaction.replied || typeof interaction.deferReply !== 'function') {
            return true;
        }
        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            return true;
        } catch (error) {
            logFailure('defer reply', null, error);
            return false;
        }
    }

    async function updateFinalMessage(session, description) {
        if (!session?.finalMessage || typeof session.finalMessage.edit !== 'function') return false;
        try {
            await session.finalMessage.edit({ embeds: [makeEmbed(description)] });
            return true;
        } catch (error) {
            logFailure('update final message', session, error);
            return false;
        }
    }

    async function fetchLoser(session) {
        try {
            return await session.guild?.members?.fetch?.(session.loserId) || null;
        } catch (error) {
            return null;
        }
    }

    // 只延长、绝不缩短：最终 = max(现有到期, now + 5min)。
    async function applyMute(session) {
        const member = await fetchLoser(session);
        if (!member || typeof member.timeout !== 'function') {
            return { ok: false, reason: 'member_missing' };
        }
        try {
            const existingUntil = Number(member.communicationDisabledUntilTimestamp) || 0;
            const until = Math.max(existingUntil, now() + MUTE_DURATION_MS);
            if (until === existingUntil && existingUntil > now()) {
                return { ok: true, already: true };
            }
            await member.timeout(until - now(), MUTE_REASON);
            return { ok: true };
        } catch (error) {
            logFailure('apply mute', session, error);
            return { ok: false, reason: 'timeout_failed' };
        }
    }

    function describeMuteOutcome(session, outcome, mode) {
        if (outcome.ok) return muteAppliedDescription(mode);
        if (outcome.reason === 'timeout_failed') return muteTimeoutFailedDescription(mode);
        return '🔇 **裁决：禁言 5 分钟。**\n\n败者已离开服务器或无法执行禁言。';
    }

    async function claimNoChoice(session) {
        return enqueue(session, async () => {
            if (session.state !== 'pending') return false;
            session.state = 'mute_chosen';
            session.timers.autoMute = null;
            const outcome = await applyMute(session);
            session.state = 'applied';
            await updateFinalMessage(session, describeMuteOutcome(session, outcome, 'auto'));
            return true;
        });
    }

    // 裁决窗口到期：未选择 → 自动禁言。
    async function expire(sessionId) {
        const session = sessions.get(sessionId);
        if (!session) return false;
        return claimNoChoice(session);
    }

    function parsePunishmentButton(customId) {
        const parts = typeof customId === 'string' ? customId.split(':') : [];
        if (
            parts.length !== 4
            || parts[0] !== PUNISHMENT_CUSTOM_ID_PREFIX
            || !parts[1]
            || !parts[2]
            || !['open', 'mute', 'rename'].includes(parts[3])
        ) return null;
        return { sessionId: parts[1], token: parts[2], action: parts[3] };
    }

    function parseRenameModal(customId) {
        const parts = typeof customId === 'string' ? customId.split(':') : [];
        if (
            parts.length !== 3
            || parts[0] !== RENAME_MODAL_CUSTOM_ID_PREFIX
            || !parts[1]
            || !parts[2]
        ) return null;
        return { sessionId: parts[1], token: parts[2] };
    }

    async function handleOpenButton(interaction, session) {
        return enqueue(session, async () => {
            if (session.state !== 'pending' || now() > session.decisionExpiresAt) {
                await safeReply(interaction, { content: RULING_CLOSED_MESSAGE });
                return true;
            }
            await safeReply(interaction, {
                embeds: [makeEmbed(decisionPrompt(session))],
                components: [buildDecisionRow(session)],
            });
            return true;
        });
    }

    async function handleMuteButton(interaction, session) {
        if (!await deferEphemeral(interaction)) return true;
        return enqueue(session, async () => {
            if (session.state !== 'pending' || now() > session.decisionExpiresAt) {
                await safeReply(interaction, { content: RULING_CLOSED_MESSAGE });
                return true;
            }
            session.state = 'mute_chosen';
            clearTimer(session, 'autoMute');
            const outcome = await applyMute(session);
            session.state = 'applied';
            const description = describeMuteOutcome(session, outcome, 'chosen');
            await updateFinalMessage(session, description);
            await safeReply(interaction, { embeds: [makeEmbed(description)] });
            return true;
        });
    }

    async function handleRenameButton(interaction, session) {
        // 先在队列外做快速校验并立刻弹出 modal（避免超过 Discord 3 秒响应窗口）；
        // 状态认领在串行队列内完成，可能被更早的 auto-mute 抢占 → 仍只有一个效果。
        if (session.state !== 'pending' || now() > session.decisionExpiresAt) {
            await safeReply(interaction, { content: RULING_CLOSED_MESSAGE });
            return true;
        }
        if (!session.canRename) {
            await safeReply(interaction, { content: session.cowardLocked ? RENAME_LOCKED_MESSAGE : LOSER_UNAVAILABLE_MESSAGE });
            return true;
        }
        try {
            await interaction.showModal?.(buildRenameModal(session));
        } catch (error) {
            logFailure('show rename modal', session, error);
            return true;
        }
        return enqueue(session, async () => {
            if (session.state !== 'pending' || now() > session.decisionExpiresAt) return false;
            session.state = 'rename_chosen';
            clearTimer(session, 'autoMute');
            session.renameExpiresAt = now() + RENAME_WINDOW_MS;
            scheduleRenameExpiry(session);
            return true;
        });
    }

    // 改名 60 秒窗口到期：自动切换为禁言 5 分钟。
    async function claimRenameFallback(session) {
        session.state = 'mute_chosen';
        const outcome = await applyMute(session);
        session.state = 'applied';
        const description = outcome.ok
            ? renameExpiredDescription()
            : renameTimeoutFailedDescription();
        await updateFinalMessage(session, description);
        return true;
    }

    async function handleRenameSubmit(interaction, session) {
        const rawName = interaction.fields?.getTextInputValue?.(RENAME_INPUT_ID);
        const name = String(rawName ?? '').trim();
        if (!name) {
            await safeReply(interaction, { content: EMPTY_NAME_MESSAGE });
            return true;
        }
        if ([...name].length > 32) {
            await safeReply(interaction, { content: NAME_TOO_LONG_MESSAGE });
            return true;
        }
        if (!await deferEphemeral(interaction)) return true;

        return enqueue(session, async () => {
            // 60 秒 deadline 不因非法输入刷新；超时自动落到禁言。
            if (session.state !== 'rename_chosen') {
                await safeReply(interaction, { content: RULING_EXPIRED_MESSAGE });
                return true;
            }
            if (now() > session.renameExpiresAt) {
                session.state = 'mute_chosen';
                clearTimer(session, 'renameExpiry');
                await claimRenameFallback(session);
                await safeReply(interaction, { content: RULING_EXPIRED_MESSAGE });
                return true;
            }

            const loser = await fetchLoser(session);
            if (!loser) {
                await safeReply(interaction, { content: LOSER_UNAVAILABLE_MESSAGE });
                return true;
            }

            const result = await nicknameLockService.replaceLock({
                member: loser,
                type: 'devil_roulette_rename',
                enforcedNickname: name,
                expiresAt: now() + RENAME_LOCK_DURATION_MS,
                applyReason: RENAME_APPLY_REASON,
                restoreReason: RENAME_RESTORE_REASON,
                enforceReason: RENAME_ENFORCE_REASON,
                channelId: session.channelId,
                expectedTypes: ORDINARY_LOCK_TYPES,
            });

            if (!result.created) {
                if (result.reason === 'existing_lock') {
                    await safeReply(interaction, { content: RENAME_LOCKED_MESSAGE });
                } else if (result.reason === 'persistence_failed') {
                    await safeReply(interaction, { content: RENAME_PERSISTENCE_FAILED_MESSAGE });
                } else if (result.reason === 'missing_permission' || result.reason === 'not_manageable') {
                    await safeReply(interaction, { content: LOSER_UNAVAILABLE_MESSAGE });
                } else {
                    await safeReply(interaction, { content: RENAME_FAILED_MESSAGE });
                }
                // 改名失败不自动换禁言：裁决窗口直接关闭。
                if (session.state === 'rename_chosen') {
                    session.state = 'applied';
                    clearTimer(session, 'renameExpiry');
                }
                return true;
            }

            session.state = 'applied';
            clearTimer(session, 'renameExpiry');
            const description = renameAppliedDescription(name, session.winnerId, session.loserId);
            await updateFinalMessage(session, description);
            await safeReply(interaction, { embeds: [makeEmbed(description)] });
            return true;
        });
    }

    async function handleInteraction(interaction) {
        const customId = interaction?.customId;
        if (typeof customId !== 'string') return false;

        if (customId.startsWith(PUNISHMENT_CUSTOM_ID_PREFIX)) {
            const parsed = parsePunishmentButton(customId);
            if (!parsed) {
                await safeReply(interaction, { content: RULING_EXPIRED_MESSAGE });
                return true;
            }
            const session = sessions.get(parsed.sessionId);
            if (!session || session.effectToken !== parsed.token) {
                await safeReply(interaction, { content: RULING_EXPIRED_MESSAGE });
                return true;
            }
            if (interaction.user?.id !== session.winnerId) {
                await safeReply(interaction, { content: NOT_YOUR_RULING_MESSAGE });
                return true;
            }
            if (parsed.action === 'open') return handleOpenButton(interaction, session);
            if (parsed.action === 'mute') return handleMuteButton(interaction, session);
            if (parsed.action === 'rename') return handleRenameButton(interaction, session);
        }

        if (customId.startsWith(RENAME_MODAL_CUSTOM_ID_PREFIX) && interaction.isModalSubmit?.()) {
            const parsed = parseRenameModal(customId);
            if (!parsed) {
                await safeReply(interaction, { content: RULING_EXPIRED_MESSAGE });
                return true;
            }
            const session = sessions.get(parsed.sessionId);
            if (!session || session.effectToken !== parsed.token) {
                await safeReply(interaction, { content: RULING_EXPIRED_MESSAGE });
                return true;
            }
            if (interaction.user?.id !== session.winnerId) {
                await safeReply(interaction, { content: NOT_YOUR_RULING_MESSAGE });
                return true;
            }
            return handleRenameSubmit(interaction, session);
        }

        return false;
    }

    // 结算时评估 Bot 自身权限与 loser 锁状态（参考死斗机制：成员级 moderatable/
    // manageable 不在面板层预检——成员 fetch 可能因网络波动失败，误伤赐名按钮；
    // 真正的成员级失败在执行时自然暴露并给出对应文案）。
    function evaluateCapabilities({ guild, loserId }) {
        const me = guild?.members?.me || null;
        const canMute = me?.permissions?.has?.(PermissionFlagsBits.ModerateMembers) === true;
        const canRenameBase = me?.permissions?.has?.(PermissionFlagsBits.ManageNicknames) === true;
        const record = nicknameLockStore.get(guild?.id, loserId);
        const cowardLocked = record?.type === 'coward';
        return {
            canMute,
            canRename: canRenameBase && !cowardLocked,
            cowardLocked,
            anyPossible: canMute || (canRenameBase && !cowardLocked),
        };
    }

    function start({
        id,
        guildId,
        winnerId,
        loserId,
        effectToken,
        finalMessage,
        guild,
        client,
        channelId,
    }) {
        const capabilities = evaluateCapabilities({ guild, loserId });
        const session = {
            id,
            guildId,
            winnerId,
            loserId,
            state: capabilities.anyPossible ? 'pending' : 'none',
            effectToken,
            decisionExpiresAt: now() + DECISION_DURATION_MS,
            renameExpiresAt: null,
            finalMessage,
            guild,
            client,
            channelId,
            canMute: capabilities.canMute,
            canRename: capabilities.canRename,
            cowardLocked: capabilities.cowardLocked,
            queue: Promise.resolve(),
            timers: { autoMute: null, renameExpiry: null },
        };
        sessions.set(id, session);
        if (session.state === 'pending') {
            scheduleAutoMute(session);
        } else {
            // 两种处罚都无法执行：只结算胜负。
            void enqueue(session, async () => {
                await updateFinalMessage(session, noPunishmentPossibleDescription());
            });
        }
        return session;
    }

    function getSession(sessionId) {
        return sessions.get(sessionId) || null;
    }

    function resetForTests() {
        for (const session of sessions.values()) {
            clearTimer(session, 'autoMute');
            clearTimer(session, 'renameExpiry');
        }
        sessions.clear();
        for (const timer of privateDeleteTimers) {
            clearTimeoutImpl(timer);
        }
        privateDeleteTimers.clear();
    }

    return {
        PUNISHMENT_CUSTOM_ID_PREFIX,
        RENAME_MODAL_CUSTOM_ID_PREFIX,
        DECISION_DURATION_MS,
        RENAME_WINDOW_MS,
        RENAME_LOCK_DURATION_MS,
        MUTE_DURATION_MS,
        start,
        getSession,
        handleInteraction,
        expire,
        buildEntryRow,
        evaluateCapabilities,
        resetForTests,
    };
}

const defaultService = createDevilRoulettePunishmentService();

module.exports = {
    createDevilRoulettePunishmentService,
    defaultService,
    PUNISHMENT_CUSTOM_ID_PREFIX,
    RENAME_MODAL_CUSTOM_ID_PREFIX,
};
