const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');
const nicknameLock = require('./mysteryNicknameLock');

const PUNISHMENT_CUSTOM_ID_PREFIX = 'mystery_duel_punishment';
const RENAME_MODAL_CUSTOM_ID_PREFIX = 'mystery_duel_rename';
const RENAME_INPUT_ID = 'duel_rename_input';

const DECISION_DURATION_MS = 30_000;
const RENAME_WINDOW_MS = 60_000;
const RENAME_LOCK_DURATION_MS = 5 * 60_000;
const MUTE_DURATION_MS = 3 * 60_000;

const MUTE_REASON = '神秘指令：死斗';
const RENAME_APPLY_REASON = '神秘指令：死斗 — 赢家裁决改名';
const RENAME_RESTORE_REASON = '神秘指令：死斗 — 赢家裁决改名结束';
const RENAME_ENFORCE_REASON = '神秘指令：死斗 — 赢家裁决改名';

const SHIELD_LINE = '🛡️ **但禁言被神秘力量阻挡，未能生效。**';
const NOT_YOUR_RULING_MESSAGE = '🚫 **这不是你的裁决。**';
const RULING_CLOSED_MESSAGE = '⌛ **裁决窗口已经关闭。**';
const RULING_EXPIRED_MESSAGE = '⌛ **裁决已经过期或失效。**';
const GENERIC_FAILURE_MESSAGE = '❌ **处理这次操作时出了点问题，请稍后再试。**';
const EMPTY_NAME_MESSAGE = '✏️ **不能改名为空。**';
const NAME_TOO_LONG_MESSAGE = '✏️ **昵称不能超过 32 个字符（emoji 按 1 个计算）。**';
const RENAME_LOCKED_MESSAGE = '🚫 **对方当前已有其他神秘昵称锁，无法改名。**';
const RENAME_FAILED_MESSAGE = '✏️ **改名未能生效，请稍后重试或选择禁言。**';
const RENAME_PERSISTENCE_FAILED_MESSAGE = '✏️ **改名保存失败，请稍后重试或选择禁言。**';
const LOSER_UNAVAILABLE_MESSAGE = '✏️ **对方已不在服务器或无法被改名。**';

function createDuelPunishmentService({
    nicknameLockService = nicknameLock.service,
    now = Date.now,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
} = {}) {
    const sessions = new Map();

    function logFailure(operation, session, error) {
        console.error(
            `[DuelPunishment] ${operation} (session=${session?.id || 'unknown'}, guild=${session?.guildId || 'unknown'}):`,
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
                session.state = 'expired';
                await updateFinalMessage(session, renameExpiredDescription());
                return true;
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
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`${base}:mute`)
                .setLabel('🔇 禁言 3 分钟')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`${base}:rename`)
                .setLabel('✏️ 改名 5 分钟')
                .setStyle(ButtonStyle.Secondary)
        );
    }

    function buildRenameModal(session) {
        const input = new TextInputBuilder()
            .setCustomId(RENAME_INPUT_ID)
            .setLabel('新的昵称（最多 32 字符）')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(32);
        return new ModalBuilder()
            .setCustomId(`${RENAME_MODAL_CUSTOM_ID_PREFIX}:${session.id}:${session.effectToken}`)
            .setTitle('赢家裁决 — 赐名')
            .addComponents(new ActionRowBuilder().addComponents(input));
    }

    function decisionPrompt(session) {
        return [
            '⚖️ **赢家裁决**',
            '',
            `胜者 <@${session.winnerId}>，请选择对 <@${session.loserId}> 的处罚：`,
            '',
            '🔇 **禁言 3 分钟** 或 ✏️ **改名 5 分钟**。',
            '',
            '不选择的话，30 秒后自动按 **禁言 3 分钟** 处理。',
        ].join('\n');
    }

    function muteAppliedDescription(mode) {
        const prefix = mode === 'auto'
            ? '🔇 **赢家未在 30 秒内选择，败者自动被禁言 3 分钟。**'
            : '🔇 **赢家裁决：败者禁言 3 分钟。**';
        return [prefix, '', '败者 3 分钟后自动解禁。'].join('\n');
    }

    function muteTimeoutFailedDescription(mode) {
        const prefix = mode === 'auto'
            ? '🔇 **赢家未在 30 秒内选择，败者应被禁言 3 分钟。**'
            : '🔇 **赢家裁决：败者应禁言 3 分钟。**';
        return [prefix, '', SHIELD_LINE].join('\n');
    }

    function renameAppliedDescription(name) {
        return [
            '✏️ **赢家裁决：败者被改名为**',
            '',
            `\`${name}\``,
            '',
            '**5 分钟后自动恢复原昵称。**',
        ].join('\n');
    }

    function renameExpiredDescription() {
        return [
            '⌛ **赢家未在限时内完成改名，裁决窗口已关闭。**',
            '',
            '不再自动禁言。',
        ].join('\n');
    }

    async function safeReply(interaction, payload, fallbackContent) {
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

    async function applyMute(session) {
        const member = await fetchLoser(session);
        if (!member || typeof member.timeout !== 'function') {
            return { ok: false, reason: 'member_missing' };
        }
        try {
            await member.timeout(MUTE_DURATION_MS, MUTE_REASON);
            return { ok: true };
        } catch (error) {
            logFailure('apply mute', session, error);
            return { ok: false, reason: 'timeout_failed' };
        }
    }

    function describeMuteOutcome(session, outcome, mode) {
        if (outcome.ok) return muteAppliedDescription(mode);
        if (outcome.reason === 'timeout_failed') return muteTimeoutFailedDescription(mode);
        return '🔇 **裁决：禁言 3 分钟。**\n\n败者已离开服务器或无法执行禁言。';
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
            if (session.state !== 'rename_chosen' || now() > session.renameExpiresAt) {
                await safeReply(interaction, { content: RULING_EXPIRED_MESSAGE });
                return true;
            }

            const loser = await fetchLoser(session);
            if (!loser) {
                await safeReply(interaction, { content: LOSER_UNAVAILABLE_MESSAGE });
                return true;
            }

            const result = await nicknameLockService.createLock({
                member: loser,
                type: 'duel_rename',
                enforcedNickname: name,
                expiresAt: now() + RENAME_LOCK_DURATION_MS,
                originalNickname: loser.nickname ?? null,
                applyReason: RENAME_APPLY_REASON,
                restoreReason: RENAME_RESTORE_REASON,
                enforceReason: RENAME_ENFORCE_REASON,
                channelId: session.channelId,
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
                return true;
            }

            session.state = 'applied';
            clearTimer(session, 'renameExpiry');
            const description = renameAppliedDescription(name);
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
        const session = {
            id,
            guildId,
            winnerId,
            loserId,
            state: 'pending',
            effectToken,
            decisionExpiresAt: now() + DECISION_DURATION_MS,
            renameExpiresAt: null,
            finalMessage,
            guild,
            client,
            channelId,
            queue: Promise.resolve(),
            timers: { autoMute: null, renameExpiry: null },
        };
        sessions.set(id, session);
        scheduleAutoMute(session);
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
        resetForTests,
    };
}

const defaultService = createDuelPunishmentService();

module.exports = {
    createDuelPunishmentService,
    defaultService,
    PUNISHMENT_CUSTOM_ID_PREFIX,
    RENAME_MODAL_CUSTOM_ID_PREFIX,
};
