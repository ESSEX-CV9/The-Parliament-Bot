// src/modules/channelSummary/commands/summaryPreset.js

const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const presetService = require("../services/presetService");
const config = require("../config/presetConfig");
const {
  buildPresetEmbed,
  buildPresetActionRow,
} = require("../components/presetComponents");

const data = new SlashCommandBuilder()
  .setName("总结预设")
  .setDescription("管理频道总结的参数预设")
  .addSubcommand((sub) =>
    sub
      .setName("保存")
      .setDescription("保存一组总结参数为预设")
      .addStringOption((o) =>
        o.setName("名称").setDescription("预设名称（唯一标识）").setRequired(true),
      )
      .addStringOption((o) =>
        o.setName("开始时间").setDescription("默认开始时间 (YYYY-MM-DD HH:mm)").setRequired(false),
      )
      .addStringOption((o) =>
        o.setName("结束时间").setDescription("默认结束时间 (YYYY-MM-DD HH:mm)").setRequired(false),
      )
      .addStringOption((o) =>
        o.setName("模型").setDescription("默认模型名称").setRequired(false),
      )
      .addStringOption((o) =>
        o.setName("url").setDescription("OpenAI 兼容接口地址").setRequired(false),
      )
      .addStringOption((o) =>
        o.setName("api").setDescription("API Key").setRequired(false),
      )
      .addStringOption((o) =>
        o.setName("额外提示词").setDescription("默认附加提示词").setRequired(false),
      )
      .addBooleanOption((o) =>
        o.setName("公开").setDescription("是否全服共享此预设（默认仅自己可见）").setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName("列表").setDescription("列出你可用的所有预设（含公开预设）"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("删除")
      .setDescription("删除你的一个预设")
      .addStringOption((o) =>
        o
          .setName("名称")
          .setDescription("要删除的预设名称")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("使用")
      .setDescription("使用一个预设来执行频道总结")
      .addStringOption((o) =>
        o
          .setName("名称")
          .setDescription("要使用的预设名称")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  );

// ---- Autocomplete ----
async function autocomplete(interaction) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand !== "删除" && subcommand !== "使用") return;

  const focused = interaction.options.getFocused(true);
  if (focused.name !== "名称") return;

  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const presets = await presetService.getUserPresets(guildId, userId);
  const presetNames = Object.keys(presets);

  const filtered = presetNames
    .filter((n) => n.toLowerCase().includes(focused.value.toLowerCase()))
    .slice(0, 25);

  await interaction.respond(
    filtered.map((n) => ({ name: n, value: n })),
  );
}

// ---- 保存子命令 ----
async function handleSave(interaction) {
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const presetName = interaction.options.getString("名称");

  const currentCount = await presetService.getPresetCount(guildId, userId);
  if (currentCount >= config.MAX_PRESETS_PER_USER) {
    return interaction.reply({
      content: `❌ 预设数量已达上限（${config.MAX_PRESETS_PER_USER} 个），请先删除旧预设。`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const isPublic = interaction.options.getBoolean("公开") || false;

  const values = {
    startTime: interaction.options.getString("开始时间") || "",
    endTime: interaction.options.getString("结束时间") || "",
    model: interaction.options.getString("模型") || "",
    apiBaseUrl: interaction.options.getString("url") || "",
    apiKey: interaction.options.getString("api") || "",
    extraPrompt: interaction.options.getString("额外提示词") || "",
    isPublic,
  };

  const isNew = await presetService.savePreset(guildId, userId, presetName, values);

  return interaction.reply({
    content: isNew
      ? `✅ 预设「${presetName}」已保存（${isPublic ? "🌍 公开" : "🔒 私有"}）。`
      : `✅ 预设「${presetName}」已更新（${isPublic ? "🌍 公开" : "🔒 私有"}）。`,
    flags: MessageFlags.Ephemeral,
  });
}

// ---- 列表子命令 ----
async function handleList(interaction) {
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const presets = await presetService.getUserPresets(guildId, userId);
  const names = Object.keys(presets);

  if (names.length === 0) {
    return interaction.reply({
      content: "📭 你还没有保存任何预设，且当前没有公开预设可用。使用 `/总结预设 保存` 来创建。",
      flags: MessageFlags.Ephemeral,
    });
  }

  const ownCount = names.filter((n) => presets[n].ownerId === userId).length;
  const publicCount = names.length - ownCount;

  const lines = names.map((n) => {
    const p = presets[n];
    const isOwn = p.ownerId === userId;
    const icon = p.isPublic ? "🌍" : "🔒";
    const ownerHint = isOwn ? "" : ` (by <@${p.ownerId}>)`;
    return `• ${icon} **${n}**${ownerHint}`;
  });

  let footerText = `共 ${names.length} 个可用预设`;
  if (ownCount > 0) footerText += `（私有 ${ownCount}`;
  if (publicCount > 0) footerText += `${ownCount > 0 ? " + " : "（"}公开 ${publicCount}）`;
  else if (ownCount > 0) footerText += "）";
  footerText += ` | 私有上限 ${config.MAX_PRESETS_PER_USER}`;

  const embed = {
    color: 0x3498db,
    title: "📋 可用频道总结预设",
    description: lines.join("\n"),
    footer: { text: footerText },
  };

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ---- 删除子命令 ----
async function handleDelete(interaction) {
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const presetName = interaction.options.getString("名称");

  // 只能删除自己的预设
  const preset = await presetService.getPreset(guildId, userId, presetName);
  if (!preset) {
    return interaction.reply({
      content: `❌ 未找到预设「${presetName}」。`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (preset.isForeign) {
    return interaction.reply({
      content: `❌ 预设「${presetName}」是他人创建的公开预设，你无权删除。`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const deleted = await presetService.deletePreset(guildId, userId, presetName);

  return interaction.reply({
    content: deleted
      ? `✅ 预设「${presetName}」已删除。`
      : `❌ 删除失败，未找到预设「${presetName}」。`,
    flags: MessageFlags.Ephemeral,
  });
}

// ---- 使用子命令 ----
async function handleUse(interaction) {
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const presetName = interaction.options.getString("名称");

  const preset = await presetService.getPreset(guildId, userId, presetName);
  if (!preset) {
    return interaction.reply({
      content: `❌ 未找到预设「${presetName}」。`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const flowId = presetService.generateFlowId();
  presetService.createFlow(flowId, {
    guildId,
    channelId: interaction.channelId,
    userId,
    presetName,
    startTime: preset.startTime,
    endTime: preset.endTime,
    model: preset.model,
    apiBaseUrl: preset.apiBaseUrl,
    apiKey: preset.apiKey,
    extraPrompt: preset.extraPrompt,
    isPublic: preset.isPublic || false,
    ownerId: preset.ownerId,
    createdAt: new Date().toISOString(),
  });

  const embed = buildPresetEmbed(
    {
      startTime: preset.startTime,
      endTime: preset.endTime,
      model: preset.model,
      apiBaseUrl: preset.apiBaseUrl,
      apiKey: preset.apiKey,
      extraPrompt: preset.extraPrompt,
    },
    presetName,
    {
      viewerUserId: userId,
      ownerId: preset.ownerId,
      isPublic: preset.isPublic,
    },
  );
  const row = buildPresetActionRow(flowId);

  return interaction.reply({
    embeds: [embed],
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

// ---- 主执行入口 ----
async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case "保存":
      return handleSave(interaction);
    case "列表":
      return handleList(interaction);
    case "删除":
      return handleDelete(interaction);
    case "使用":
      return handleUse(interaction);
    default:
      return interaction.reply({
        content: "❌ 未知子命令。",
        flags: MessageFlags.Ephemeral,
      });
  }
}

module.exports = { data, execute, autocomplete };
