// src/modules/channelSummary/config/presetConfig.js

const path = require("path");

const DATA_DIR = path.join(process.cwd(), "data");

module.exports = {
  /** SQLite 数据库文件路径 */
  PRESET_DB_PATH: path.join(DATA_DIR, "channelSummaryPresets.sqlite"),

  /** 每人私有预设数量上限 */
  MAX_PRIVATE_PRESETS_PER_USER: 5,

  /** 全服公用预设数量上限 */
  MAX_PUBLIC_PRESETS_PER_GUILD: 5,
};
