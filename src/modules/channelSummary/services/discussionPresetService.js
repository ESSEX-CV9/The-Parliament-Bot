const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const config = require("../config/discussionPresetConfig");

fs.mkdirSync(path.dirname(config.PRESET_DB_PATH), { recursive: true });
const db = new Database(config.PRESET_DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS discussion_summary_presets (
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    start_time TEXT DEFAULT '',
    end_time TEXT DEFAULT '',
    model TEXT DEFAULT '',
    api_base_url TEXT DEFAULT '',
    api_key TEXT DEFAULT '',
    extra_prompt TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    PRIMARY KEY (guild_id, name)
  );
`);

const select = db.prepare("SELECT * FROM discussion_summary_presets WHERE guild_id = ? AND name = ?");
const list = db.prepare("SELECT name FROM discussion_summary_presets WHERE guild_id = ? ORDER BY name");
const remove = db.prepare("DELETE FROM discussion_summary_presets WHERE guild_id = ? AND name = ?");
const upsert = db.prepare(`
  INSERT INTO discussion_summary_presets
    (guild_id, name, start_time, end_time, model, api_base_url, api_key,
     extra_prompt, created_at, updated_at, created_by, updated_by)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(guild_id, name) DO UPDATE SET
    start_time=excluded.start_time, end_time=excluded.end_time,
    model=excluded.model, api_base_url=excluded.api_base_url, api_key=excluded.api_key,
    extra_prompt=excluded.extra_prompt, updated_at=excluded.updated_at,
    updated_by=excluded.updated_by
`);

function getPreset(guildId, name) {
  const row = select.get(guildId, name);
  if (!row) return null;
  return {
    guildId: row.guild_id, name: row.name,
    startTime: row.start_time, endTime: row.end_time, model: row.model,
    apiBaseUrl: row.api_base_url, apiKey: row.api_key, extraPrompt: row.extra_prompt,
    createdAt: row.created_at, updatedAt: row.updated_at,
    createdBy: row.created_by, updatedBy: row.updated_by,
  };
}

// 审计用户只用于记录；读写和删除始终以服务器 + 名称定位。
const savePreset = db.transaction((guildId, name, values, actorId) => {
  const isNew = !select.get(guildId, name);
  const now = new Date().toISOString();
  upsert.run(guildId, name, values.startTime || "", values.endTime || "",
    values.model || "", values.apiBaseUrl || "", values.apiKey || "",
    values.extraPrompt || "", now, now, actorId, actorId);
  return isNew;
});

function getPresetNames(guildId) {
  return list.all(guildId).map(row => row.name);
}

function deletePreset(guildId, name) {
  return remove.run(guildId, name).changes > 0;
}

const flows = new Map();
const FLOW_TTL_MS = 30 * 60 * 1000;
function generateFlowId() { return crypto.randomUUID(); }
function createFlow(id, values) {
  flows.set(id, { ...values, flowId: id, expiresAt: Date.now() + FLOW_TTL_MS });
}
function getFlow(id) {
  const flow = flows.get(id);
  if (!flow || flow.expiresAt <= Date.now()) {
    flows.delete(id);
    return null;
  }
  return flow;
}
function updateFlowValues(id, values) {
  const flow = getFlow(id);
  if (!flow) return null;
  Object.assign(flow, values);
  return flow;
}
function deleteFlow(id) { flows.delete(id); }
setInterval(() => {
  for (const id of flows.keys()) getFlow(id);
}, 5 * 60 * 1000).unref();

module.exports = {
  getPreset, getPresetNames, savePreset, deletePreset,
  generateFlowId, createFlow, getFlow, updateFlowValues, deleteFlow,
};
