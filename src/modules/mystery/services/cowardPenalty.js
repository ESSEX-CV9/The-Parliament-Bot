const { PermissionFlagsBits } = require('discord.js');
const nicknameLock = require('./mysteryNicknameLock');
const { ORDINARY_LOCK_TYPES } = require('./mysteryNicknameLockService');
const panels = require('./pressureRoulettePanels');

const COWARD_PREFIX = '🤡胆小鬼 ';
const NICKNAME_MAX_LENGTH = 32;
// 游戏结束后 🤡 至少还要再挂这么久；退出那一刻的赌注更长时按赌注算。
const MIN_AFTER_GAME_MINUTES = 5;
const AFTER_GAME_MS = MIN_AFTER_GAME_MINUTES * 60 * 1000;
const HARD_CAP_MS = 60 * 60 * 1000;
const TAUNT_COOLDOWN_MS = 20 * 1000;
const APPLY_REASON = '神秘指令：加压俄罗斯轮盘 — 胆小鬼';
const RESTORE_REASON = '神秘指令：加压俄罗斯轮盘 — 胆小鬼惩罚结束';
const ENFORCE_REASON = '神秘指令：加压俄罗斯轮盘 — 胆小鬼试图改名';

const QUIT_TAUNTS = [
    userId => `🤡 <@${userId}> 下车了。\n车都还没停稳。`,
    userId => `🤡 <@${userId}> 放下枪，举起双手，缓缓后退，一气呵成。`,
    userId => `🤡 <@${userId}> 弃权。\n理由那一栏填的是「怕」。`,
    userId => `🤡 <@${userId}> 突然想起家里燃气好像没关。`,
    userId => `🤡 <@${userId}> 光速退出，原地留下一个人形烟雾。`,
    userId => `🤡 <@${userId}> 跑了。\n跑姿标准，看得出来练过。`,
    userId => `🤡 <@${userId}> 选择了活着。\n非常正确，也非常没意思。`,
    userId => `🤡 <@${userId}> 退出了。\n左轮：？`,
    userId => `🤡 <@${userId}>：我觉得我们可以用更和平的方式解决问题。\n翻译：怕。`,
    userId => `🤡 <@${userId}> 把枪放回桌上，动作轻得像在放婴儿。`,
    userId => `🤡 <@${userId}> 保命成功。\n代价是这个名字。`,
    userId => `🤡 <@${userId}> 撤了。\n他的位置上现在只剩一个 🤡。`,
];

const RENAME_TAUNTS = [
    userId => `🤡 <@${userId}> 想把名字改回去。\n手速很快。刚才扣扳机的时候怎么没见你这么快。`,
    userId => `🤡 <@${userId}> 改名失败。\n我盯着呢。`,
    userId => `🤡 <@${userId}>：改。\n我：改回来。\n<@${userId}>：改。\n我：改回来。\n（此处省略十回合）`,
    userId => `🤡 <@${userId}> 正在试图销毁证据。\n证据表示它哪也不去。`,
    userId => `🤡 <@${userId}> 又改了一次。\n这是今天第几次了，我都替你累。`,
    userId => `🤡 <@${userId}> 名字已归位。\n请坐好，还有几分钟。`,
    userId => `🤡 <@${userId}> 申请改名。\n驳回。\n理由：确实是胆小鬼。`,
    userId => `🤡 <@${userId}> 挣扎得很努力。\n可惜方向不对。`,
];

let clientRef = null;
const lastTauntAt = new Map();

function logFailure(operation, context, error) {
    console.error(`[MysteryCoward] ${operation} (${context}):`, error);
}

function penaltyKey(guildId, userId) {
    return `${guildId}:${userId}`;
}

function codePoints(text) {
    return [...String(text ?? '')];
}

function buildCowardNickname(baseName) {
    const budget = NICKNAME_MAX_LENGTH - codePoints(COWARD_PREFIX).length;
    const base = codePoints(baseName).slice(0, Math.max(0, budget)).join('').trim();
    const combined = base ? `${COWARD_PREFIX}${base}` : COWARD_PREFIX.trim();
    return codePoints(combined).slice(0, NICKNAME_MAX_LENGTH).join('');
}

function pickTaunt(templates, userId) {
    return templates[Math.floor(Math.random() * templates.length)](userId);
}

function rememberClient(candidate) {
    if (candidate && !clientRef) clientRef = candidate;
    return clientRef;
}

async function fetchGuild(guildId) {
    if (!clientRef?.guilds) return null;
    const cached = clientRef.guilds.cache?.get(guildId);
    if (cached) return cached;
    try {
        return await clientRef.guilds.fetch(guildId);
    } catch (error) {
        return null;
    }
}

async function fetchMember(guildId, userId) {
    const guild = await fetchGuild(guildId);
    if (!guild?.members) return null;
    try {
        return await guild.members.fetch(userId);
    } catch (error) {
        return null;
    }
}

async function fetchChannel(channelId) {
    if (!channelId || !clientRef?.channels) return null;
    const cached = clientRef.channels.cache?.get(channelId);
    if (cached) return cached;
    try {
        return await clientRef.channels.fetch(channelId);
    } catch (error) {
        return null;
    }
}

async function sendTaunt(channel, taunt, context) {
    if (!channel || typeof channel.send !== 'function') return false;
    try {
        await channel.send(panels.cowardRenameMessage(taunt));
        return true;
    } catch (error) {
        logFailure('发送嘲讽失败', `user=${context.userId}`, error);
        return false;
    }
}

function tauntAllowed(guildId, userId, now = Date.now()) {
    const key = penaltyKey(guildId, userId);
    const previous = lastTauntAt.get(key);
    if (previous !== undefined && now - previous < TAUNT_COOLDOWN_MS) return false;
    lastTauntAt.set(key, now);
    return true;
}

function canManageNickname(member) {
    const me = member?.guild?.members?.me;
    if (!me?.permissions?.has?.(PermissionFlagsBits.ManageNicknames)) return false;
    return member.manageable === true;
}

// 挂 🤡 名字：生命周期完全委托给 common nickname lock service（type: 'coward'）。
// coward 优先级最高：可强制覆盖普通 Mystery 昵称锁（duel_rename / devil_roulette_rename），
// 覆盖后普通锁彻底作废；已有 coward 时拒绝（返回 'locked'）。
async function applyCowardPenalty({ member, channel, channelId }) {
    const guildId = member?.guild?.id;
    const userId = member?.id;
    if (!guildId || !userId) return { applied: false };

    rememberClient(member.client);

    // 胆小鬼名字基于 root 昵称（进入惩罚链之前的真实昵称），
    // 而不是当前被普通锁改过、可能即将作废的名字。
    const existing = nicknameLock.store.get(guildId, userId);
    const baseName = existing?.originalNickname ?? member.displayName;
    const enforcedNickname = buildCowardNickname(baseName);
    const originalNickname = member.nickname ?? null;
    const targetChannelId = channelId || channel?.id || null;

    const result = await nicknameLock.service.replaceLock({
        member,
        type: 'coward',
        enforcedNickname,
        expiresAt: Date.now() + HARD_CAP_MS,
        originalNickname,
        applyReason: APPLY_REASON,
        restoreReason: RESTORE_REASON,
        enforceReason: ENFORCE_REASON,
        channelId: targetChannelId,
        expectedTypes: ORDINARY_LOCK_TYPES,
    });

    if (result.created) {
        return {
            applied: true,
            enforcedNickname,
            taunt: pickTaunt(QUIT_TAUNTS, userId),
        };
    }

    if (result.reason === 'existing_lock') {
        return { applied: false, reason: 'locked' };
    }
    return { applied: false, enforcedNickname, taunt: pickTaunt(QUIT_TAUNTS, userId) };
}

// 每个胆小鬼的 🤡 时长按他退出那一刻的赌注算，下限 5 分钟。
// 唯一的下限落点在这里，调用方传什么都兜得住。
function cowardPenaltyMinutes(stakeMinutes) {
    if (!Number.isFinite(stakeMinutes)) return MIN_AFTER_GAME_MINUTES;
    return Math.max(MIN_AFTER_GAME_MINUTES, Math.ceil(stakeMinutes));
}

// cowards：[{ userId, stakeMinutes }]，逐个结算，各算各的时长。
// 通过 common updateLock 在串行 + durable 边界内把 expiresAt 缩短到最终时长。
async function settleCowardPenalties(guildId, cowards) {
    if (!guildId || !Array.isArray(cowards)) return;
    const now = Date.now();
    await Promise.all(cowards.map(async entry => {
        const userId = entry?.userId;
        if (!userId) return;
        const existing = nicknameLock.store.get(guildId, userId);
        // 结算只缩短胆小鬼锁：duel_rename 等其他类型的锁绝不能被动到。
        if (!existing || existing.type !== 'coward') return;

        const expiresAt = now + (cowardPenaltyMinutes(entry.stakeMinutes) * 60 * 1000);
        const result = await nicknameLock.service.updateLock(guildId, userId, draft => {
            // 挂上时给的是 HARD_CAP_MS 兜底，结算只会把它改短，绝不延长。
            draft.expiresAt = Math.min(draft.expiresAt, expiresAt);
            draft.settled = true;
            return draft;
        });
        if (!result.updated && result.reason === 'persistence_failed') {
            logFailure('结算胆小鬼时长失败', `guild=${guildId} user=${userId}`, new Error(result.reason));
        }
    }));
}

// 戴罪上桌的人只要真正把这一局打完了，🤡 当场摘掉，不用等计时器走完。
// 中弹倒下的也算：他没挂完的那部分已经在中弹时折成禁言还上了，不该两头收。
async function redeemCowardPenalties(guildId, userIds) {
    if (!guildId || !Array.isArray(userIds)) return;
    for (const userId of userIds) {
        if (!userId) continue;
        try {
            await releaseCowardPenalty(guildId, userId);
        } catch (error) {
            logFailure('赎罪摘牌失败', `guild=${guildId} user=${userId}`, error);
        }
    }
}

function cowardPenaltyRemainingMs(guildId, userId, now = Date.now()) {
    if (!guildId || !userId || !nicknameLock.store.isLoaded()) return 0;
    const record = nicknameLock.store.get(guildId, userId);
    // 只认胆小鬼锁：死斗改名（duel_rename）等其他昵称锁绝不能算作懦夫惩罚。
    if (!record || record.type !== 'coward') return 0;
    return Math.max(0, record.expiresAt - now);
}

async function releaseCowardPenalty(guildId, userId) {
    // 只释放胆小鬼锁：绝不提前解除死斗改名等其他类型的昵称锁。
    const record = nicknameLock.store.get(guildId, userId);
    if (!record || record.type !== 'coward') return false;
    lastTauntAt.delete(penaltyKey(guildId, userId));
    return nicknameLock.service.releaseLock(guildId, userId);
}

// 改名对抗：生命周期交给 common service（重新强制/到期释放），
// 胆小鬼专属的嘲讽在这里补发（20 秒限流）。
async function handleGuildMemberUpdate(oldMember, newMember) {
    const guildId = newMember?.guild?.id;
    const userId = newMember?.id;
    if (!guildId || !userId) return false;

    const attemptedNickname = newMember.nickname;
    const handled = await nicknameLock.service.handleGuildMemberUpdate(oldMember, newMember);

    if (oldMember?.nickname === attemptedNickname) return handled;
    const record = nicknameLock.store.get(guildId, userId);
    if (!record || record.type !== 'coward') return handled;
    if (Date.now() >= record.expiresAt) return handled;
    if (!tauntAllowed(guildId, userId)) return handled;

    const channel = await fetchChannel(record.channelId);
    await sendTaunt(channel, pickTaunt(RENAME_TAUNTS, userId), { userId });
    return handled;
}

async function startCowardPenaltyRestorer(client) {
    rememberClient(client);
    await nicknameLock.initialize(client);
}

function resetForTests() {
    lastTauntAt.clear();
    clientRef = null;
    nicknameLock.resetForTests();
}

module.exports = {
    COWARD_PREFIX,
    AFTER_GAME_MS,
    MIN_AFTER_GAME_MINUTES,
    QUIT_TAUNTS,
    RENAME_TAUNTS,
    buildCowardNickname,
    cowardPenaltyMinutes,
    cowardPenaltyRemainingMs,
    applyCowardPenalty,
    settleCowardPenalties,
    redeemCowardPenalties,
    releaseCowardPenalty,
    handleGuildMemberUpdate,
    startCowardPenaltyRestorer,
    resetForTests,
};
