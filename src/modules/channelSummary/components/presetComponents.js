// src/modules/channelSummary/components/presetComponents.js

const { TextInputStyle } = require("discord.js");

// ---- API Key 脱敏 ----

function maskApiKey(key) {
  if (!key) return "（未设置）";
  if (key.length <= 8) return "********";
  return key.substring(0, 3) + "***" + key.substring(key.length - 4);
}

function maskApiKeyFull() {
  return "********";
}

// ---- Modal ----

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

// ---- Embed ----

function buildPresetEmbed(presetValues, presetName, options = {}) {
  const { viewerUserId, ownerId, isPublic } = options;
  const isOwner = !ownerId || viewerUserId === ownerId;

  let apiKeyDisplay;
  if (!presetValues.apiKey) {
    apiKeyDisplay = "（未设置）";
  } else if (!isOwner && isPublic) {
    apiKeyDisplay = maskApiKeyFull();
  } else {
    apiKeyDisplay = maskApiKey(presetValues.apiKey);
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
    fields.push({ name: "创建者", value: `<@${ownerId}>`, inline: true });
  }

  return {
    color: isPublic ? 0x2ecc71 : 0x3498db,
    title: titleParts.join(""),
    fields,
    footer: { text: "请确认参数后点击下方按钮操作" },
    timestamp: new Date().toISOString(),
  };
}

// ---- ActionRow ----

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

// ---- 管理面板组件 ----

/**
 * 构建管理面板 Embed — 展示当前已授权身份组列表
 */
function buildPanelEmbed(authorizedRoleIds) {
  const lines =
    authorizedRoleIds.length > 0
      ? authorizedRoleIds.map((rid) => `• <@&${rid}>`).join("\n")
      : "（暂无授权身份组）";

  return {
    color: 0x9b59b6,
    title: "⚙️ 总结预设授权管理面板",
    description: `**当前已授权的身份组 (全局)：**\n${lines}\n\n使用下方菜单**添加**或**移除**授权身份组。`,
    footer: { text: "仅管理员可操作" },
  };
}

/**
 * 构建添加授权的 RoleSelectMenu
 */
function buildPanelAddRoleSelect() {
  const { RoleSelectMenuBuilder, ActionRowBuilder } = require("discord.js");

  return new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId("preset_panel_add_role")
      .setPlaceholder("➕ 添加授权身份组..."),
  );
}

/**
 * 构建移除授权的 StringSelectMenu（枚举已授权 role）
 */
function buildPanelRemoveRoleSelect(authorizedRoleIds) {
  const { StringSelectMenuBuilder, ActionRowBuilder } = require("discord.js");

  if (!authorizedRoleIds || authorizedRoleIds.length === 0) return null;

  const options = authorizedRoleIds.slice(0, 25).map((rid) => ({
    label: `移除: ${rid}`,
    value: rid,
  }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("preset_panel_remove_role")
      .setPlaceholder("➖ 移除授权身份组...")
      .addOptions(options),
  );
}

module.exports = {
  createEditPresetModal,
  buildPresetEmbed,
  buildPresetActionRow,
  maskApiKey,
  buildPanelEmbed,
  buildPanelAddRoleSelect,
  buildPanelRemoveRoleSelect,
};
