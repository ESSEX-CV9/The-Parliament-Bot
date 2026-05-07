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
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    start_time TEXT DEFAULT '',
    end_time   TEXT DEFAULT '',
    model      TEXT DEFAULT '',
    api_base_url TEXT DEFAULT '',
    api_key    TEXT DEFAULT '',
    extra_prompt TEXT DEFAULT '',
    is_public  INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id, name)
  );
`);

// ---- 预设 CRUD ----

function rowToPreset(row) {
  if (!row) return null;
  return {
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

/**
 * 获取用户可见的所有预设（自己的私有 + 全服公用）
 */
function getUserPresets(guildId, userId) {
  const rows = db
    .prepare(
      `SELECT * FROM presets
       WHERE guild_id = ? AND (user_id = ? OR is_public = 1)
       ORDER BY is_public DESC, name ASC`,
    )
    .all(guildId, userId);

  const result = {};
  for (const row of rows) {
    result[row.name] = rowToPreset(row);
  }
  return result;
}

/**
 * 获取单个预设。优先返回自己的；其次返回公用预设（非自己的公用预设会附加 isForeign 标记）。
 */
function getPreset(guildId, userId, presetName) {
  // 优先查自己的
  let row = db
    .prepare(
      `SELECT * FROM presets WHERE guild_id = ? AND user_id = ? AND name = ?`,
    )
    .get(guildId, userId, presetName);

  if (!row) {
    // 查公用预设（非自己）
    row = db
      .prepare(
        `SELECT * FROM presets
         WHERE guild_id = ? AND name = ? AND is_public = 1 AND user_id != ?`,
      )
      .get(guildId, presetName, userId);

    if (!row) return null;

    const preset = rowToPreset(row);
    preset.isForeign = true; // 标记为他人创建的公用预设
    return preset;
  }

  return rowToPreset(row);
}

/**
 * 保存/更新预设。返回 { isNew: boolean }。
 */
function savePreset(guildId, userId, presetName, values) {
  const existing = db
    .prepare(
      `SELECT 1 FROM presets WHERE guild_id = ? AND user_id = ? AND name = ?`,
    )
    .get(guildId, userId, presetName);

  const isNew = !existing;
  const now = new Date().toISOString();

  const isPublic = values.isPublic ? 1 : 0;

  if (isNew) {
    db.prepare(
      `INSERT INTO presets
         (guild_id, user_id, name, start_time, end_time, model, api_base_url,
          api_key, extra_prompt, is_public, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      guildId,
      userId,
      presetName,
      values.startTime || "",
      values.endTime || "",
      values.model || "",
      values.apiBaseUrl || "",
      values.apiKey || "",
      values.extraPrompt || "",
      isPublic,
      now,
      now,
    );
  } else {
    const sets = [];
    const params = [];
    for (const [col, val] of Object.entries({
      start_time: values.startTime || "",
      end_time: values.endTime || "",
      model: values.model || "",
      api_base_url: values.apiBaseUrl || "",
      api_key: values.apiKey || "",
      extra_prompt: values.extraPrompt || "",
    })) {
      sets.push(`${col} = ?`);
      params.push(val);
    }
    sets.push("is_public = ?");
    params.push(isPublic);
    sets.push("updated_at = ?");
    params.push(now);
    params.push(guildId, userId, presetName);

    db.prepare(
      `UPDATE presets SET ${sets.join(", ")} WHERE guild_id = ? AND user_id = ? AND name = ?`,
    ).run(...params);
  }

  return isNew;
}

/**
 * 删除一个预设（仅所有者可删除）。返回 true/false。
 */
function deletePreset(guildId, userId, presetName) {
  const info = db
    .prepare(
      `DELETE FROM presets WHERE guild_id = ? AND user_id = ? AND name = ?`,
    )
    .run(guildId, userId, presetName);
  return info.changes > 0;
}

/**
 * 获取用户自己的预设数量（仅私有预设）
 */
function getPresetCount(guildId, userId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM presets WHERE guild_id = ? AND user_id = ?`,
    )
    .get(guildId, userId);
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
  getUserPresets,
  getPreset,
  savePreset,
  deletePreset,
  getPresetCount,
  createFlow,
  getFlow,
  updateFlowValues,
  deleteFlow,
  generateFlowId,
  flowMap,
};
