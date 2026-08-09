const { PermissionFlagsBits } = require('discord.js');
const store = require('../utils/cowardPenaltyStore');
const panels = require('./pressureRoulettePanels');

const COWARD_PREFIX = '🤡胆小鬼 ';
const NICKNAME_MAX_LENGTH = 32;
// 游戏结束后 🤡 至少还要再挂这么久；退出那一刻的赌注更长时按赌注算。
const MIN_AFTER_GAME_MINUTES = 5;
const AFTER_GAME_MS = MIN_AFTER_GAME_MINUTES * 60 * 1000;
const HARD_CAP_MS = 60 * 60 * 1000;
const TAUNT_COOLDOWN_MS = 20 * 1000;
const MAX_TIMER_MS = 2 ** 31 - 1;
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
const releaseTimers = new Map();
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

function clearReleaseTimer(guildId, userId) {
    const key = penaltyKey(guildId, userId);
    const timer = releaseTimers.get(key);
    if (timer) {
        clearTimeout(timer);
        releaseTimers.delete(key);
    }
}

function scheduleRelease(record) {
    clearReleaseTimer(record.guildId, record.userId);
    const delay = Math.max(0, Math.min(MAX_TIMER_MS, record.expiresAt - Date.now()));
    const timer = setTimeout(() => {
        releaseTimers.delete(penaltyKey(record.guildId, record.userId));
        void releaseCowardPenalty(record.guildId, record.userId);
    }, delay);
    timer.unref?.();
    releaseTimers.set(penaltyKey(record.guildId, record.userId), timer);
}

function canManageNickname(member) {
    const me = member?.guild?.members?.me;
    if (!me?.permissions?.has?.(PermissionFlagsBits.ManageNicknames)) return false;
    return member.manageable === true;
}

async function applyCowardPenalty({ member, channel, channelId }) {
    const guildId = member?.guild?.id;
    const userId = member?.id;
    if (!guildId || !userId) return { applied: false };

    rememberClient(member.client);

    const enforcedNickname = buildCowardNickname(member.displayName);
    const originalNickname = member.nickname ?? null;
    const targetChannelId = channelId || channel?.id || null;

    let applied = false;
    if (canManageNickname(member)) {
        try {
            await member.setNickname(enforcedNickname, APPLY_REASON);
            applied = true;
        } catch (error) {
            logFailure('挂胆小鬼前缀失败', `guild=${guildId} user=${userId}`, error);
        }
    }

    if (applied) {
        const record = {
            guildId,
            userId,
            originalNickname,
            enforcedNickname,
            expiresAt: Date.now() + HARD_CAP_MS,
            channelId: targetChannelId,
        };
        store.save(record);
        scheduleRelease(record);
    }

    // 退出的嘲讽词交给游戏那边和局面一起播报成 embed，这里只负责挂名字。
    // 也因此不占用改名嘲讽的冷却，否则玩家一退出就改名会被静默放过。
    return {
        applied,
        enforcedNickname,
        taunt: pickTaunt(QUIT_TAUNTS, userId),
    };
}

// 每个胆小鬼的 🤡 时长按他退出那一刻的赌注算，下限 5 分钟。
// 唯一的下限落点在这里，调用方传什么都兜得住。
function cowardPenaltyMinutes(stakeMinutes) {
    if (!Number.isFinite(stakeMinutes)) return MIN_AFTER_GAME_MINUTES;
    return Math.max(MIN_AFTER_GAME_MINUTES, Math.ceil(stakeMinutes));
}

// cowards：[{ userId, stakeMinutes }]，逐个结算，各算各的时长。
function settleCowardPenalties(guildId, cowards) {
    if (!guildId || !Array.isArray(cowards)) return;
    const now = Date.now();
    for (const entry of cowards) {
        const userId = entry?.userId;
        if (!userId) continue;
        const record = store.get(guildId, userId);
        if (!record) continue;
        // 挂上时给的是 HARD_CAP_MS 兜底，结算只会把它改短，绝不延长。
        record.expiresAt = Math.min(
            record.expiresAt,
            now + (cowardPenaltyMinutes(entry.stakeMinutes) * 60 * 1000)
        );
        // 标记这条已经按最终时长算过了，重启恢复时不要再砍。
        record.settled = true;
        store.save(record);
        scheduleRelease(record);
    }
}

function cowardPenaltyRemainingMs(guildId, userId, now = Date.now()) {
    if (!guildId || !userId || !store.isLoaded()) return 0;
    const record = store.get(guildId, userId);
    if (!record) return 0;
    return Math.max(0, record.expiresAt - now);
}

async function releaseCowardPenalty(guildId, userId) {
    const record = store.get(guildId, userId);
    clearReleaseTimer(guildId, userId);
    lastTauntAt.delete(penaltyKey(guildId, userId));
    // 先摘记录再改昵称，避免还原动作触发自己的改名监听。
    store.remove(guildId, userId);
    if (!record) return false;

    const member = await fetchMember(guildId, userId);
    if (!member) return false;
    if (member.nickname !== record.enforcedNickname) return false;
    if (!canManageNickname(member)) return false;

    try {
        await member.setNickname(record.originalNickname ?? null, RESTORE_REASON);
        return true;
    } catch (error) {
        logFailure('还原昵称失败', `guild=${guildId} user=${userId}`, error);
        return false;
    }
}

async function handleGuildMemberUpdate(oldMember, newMember) {
    const guildId = newMember?.guild?.id;
    const userId = newMember?.id;
    if (!guildId || !userId || !store.isLoaded()) return;
    if (oldMember?.nickname === newMember?.nickname) return;

    const record = store.get(guildId, userId);
    if (!record) return;

    if (Date.now() >= record.expiresAt) {
        await releaseCowardPenalty(guildId, userId);
        return;
    }

    // 这次更新就是我们自己写进去的，放行，否则会无限互改。
    if (newMember.nickname === record.enforcedNickname) return;

    rememberClient(newMember.client);
    if (!canManageNickname(newMember)) return;

    try {
        await newMember.setNickname(record.enforcedNickname, ENFORCE_REASON);
    } catch (error) {
        logFailure('改回胆小鬼前缀失败', `guild=${guildId} user=${userId}`, error);
        return;
    }

    if (!tauntAllowed(guildId, userId)) return;
    const channel = await fetchChannel(record.channelId);
    await sendTaunt(channel, pickTaunt(RENAME_TAUNTS, userId), { userId });
}

async function restoreRecord(record) {
    // 已结算的记录，expiresAt 就是按赌注算出来的最终时间，照搬。
    // 没结算的说明重启时那局还没打完，游戏已经随进程没了，最多再留 5 分钟。
    const cappedExpiresAt = record.settled === true
        ? record.expiresAt
        : Math.min(record.expiresAt, Date.now() + AFTER_GAME_MS);
    if (cappedExpiresAt <= Date.now()) {
        await releaseCowardPenalty(record.guildId, record.userId);
        return;
    }

    record.expiresAt = cappedExpiresAt;
    store.save(record);
    scheduleRelease(record);

    const member = await fetchMember(record.guildId, record.userId);
    if (!member) return;
    if (member.nickname === record.enforcedNickname) return;
    if (!canManageNickname(member)) return;
    try {
        await member.setNickname(record.enforcedNickname, ENFORCE_REASON);
    } catch (error) {
        logFailure('重启后补挂前缀失败', `guild=${record.guildId} user=${record.userId}`, error);
    }
}

async function startCowardPenaltyRestorer(client) {
    rememberClient(client);
    let records = [];
    try {
        records = await store.load();
    } catch (error) {
        logFailure('加载胆小鬼记录失败', 'startup', error);
        return;
    }

    for (const record of records) {
        try {
            await restoreRecord(record);
        } catch (error) {
            logFailure('恢复胆小鬼记录失败', `guild=${record.guildId} user=${record.userId}`, error);
        }
    }
}

function resetForTests() {
    for (const timer of releaseTimers.values()) clearTimeout(timer);
    releaseTimers.clear();
    lastTauntAt.clear();
    clientRef = null;
    store.resetForTests();
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
    releaseCowardPenalty,
    handleGuildMemberUpdate,
    startCowardPenaltyRestorer,
    resetForTests,
};
