// src\modules\selfModeration\services\seriousMuteHistory.js
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 严肃禁言历史窗口（天）
 * 仅用于本文件内部的默认窗口配置
 */
const SERIOUS_MUTE_HISTORY_WINDOW_DAYS = 15;

// 与 core/utils/database.js 一致的持久化位置（src/data）
const DATA_DIR = path.join(__dirname, '../../../data');
const VOTES_FILE = path.join(DATA_DIR, 'selfModerationVotes.json');

// 在 selfModerationVotes.json 中的命名空间键
// 采用自助治理前缀，保持与模块命名风格一致
const NAMESPACE_KEY = 'selfModeration.seriousMuteHistory';

/** 工具函数：确保数据目录与文件存在 */
function ensureStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(VOTES_FILE)) {
      fs.writeFileSync(VOTES_FILE, '{}', 'utf8');
    }
  } catch (err) {
    console.error('[SeriousMuteHistory] 初始化数据目录或文件失败:', err);
    throw err;
  }
}

/** 工具函数：读取整个 JSON 存储对象 */
function readStore() {
  ensureStore();
  try {
    const raw = fs.readFileSync(VOTES_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (err) {
    console.error('[SeriousMuteHistory] 读取存储文件失败:', err);
    return {};
  }
}

/** 工具函数：写回整个 JSON 存储对象（与现有模块风格一致，覆盖写入） */
function writeStore(obj) {
  ensureStore();
  try {
    fs.writeFileSync(VOTES_FILE, JSON.stringify(obj || {}, null, 2), 'utf8');
  } catch (err) {
    console.error('[SeriousMuteHistory] 写入存储文件失败:', err);
    throw err;
  }
}

/** 工具函数：获取命名空间对象（若不存在则返回空对象的拷贝） */
function getNamespace(all) {
  return (all && typeof all === 'object' && all[NAMESPACE_KEY]) ? all[NAMESPACE_KEY] : {};
}

/** 工具函数：设置命名空间对象 */
function setNamespace(all, ns) {
  all[NAMESPACE_KEY] = ns;
}

/** 工具函数：按 guild+user 生成 key，避免冲突并便于分片清理 */
function makeUserKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

/** 工具函数：计算时间窗口阈值（ms） */
function getWindowThresholdMs(windowDays, nowMs) {
  const days = typeof windowDays === 'number' && windowDays > 0 ? windowDays : SERIOUS_MUTE_HISTORY_WINDOW_DAYS;
  const now = typeof nowMs === 'number' && nowMs > 0 ? nowMs : Date.now();
  return now - days * 24 * 60 * 60 * 1000;
}

/**
 * 获取最近窗口内的严肃禁言事件计数
 * 仅统计已成功执行并写入本集合的 serious_mute 事件
 *
 * @param {string} guildId - 服务器ID
 * @param {string} userId - 用户ID（被禁言者）
 * @param {number} [windowDays=SERIOUS_MUTE_HISTORY_WINDOW_DAYS] - 窗口天数
 * @returns {Promise<number>} 计数
 */
async function getRecentSeriousMuteCount(guildId, userId, windowDays = SERIOUS_MUTE_HISTORY_WINDOW_DAYS) {
  try {
    if (!guildId || !userId) {
      return 0;
    }
    const all = readStore();
    const ns = getNamespace(all);
    const key = makeUserKey(guildId, userId);
    const list = Array.isArray(ns[key]) ? ns[key] : [];
    const threshold = getWindowThresholdMs(windowDays, Date.now());
    const count = list.filter(e => e && typeof e.executedAt === 'number' && e.executedAt >= threshold).length;
    return count;
  } catch (err) {
    console.error('[SeriousMuteHistory] 获取近期计数失败:', err);
    return 0;
  }
}

/**
 * 追加一条严肃禁言事件
 * - 执行前清理超窗记录
 * - 执行后再次校验（保持集合精简）
 *
 * @param {object} event - 事件对象
 * @param {string} event.guildId
 * @param {string} event.userId
 * @param {string} event.channelId
 * @param {string} event.voteId
 * @param {string} [event.messageId]
 * @param {number} event.durationMinutes - 实际执行分钟数
 * @param {number} event.levelIndex - 等级/序号（>=1）
 * @param {number} [event.executedAt] - ms 时间戳（默认 Date.now()）
 * @returns {Promise<void>}
 */
async function appendSeriousMuteEvent(event) {
  try {
    // 基础校验（保持最小必要字段）
    if (!event || !event.guildId || !event.userId || !event.channelId || !event.voteId) {
      console.warn('[SeriousMuteHistory] 事件缺少必要字段，已忽略。');
      return;
    }
    const nowMs = Date.now();
    const normalized = {
      guildId: String(event.guildId),
      userId: String(event.userId),
      channelId: String(event.channelId),
      voteId: String(event.voteId),
      messageId: event.messageId ? String(event.messageId) : undefined,
      durationMinutes: Number(event.durationMinutes) || 0,
      levelIndex: Math.max(1, Number(event.levelIndex) || 1),
      executedAt: typeof event.executedAt === 'number' ? event.executedAt : nowMs,
    };

    const all = readStore();
    const ns = getNamespace(all);
    const key = makeUserKey(normalized.guildId, normalized.userId);
    const before = Array.isArray(ns[key]) ? ns[key] : [];

    // 预清理：移除超出窗口的记录
    const threshold = getWindowThresholdMs(SERIOUS_MUTE_HISTORY_WINDOW_DAYS, nowMs);
    const prePruned = before.filter(e => e && typeof e.executedAt === 'number' && e.executedAt >= threshold);

    // 按 voteId 去重：同一投票只记录一次，避免在 active 期间重复累加历史次数
    const existsSameVote = prePruned.some(e => e && e.voteId === normalized.voteId);
    if (existsSameVote) {
      ns[key] = prePruned;
      setNamespace(all, ns);
      writeStore(all);
      return;
    }

    // 追加新事件（仅在未存在相同 voteId 时）
    prePruned.push(normalized);
    ns[key] = prePruned;

    // 可选：后清理（再次确保 executedAt 字段不合规的条目被剔除）
    ns[key] = ns[key].filter(e => e && typeof e.executedAt === 'number');

    // 持久化
    setNamespace(all, ns);
    writeStore(all);
  } catch (err) {
    console.error('[SeriousMuteHistory] 追加事件失败:', err);
  }
}

/**
 * 清理过期的严肃禁言历史
 * - userId 为空：清理整个 guildId 下的全部用户历史（批量）
 * - userId 非空：仅清理该用户
 *
 * @param {string} guildId - 服务器ID
 * @param {string} [userId] - 用户ID（可选）
 * @param {number} [nowMs] - 当前时间（ms，可选，默认 Date.now()）
 * @returns {Promise<number>} 实际清理的条目数
 */
async function pruneSeriousMuteHistory(guildId, userId, nowMs) {
  try {
    if (!guildId) return 0;

    const all = readStore();
    const ns = getNamespace(all);
    const threshold = getWindowThresholdMs(SERIOUS_MUTE_HISTORY_WINDOW_DAYS, typeof nowMs === 'number' ? nowMs : Date.now());

    let removed = 0;

    if (userId) {
      const key = makeUserKey(guildId, userId);
      const list = Array.isArray(ns[key]) ? ns[key] : [];
      if (list.length > 0) {
        const filtered = list.filter(e => e && typeof e.executedAt === 'number' && e.executedAt >= threshold);
        removed += (list.length - filtered.length);
        if (filtered.length > 0) {
          ns[key] = filtered;
        } else {
          delete ns[key];
        }
      }
    } else {
      // 批量：清理该 guild 下的所有用户键
      for (const k of Object.keys(ns)) {
        if (!k.startsWith(`${guildId}:`)) continue;
        const list = Array.isArray(ns[k]) ? ns[k] : [];
        if (list.length === 0) continue;
        const filtered = list.filter(e => e && typeof e.executedAt === 'number' && e.executedAt >= threshold);
        removed += (list.length - filtered.length);
        if (filtered.length > 0) {
          ns[k] = filtered;
        } else {
          delete ns[k];
        }
      }
    }

    // 若有变更则写回
    if (removed > 0) {
      setNamespace(all, ns);
      writeStore(all);
    }

    return removed;
  } catch (err) {
    console.error('[SeriousMuteHistory] 清理历史失败:', err);
    return 0;
  }
}

module.exports = {
  // 导出 API
  getRecentSeriousMuteCount,
  appendSeriousMuteEvent,
  pruneSeriousMuteHistory,

  // 内部默认窗口天数（未导出常量，避免外部依赖）
  // SERIOUS_MUTE_HISTORY_WINDOW_DAYS 仅用于默认值与清理窗口
};