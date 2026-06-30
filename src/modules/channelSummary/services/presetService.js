// src/modules/channelSummary/services/presetService.js

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const config = require("../config/presetConfig");

// ---- SQLite 初始化 ----
const dir = path.dirname(config.PRESET_DB_PATH);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(config.PRESET_DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS presets (
    guild_id      TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    name          TEXT NOT NULL,
    start_time    TEXT DEFAULT '',
    end_time      TEXT DEFAULT '',
    model         TEXT DEFAULT '',
    api_base_url  TEXT DEFAULT '',
    api_key       TEXT DEFAULT '',
    extra_prompt  TEXT DEFAULT '',
    is_public     INTEGER DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id, name)
  );
`);

// 全局授权身份组表（不绑 guild，全服生效）
db.exec(`
  CREATE TABLE IF NOT EXISTS summary_authorized_roles (
    role_id TEXT PRIMARY KEY
  );
`);

// 兼容旧列（废弃不使用）
try { db.exec(`ALTER TABLE presets ADD COLUMN allowed_role_id TEXT DEFAULT ''`); } catch (_) {}

// ---- 预编译语句 ----

const stmtOwnPresets = db.prepare(
  `SELECT * FROM presets WHERE guild_id = ? AND user_id = ? ORDER BY name ASC`,
);
const stmtPresetByName = db.prepare(
  `SELECT * FROM presets WHERE guild_id = ? AND user_id = ? AND name = ?`,
);
const stmtPublicByName = db.prepare(
  `SELECT * FROM presets WHERE guild_id = ? AND name = ? AND is_public = 1 AND user_id != ?`,
);
const stmtOwnCount = db.prepare(
  `SELECT COUNT(*) AS cnt FROM presets WHERE guild_id = ? AND user_id = ?`,
);
const stmtPublicCount = db.prepare(
  `SELECT COUNT(*) AS cnt FROM presets WHERE guild_id = ? AND is_public = 1`,
);
const stmtDeleteOwn = db.prepare(
  `DELETE FROM presets WHERE guild_id = ? AND user_id = ? AND name = ?`,
);
const stmtDeleteAny = db.prepare(
  `DELETE FROM presets WHERE guild_id = ? AND name = ?`,
);
const stmtAllPresets = db.prepare(
  `SELECT * FROM presets WHERE guild_id = ? ORDER BY user_id, name ASC`,
);
const stmtExists = db.prepare(
  `SELECT 1 FROM presets WHERE guild_id = ? AND user_id = ? AND name = ?`,
);
const stmtInsert = db.prepare(
  `INSERT INTO presets
     (guild_id, user_id, name, start_time, end_time, model, api_base_url,
      api_key, extra_prompt, is_public, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

// ---- 工具 ----

function rowToPreset(row) {
  if (!row) return null;
  return {
    name: row.name,
    startTime: row.start_time || "",
    endTime: row.end_time || "",
    model: row.model || "",
    apiBaseUrl: row.api_base_url || "",
    apiKey: row.api_key || "",
    extraPrompt: row.extra_prompt || "",
    isPublic: row.is_public === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ownerId: row.user_id,
    guildId: row.guild_id,
  };
}

// ---- 授权身份组表 ----

function addAuthorizedRole(roleId) {
  try {
    db.prepare(`INSERT OR IGNORE INTO summary_authorized_roles (role_id) VALUES (?)`).run(roleId);
    return true;
  } catch { return false; }
}

function removeAuthorizedRole(roleId) {
  const info = db.prepare(`DELETE FROM summary_authorized_roles WHERE role_id = ?`).run(roleId);
  return info.changes > 0;
}

function getAllAuthorizedRoles() {
  return db.prepare(`SELECT role_id FROM summary_authorized_roles`).all().map((r) => r.role_id);
}

/**
 * 判断用户是否拥有任意授权身份组
 */
function hasAnyAuthorizedRole(memberRoleIds) {
  if (!memberRoleIds.length) return false;
  const placeholders = memberRoleIds.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT 1 FROM summary_authorized_roles WHERE role_id IN (${placeholders}) LIMIT 1`,
    )
    .get(...memberRoleIds);
  return !!row;
}

// ---- 预设 CRUD ----

/**
 * 获取用户可见预设：自己的私用 +（若为授权用户）所有公用
 */
function getUserPresets(guildId, userId, isAuthorizedUser) {
  let rows;
  if (isAuthorizedUser) {
    rows = db
      .prepare(
        `SELECT * FROM presets
         WHERE guild_id = ? AND (user_id = ? OR is_public = 1)
         ORDER BY is_public DESC, name ASC`,
      )
      .all(guildId, userId);
  } else {
    rows = stmtOwnPresets.all(guildId, userId);
  }

  const result = {};
  for (const row of rows) {
    result[row.name] = rowToPreset(row);
  }
  return result;
}

/**
 * 获取单个预设。优先自己的；其次公用（授权用户才可见）。
 */
function getPreset(guildId, userId, presetName, isAuthorizedUser) {
  let row = stmtPresetByName.get(guildId, userId, presetName);
  if (row) return rowToPreset(row);

  if (isAuthorizedUser) {
    row = stmtPublicByName.get(guildId, presetName, userId);
    if (row) {
      const preset = rowToPreset(row);
      preset.isForeign = true;
      return preset;
    }
  }

  return null;
}

/**
 * Admin 用：获取全服所有预设
 */
function getAllPresets(guildId) {
  const rows = stmtAllPresets.all(guildId);
  const result = {};
  for (const row of rows) {
    result[row.name] = rowToPreset(row);
  }
  return result;
}

/**
 * 保存/更新预设
 */
function savePreset(guildId, userId, presetName, values) {
  const existing = stmtExists.get(guildId, userId, presetName);
  const isNew = !existing;
  const now = new Date().toISOString();
  const isPublic = values.isPublic ? 1 : 0;

  if (isNew) {
    stmtInsert.run(
      guildId, userId, presetName,
      values.startTime || "", values.endTime || "", values.model || "",
      values.apiBaseUrl || "", values.apiKey || "", values.extraPrompt || "",
      isPublic,
      now, now,
    );
  } else {
    db.prepare(
      `UPDATE presets SET start_time=?, end_time=?, model=?, api_base_url=?, api_key=?,
       extra_prompt=?, is_public=?, updated_at=?
       WHERE guild_id=? AND user_id=? AND name=?`,
    ).run(
      values.startTime || "", values.endTime || "", values.model || "",
      values.apiBaseUrl || "", values.apiKey || "", values.extraPrompt || "",
      isPublic, now,
      guildId, userId, presetName,
    );
  }

  return isNew;
}

/**
 * 删除自己的预设
 */
function deletePreset(guildId, userId, presetName) {
  const info = stmtDeleteOwn.run(guildId, userId, presetName);
  return info.changes > 0;
}

/**
 * Admin 强制删除任意预设（含他人私用）
 */
function forceDeletePreset(guildId, presetName) {
  const info = stmtDeleteAny.run(guildId, presetName);
  return info.changes > 0;
}

/**
 * 获取公用预设数量（全服）
 */
function getPublicPresetCount(guildId) {
  const row = stmtPublicCount.get(guildId);
  return row ? row.cnt : 0;
}

/**
 * 获取用户的预设数量
 */
function getPresetCount(guildId, userId) {
  const row = stmtOwnCount.get(guildId, userId);
  return row ? row.cnt : 0;
}

// ---- Flow 会话管理（内存） ----

const flowMap = new Map();

function generateFlowId() {
  return crypto.randomUUID();
}

function createFlow(flowId, data) {
  flowMap.set(flowId, { ...data, flowId });
}

function getFlow(flowId) {
  return flowMap.get(flowId) || null;
}

function updateFlowValues(flowId, updates) {
  const flow = flowMap.get(flowId);
  if (!flow) return null;
  Object.assign(flow, updates);
  return flow;
}

function deleteFlow(flowId) {
  flowMap.delete(flowId);
}

setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, flow] of flowMap) {
    if (flow.createdAt && new Date(flow.createdAt).getTime() < cutoff) {
      flowMap.delete(id);
    }
  }
}, 5 * 60 * 1000);

module.exports = {
  // 授权身份组
  addAuthorizedRole,
  removeAuthorizedRole,
  getAllAuthorizedRoles,
  hasAnyAuthorizedRole,
  // 预设 CRUD
  getUserPresets,
  getPreset,
  getAllPresets,
  savePreset,
  deletePreset,
  forceDeletePreset,
  getPublicPresetCount,
  getPresetCount,
  // Flow
  createFlow,
  getFlow,
  updateFlowValues,
  deleteFlow,
  generateFlowId,
  flowMap,
};
