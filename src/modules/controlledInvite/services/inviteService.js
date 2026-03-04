const { EmbedBuilder } = require('discord.js');
const {
    getConfigBySubGuild,
    getEligibleRoles,
    isUserBlacklisted,
    isOnCooldown,
    getActiveRequestByOwner,
    createInviteRequest,
    setCooldown,
    tryReserveInviteRequestSlot,
    releaseInviteRequestSlot,
} = require('../utils/controlledInviteDatabase');
const {
    setInviteRuntimeSnapshotProvider,
    recordInviteRequestTrace,
    recordUnknownInteraction,
    recordRetryAttempt,
    recordOverloadRejected,
    recordIdempotentLocked,
    recordLogQueueEvent,
} = require('./metricsService');
const runtimeConfig = require('../utils/runtimeConfig');

const overloadState = {
    totalInflight: 0,
    subInflight: new Map(),
};

const idempotentLockMap = new Map();
const inviteCreateQueues = new Map();

const logQueueState = {
    tail: Promise.resolve(),
    pending: 0,
    running: 0,
    dropped: 0,
};

setInviteRuntimeSnapshotProvider(() => {
    let inviteQueuePending = 0;
    let inviteQueueMaxPendingPerSub = 0;
    for (const state of inviteCreateQueues.values()) {
        inviteQueuePending += state.pending;
        if (state.pending > inviteQueueMaxPendingPerSub) {
            inviteQueueMaxPendingPerSub = state.pending;
        }
    }

    return {
        totalInflight: overloadState.totalInflight,
        activeSubInflight: overloadState.subInflight.size,
        inviteQueuePending,
        inviteQueueMaxPendingPerSub,
        logQueuePending: logQueueState.pending,
        logQueueRunning: logQueueState.running,
        logQueueDropped: logQueueState.dropped,
    };
});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeReplyPayload(payload) {
    if (typeof payload === 'string') {
        return { content: payload };
    }
    return payload || { content: '' };
}

function isUnknownInteractionError(err) {
    const code = err?.code ?? err?.rawError?.code;
    return code === 10062;
}

function isRetryableError(err) {
    const status = err?.status ?? err?.rawError?.status;
    if (status === 429) return true;
    if (typeof status === 'number' && status >= 500) return true;

    const code = err?.code || err?.cause?.code;
    if (typeof code === 'string') {
        return ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
    }

    return false;
}

function isSqliteConstraintError(err) {
    const code = String(err?.code || '');
    const message = String(err?.message || '');
    return code.includes('SQLITE_CONSTRAINT') || message.includes('SQLITE_CONSTRAINT');
}

async function withRetry(task, { maxAttempts, baseDelayMs, label }) {
    let attempt = 0;

    while (attempt < maxAttempts) {
        attempt += 1;
        try {
            return await task();
        } catch (err) {
            if (attempt >= maxAttempts || !isRetryableError(err)) {
                throw err;
            }
            const statusCode = err?.status ?? err?.rawError?.status ?? null;
            recordRetryAttempt(statusCode);


            const delay = Math.min(baseDelayMs * (2 ** (attempt - 1)), 3000) + Math.floor(Math.random() * 120);
            console.warn(`[ControlledInvite] ${label} 失败，准备重试 (${attempt}/${maxAttempts})，${delay}ms 后重试:`, err?.message || err);
            await sleep(delay);
        }
    }

    throw new Error(`[ControlledInvite] ${label} 重试结束但未成功`);
}

async function safeDeferReply(interaction) {
    if (interaction.deferred || interaction.replied) return true;

    try {
        await interaction.deferReply({ ephemeral: true });
        return true;
    } catch (err) {
        if (isUnknownInteractionError(err)) {
            console.warn('[ControlledInvite] deferReply 失败: interaction 已失效(10062)');
            recordUnknownInteraction();
            return false;
        }
        throw err;
    }
}

async function safeReply(interaction, payload) {
    const data = normalizeReplyPayload(payload);

    try {
        if (interaction.deferred || interaction.replied) {
            const { ephemeral, ...editPayload } = data;
            return await interaction.editReply(editPayload);
        }

        return await interaction.reply({ ephemeral: true, ...data });
    } catch (err) {
        if (isUnknownInteractionError(err)) {
            console.warn('[ControlledInvite] 回复失败: interaction 已失效(10062)');
            recordUnknownInteraction();
            return null;
        }
        throw err;
    }
}

function getSubInflightCount(subGuildId) {
    return overloadState.subInflight.get(subGuildId) || 0;
}

function tryAcquireOverloadSlot(subGuildId) {
    const totalInflight = overloadState.totalInflight;
    const subGuildInflight = getSubInflightCount(subGuildId);

    if (totalInflight >= runtimeConfig.get('globalMaxInflight') || subGuildInflight >= runtimeConfig.get('subMaxInflight')) {
        return { ok: false, totalInflight, subGuildInflight };
    }

    overloadState.totalInflight += 1;
    overloadState.subInflight.set(subGuildId, subGuildInflight + 1);
    return { ok: true };
}

function releaseOverloadSlot(subGuildId) {
    overloadState.totalInflight = Math.max(0, overloadState.totalInflight - 1);
    const nextSubInflight = getSubInflightCount(subGuildId) - 1;
    if (nextSubInflight > 0) overloadState.subInflight.set(subGuildId, nextSubInflight);
    else overloadState.subInflight.delete(subGuildId);
}

function acquireIdempotentLock(lockKey, ttlMs) {
    const now = Date.now();
    const existingExpireAt = idempotentLockMap.get(lockKey);

    if (existingExpireAt && existingExpireAt > now) {
        return false;
    }

    idempotentLockMap.set(lockKey, now + ttlMs);
    return true;
}

function releaseIdempotentLock(lockKey) {
    idempotentLockMap.delete(lockKey);
}

function getQueueState(subGuildId) {
    let state = inviteCreateQueues.get(subGuildId);
    if (!state) {
        state = {
            tail: Promise.resolve(),
            pending: 0,
            running: 0,
        };
        inviteCreateQueues.set(subGuildId, state);
    }
    return state;
}

function enqueueInviteCreateTask(subGuildId, task) {
    const state = getQueueState(subGuildId);
    const queuedAt = Date.now();
    state.pending += 1;

    const runTask = async () => {
        state.pending = Math.max(0, state.pending - 1);
        state.running += 1;
        const queueDepthBeforeRun = state.pending;

        try {
            return await task({
                queuedMs: Date.now() - queuedAt,
                queueDepthBeforeRun,
            });
        } finally {
            state.running = Math.max(0, state.running - 1);
            if (state.pending === 0 && state.running === 0) {
                inviteCreateQueues.delete(subGuildId);
            }
        }
    };

    const next = state.tail.then(runTask, runTask);
    state.tail = next.catch(() => {});
    return next;
}

function enqueueLogTask(task) {
    const queueDepthBeforeEnqueue = logQueueState.pending;
    if (logQueueState.pending >= runtimeConfig.get('logQueueMaxPending')) {
        logQueueState.dropped += 1;
        recordLogQueueEvent('dropped', {
            pending: logQueueState.pending,
            dropped: logQueueState.dropped,
        });
        console.warn(`[ControlledInvite] 日志队列已满，丢弃日志。pending=${logQueueState.pending}, dropped=${logQueueState.dropped}`);
        return false;
    }

    logQueueState.pending += 1;
    recordLogQueueEvent('enqueued', { pending: logQueueState.pending });

    if (logQueueState.pending >= runtimeConfig.get('logQueueWarnThreshold')) {
        console.warn(`[ControlledInvite] 日志队列积压告警: pending=${logQueueState.pending}, threshold=${runtimeConfig.get('logQueueWarnThreshold')}`);
    }

    const runTask = async () => {
        logQueueState.pending = Math.max(0, logQueueState.pending - 1);
        logQueueState.running += 1;

        try {
            await task({ queueDepthBeforeEnqueue });
            recordLogQueueEvent('sent', { pending: logQueueState.pending, running: logQueueState.running });
        } catch (err) {
            recordLogQueueEvent('failed', { pending: logQueueState.pending, running: logQueueState.running });
            throw err;
        } finally {
            logQueueState.running = Math.max(0, logQueueState.running - 1);
        }
    };

    const next = logQueueState.tail.then(runTask, runTask);
    logQueueState.tail = next.catch(() => {});
    return true;
}

function createTrace(interaction, subGuildId) {
    const startAt = Date.now();
    const traceId = `${subGuildId}:${interaction.user?.id || 'unknown'}:${startAt.toString(36)}`;
    const marks = {};

    return {
        id: traceId,
        queueWaitMs: 0,
        queueDepthAtRun: 0,
        outcome: 'unknown',
        mark(name) {
            marks[name] = Date.now();
        },
        finish(extra = {}) {
            const now = Date.now();
            const totalMs = now - startAt;
            const ackMs = marks.ack ? marks.ack - startAt : -1;
            const validationMs = marks.validationDone && marks.ack ? marks.validationDone - marks.ack : -1;
            const createMs = marks.createDone && marks.createStart ? marks.createDone - marks.createStart : -1;
            const dbMs = marks.dbDone && marks.dbStart ? marks.dbDone - marks.dbStart : -1;

            recordInviteRequestTrace({
                traceId,
                outcome: this.outcome,
                totalMs,
                ackMs,
                validationMs,
                queueWaitMs: this.queueWaitMs,
                queueDepthAtRun: this.queueDepthAtRun,
                createMs,
                dbMs,
                error: extra.error || null,
            });

            console.log(
                `[ControlledInvite][Trace:${traceId}] outcome=${this.outcome} total=${totalMs}ms ack=${ackMs}ms validate=${validationMs}ms queueWait=${this.queueWaitMs}ms queueDepth=${this.queueDepthAtRun} create=${createMs}ms db=${dbMs}ms${extra.error ? ` error=${extra.error}` : ''}`
            );
        },
    };
}

/**
 * 处理按钮点击申请邀请码
 * customId 格式: ci_request:{sub_guild_id}
 */
async function handleInviteRequest(interaction) {
    const customId = interaction.customId;
    const subGuildId = customId.replace('ci_request:', '');
    const trace = createTrace(interaction, subGuildId);

    const admission = tryAcquireOverloadSlot(subGuildId);
    if (!admission.ok) {
        trace.outcome = 'overload_rejected';
        recordOverloadRejected();
        console.warn(
            `[ControlledInvite] 🚦 过载保护触发: sub=${subGuildId}, global=${admission.totalInflight}/${runtimeConfig.get('globalMaxInflight')}, subInflight=${admission.subGuildInflight}/${runtimeConfig.get('subMaxInflight')}`
        );

        await safeReply(interaction, { content: '🚦 当前申请人数过多，系统正在排队处理，请稍后 15~30 秒再试。' });
        trace.finish();
        return;
    }

    const lockKey = `${interaction.guildId || 'unknownGuild'}:${subGuildId}:${interaction.user.id}`;
    if (!acquireIdempotentLock(lockKey, runtimeConfig.get('idempotentLockTtlMs'))) {
        trace.outcome = 'idempotent_locked';
        recordIdempotentLocked();
        await safeReply(interaction, { content: '⏳ 你的申请正在处理中，请勿重复点击按钮。' });
        releaseOverloadSlot(subGuildId);
        trace.finish();
        return;
    }

    let reservationAcquired = false;
    let reservationContext = null;
    let traceError = null;

    try {
        const ackOk = await safeDeferReply(interaction);
        if (!ackOk) {
            trace.outcome = 'ack_failed';
            return;
        }
        trace.mark('ack');

        // 1. 查找配置
        const config = getConfigBySubGuild(subGuildId);
        if (!config) {
            trace.outcome = 'config_not_found';
            await safeReply(interaction, { content: '❌ 系统配置异常，请联系管理员' });
            return;
        }

        const mainGuildId = config.main_guild_id;
        const userId = interaction.user.id;

        // 2. 校验配置启用
        if (!config.enabled) {
            trace.outcome = 'config_disabled';
            await safeReply(interaction, { content: '❌ 受控邀请功能当前已禁用' });
            return;
        }

        // 3. 校验邀请码频道已设置
        if (!config.sub_invite_channel_id) {
            trace.outcome = 'invite_channel_missing';
            await safeReply(interaction, { content: '❌ 系统尚未完成配置（缺少邀请码频道），请联系管理员' });
            return;
        }

        // 4. 校验黑名单
        if (isUserBlacklisted(mainGuildId, userId, subGuildId)) {
            trace.outcome = 'blacklisted';
            await safeReply(interaction, { content: '🚫 你已被禁止申请邀请码' });
            return;
        }

        // 5. 校验冷却
        const cooldownInfo = isOnCooldown(mainGuildId, subGuildId, userId);
        if (cooldownInfo.onCooldown) {
            trace.outcome = 'cooldown';
            const cdTs = Math.floor(new Date(cooldownInfo.nextAvailableAt).getTime() / 1000);
            await safeReply(interaction, { content: `⏳ 冷却中，请等待至 <t:${cdTs}:R> 后再试` });
            return;
        }

        // 6. 校验资格身份组
        const eligibleRoles = getEligibleRoles(mainGuildId);
        if (eligibleRoles.length > 0) {
            const memberRoles = interaction.member.roles.cache.map(r => r.id);
            const hasEligible = eligibleRoles.some(roleId => memberRoles.includes(roleId));
            if (!hasEligible) {
                trace.outcome = 'role_not_eligible';
                await safeReply(interaction, {
                    content: '❌ 你没有申请资格，需要以下身份组之一：\n' + eligibleRoles.map(r => `<@&${r}>`).join(', '),
                });
                return;
            }
        }

        // 7. 校验是否已在分服
        try {
            const subGuild = await interaction.client.guilds.fetch(subGuildId).catch(() => null);
            if (subGuild) {
                const member = await subGuild.members.fetch(userId).catch(() => null);
                if (member) {
                    trace.outcome = 'already_in_subguild';
                    await safeReply(interaction, { content: '❌ 你已经在分服中，无需申请邀请码' });
                    return;
                }
            }
        } catch {
            // 无法访问分服，继续
        }

        // 8. DB层并发一致性：预占位（事务）
        const reservationResult = tryReserveInviteRequestSlot(
            mainGuildId,
            subGuildId,
            userId,
            runtimeConfig.get('reservationTtlSeconds')
        );

        if (!reservationResult.ok) {
            if (reservationResult.reason === 'existing_active' && reservationResult.existingRequest) {
                trace.outcome = 'existing_active_on_reserve';
                const expiresTs = Math.floor(new Date(reservationResult.existingRequest.expires_at).getTime() / 1000);
                await safeReply(interaction, {
                    content: `❌ 你已有一个未过期的邀请码：\n🔗 ${reservationResult.existingRequest.invite_url}\n⏱️ 过期时间: <t:${expiresTs}:R>`,
                });
            } else {
                trace.outcome = 'already_reserved';
                await safeReply(interaction, { content: '⏳ 你的申请正在处理中，请勿重复点击按钮。' });
            }
            return;
        }

        reservationAcquired = true;
        reservationContext = { mainGuildId, subGuildId, userId };
        trace.mark('validationDone');

        // 9. 入队创建邀请码（分服队列）
        const queueResult = await enqueueInviteCreateTask(subGuildId, async ({ queuedMs, queueDepthBeforeRun }) => {
            trace.queueWaitMs = queuedMs;
            trace.queueDepthAtRun = queueDepthBeforeRun;

            const existingAfterQueue = getActiveRequestByOwner(mainGuildId, subGuildId, userId);
            if (existingAfterQueue) {
                return { kind: 'existing', request: existingAfterQueue };
            }

            const subGuild = await interaction.client.guilds.fetch(subGuildId);
            const inviteChannel = await subGuild.channels.fetch(config.sub_invite_channel_id);

            trace.mark('createStart');
            const invite = await withRetry(
                () => inviteChannel.createInvite({
                    maxAge: config.invite_max_age_seconds,
                    maxUses: 1,
                    unique: true,
                    reason: `受控邀请 - 申请人: ${interaction.user.tag} (${userId})`,
                }),
                {
                    maxAttempts: runtimeConfig.get('retryMaxAttempts'),
                    baseDelayMs: runtimeConfig.get('retryBaseDelayMs'),
                    label: `createInvite(${subGuildId})`,
                }
            );
            trace.mark('createDone');

            const expiresAt = new Date(Date.now() + config.invite_max_age_seconds * 1000).toISOString();

            trace.mark('dbStart');
            try {
                createInviteRequest({
                    mainGuildId,
                    subGuildId,
                    ownerUserId: userId,
                    inviteCode: invite.code,
                    inviteUrl: invite.url,
                    expiresAt,
                });
            } catch (dbErr) {
                if (isSqliteConstraintError(dbErr)) {
                    await invite.delete('受控邀请: 并发冲突，回收重复邀请码').catch(() => {});
                    const existingAfterConflict = getActiveRequestByOwner(mainGuildId, subGuildId, userId);
                    if (existingAfterConflict) {
                        return { kind: 'existing', request: existingAfterConflict };
                    }
                }
                throw dbErr;
            }

            const nextAvailable = new Date(Date.now() + config.cooldown_seconds * 1000).toISOString();
            setCooldown(mainGuildId, subGuildId, userId, nextAvailable);
            trace.mark('dbDone');

            return {
                kind: 'created',
                invite,
                expiresAt,
                subName: subGuild.name,
                config,
            };
        });

        if (queueResult.kind === 'existing') {
            trace.outcome = 'existing_after_queue';
            const expiresTs = Math.floor(new Date(queueResult.request.expires_at).getTime() / 1000);
            await safeReply(interaction, {
                content: `❌ 你已有一个未过期的邀请码：\n🔗 ${queueResult.request.invite_url}\n⏱️ 过期时间: <t:${expiresTs}:R>`,
            });
            return;
        }

        const expiresTs = Math.floor(new Date(queueResult.expiresAt).getTime() / 1000);
        const embed = new EmbedBuilder()
            .setTitle('🔗 邀请码已生成')
            .setDescription([
                `**目标分服**: ${queueResult.subName}`,
                `**邀请链接**: ${queueResult.invite.url}`,
                `**过期时间**: <t:${expiresTs}:R>`,
                '',
                '> ⚠️ 此邀请码仅限本人使用，请勿分享给他人。',
                '> 分享邀请码将导致您被永久禁止再次获取邀请码。',
            ].join('\n'))
            .setColor(0x57F287)
            .setTimestamp();

        await safeReply(interaction, { embeds: [embed] });

        // 10. 发送日志
        await sendLog(interaction.client, queueResult.config, `📋 **邀请码申请**\n用户: <@${userId}>\n分服: ${queueResult.subName}\n邀请码: \`${queueResult.invite.code}\`\n过期: <t:${expiresTs}:R>`);
        trace.outcome = 'success';
    } catch (err) {
        trace.outcome = 'failed';
        console.error('[ControlledInvite] 创建邀请码失败:', err);
        traceError = err?.message || String(err);
        await safeReply(interaction, { content: `❌ 创建邀请码失败: ${err.message}` });
    } finally {
        if (reservationAcquired && reservationContext) {
            releaseInviteRequestSlot(
                reservationContext.mainGuildId,
                reservationContext.subGuildId,
                reservationContext.userId
            );
        }
        releaseIdempotentLock(lockKey);
        releaseOverloadSlot(subGuildId);
        trace.finish(traceError ? { error: traceError } : {});
    }
}

/**
 * 根据日志内容判断重要程度颜色
 */
function resolveLogColor(message) {
    if (!message) return 0x5865F2; // 默认蓝色

    // 高危/错误
    if (
        message.includes('🔴') ||
        message.includes('❌') ||
        message.includes('封禁') ||
        message.includes('拉黑') ||
        message.includes('异常') ||
        message.includes('非法')
    ) {
        return 0xED4245;
    }

    // 警告
    if (
        message.includes('⚠️') ||
        message.includes('🟡') ||
        message.includes('疑似') ||
        message.includes('踢出')
    ) {
        return 0xFEE75C;
    }

    // 成功
    if (message.includes('✅')) {
        return 0x57F287;
    }

    // 信息
    return 0x5865F2;
}

/**
 * 发送日志到配置的日志频道
 */
async function sendLog(client, config, message) {
    if (!config.log_channel_id) return false;

    const lines = String(message || '').split('\n');
    const firstLine = lines[0] || '受控邀请日志';
    const detail = lines.slice(1).join('\n').trim();

    const title = firstLine.replace(/\*\*/g, '').trim() || '受控邀请日志';
    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(detail || '（无详细内容）')
        .setColor(resolveLogColor(message))
        .setFooter({ text: `主服 ${config.main_guild_id} · 分服 ${config.sub_guild_id}` })
        .setTimestamp();

    const enqueued = enqueueLogTask(async () => {
        try {
            const channel = await client.channels.fetch(config.log_channel_id).catch(() => null);
            if (channel) {
                await channel.send({ embeds: [embed] });
            }
        } catch (err) {
            console.error('[ControlledInvite] 发送日志失败:', err);

            // 尝试降级为纯文本，避免日志完全丢失
            try {
                const channel = await client.channels.fetch(config.log_channel_id).catch(() => null);
                if (channel) {
                    await channel.send(`【受控邀请日志发送失败，降级文本】\n${message}`);
                }
            } catch (_) {}

            throw err;
        }
    });

    if (!enqueued) {
        return false;
    }

    return true;
}

module.exports = { handleInviteRequest, sendLog };
