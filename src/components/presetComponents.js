// src/modules/channelSummary/components/presetComponents.js

const { TextInputStyle } = require("discord.js");

/**
 * 构建「修改参数」Modal — 仅 4 个业务字段（不含 url/api）
 */
function createEditPresetModal(flowId, presetValues) {
  const { ModalBuilder, TextInputBuilder, ActionRowBuilder } = require("discord.js");

  const modal = new ModalBuilder()
    .setCustomId(`preset_edit_modal_${flowId}`)
    .setTitle("修改预设参数");

  const startTimeInput = new TextInputBuilder()
    .setCustomId("preset_startTime")
    .setLabel("开始时间 (YYYY-MM-DD HH:mm)")
    .setStyle(TextInputStyle.Short)
    .setValue(presetValues.startTime || "")
    .setRequired(true);

  const endTimeInput = new TextInputBuilder()
    .setCustomId("preset_endTime")
    .setLabel("结束时间 (YYYY-MM-DD HH:mm)")
    .setStyle(TextInputStyle.Short)
    .setValue(presetValues.endTime || "")
    .setRequired(true);

  const modelInput = new TextInputBuilder()
    .setCustomId("preset_model")
    .setLabel("模型 (留空使用默认)")
    .setStyle(TextInputStyle.Short)
    .setValue(presetValues.model || "")
    .setRequired(false);

  const extraPromptInput = new TextInputBuilder()
    .setCustomId("preset_extraPrompt")
    .setLabel("额外提示词 (可选)")
    .setStyle(TextInputStyle.Paragraph)
    .setValue(presetValues.extraPrompt || "")
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(startTimeInput),
    new ActionRowBuilder().addComponents(endTimeInput),
    new ActionRowBuilder().addComponents(modelInput),
    new ActionRowBuilder().addComponents(extraPromptInput),
  );

  return modal;
}

/**
 * 脱敏 API Key（所有者可见时）
 */
function maskApiKeyPartial(key) {
  if (!key) return "（未设置）";
  if (key.length <= 4) return "****";
  return key.substring(0, 3) + "****" + key.substring(key.length - 2);
}

/**
 * 构建预设参数展示 Embed
 * @param {object} presetValues
 * @param {string} presetName
 * @param {object} [options]
 * @param {string} [options.viewerUserId] - 当前查看者 ID
 * @param {string} [options.ownerId] - 预设所有者 ID
 * @param {boolean} [options.isPublic] - 是否公开预设
 */
function buildPresetEmbed(presetValues, presetName, options = {}) {
  const { viewerUserId, ownerId, isPublic } = options;
  const isOwner = !ownerId || viewerUserId === ownerId;

  // API Key 显示策略：非所有者查看公用预设 → 完全脱敏；所有者 → 部分脱敏
  let apiKeyDisplay;
  if (!presetValues.apiKey) {
    apiKeyDisplay = "（未设置）";
  } else if (!isOwner && isPublic) {
    apiKeyDisplay = "******";
  } else {
    apiKeyDisplay = maskApiKeyPartial(presetValues.apiKey);
  }

  const titleParts = [`📋 预设「${presetName}」参数确认`];
  if (isPublic && !isOwner) {
    titleParts.push(" 🌍（公开预设）");
  }

  const fields = [
    { name: "开始时间", value: presetValues.startTime || "（未设置）", inline: true },
    { name: "结束时间", value: presetValues.endTime || "（未设置）", inline: true },
    { name: "模型", value: presetValues.model || "（使用默认模型）", inline: true },
    { name: "API Base URL", value: presetValues.apiBaseUrl || "（使用默认地址）", inline: true },
    { name: "API Key", value: apiKeyDisplay, inline: true },
    { name: "额外提示词", value: presetValues.extraPrompt || "（无）", inline: false },
  ];

  if (isPublic && !isOwner && ownerId) {
    fields.push({
      name: "创建者",
      value: `<@${ownerId}>`,
      inline: true,
    });
  }

  if (isPublic) {
    fields.push({
      name: "可见范围",
      value: "🌍 全服共享",
      inline: true,
    });
  }

  return {
    color: isPublic ? 0x2ecc71 : 0x3498db,
    title: titleParts.join(""),
    fields,
    footer: { text: "请确认参数后点击下方按钮操作" },
    timestamp: new Date().toISOString(),
  };
}

/**
 * 构建 3 按钮 ActionRow
 */
function buildPresetActionRow(flowId) {
  const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require("discord.js");

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`preset_confirm_${flowId}`)
      .setLabel("确认执行")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`preset_edit_${flowId}`)
      .setLabel("修改参数")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`preset_cancel_${flowId}`)
      .setLabel("取消")
      .setStyle(ButtonStyle.Secondary),
  );
}

module.exports = {
  createEditPresetModal,
  buildPresetEmbed,
  buildPresetActionRow,
  maskApiKey: maskApiKeyPartial,
};
