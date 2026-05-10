// src/modules/channelSummary/commands/summaryPreset.js

const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const presetService = require("../services/presetService");
const perm = require("../services/permissionService");
const config = require("../config/presetConfig");
const {
  buildPresetEmbed,
  buildPresetActionRow,
  buildPanelEmbed,
  buildPanelAddRoleSelect,
  buildPanelRemoveRoleSelect,
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
    sub.setName("列表").setDescription("列出你可用的所有预设"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("删除")
      .setDescription("删除一个预设")
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
  )
  .addSubcommand((sub) =>
    sub.setName("管理").setDescription("管理全局授权身份组（仅限管理员）"),
  );

// ---- Autocomplete ----
async function autocomplete(interaction) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand !== "删除" && subcommand !== "使用") return;

  const focused = interaction.options.getFocused(true);
  if (focused.name !== "名称") return;

  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const level = perm.getPermissionLevel(interaction.member, guildId);

  let presets;
  if (subcommand === "删除") {
    if (level === "admin") {
      // Admin: 看到所有预设（公用 + 私用）
      presets = presetService.getAllPresets(guildId);
    } else if (level === "authorized") {
      // 授权用户：只看到自己创建的私用预设
      const own = presetService.getUserPresets(guildId, userId, false);
      presets = {};
      for (const [name, p] of Object.entries(own)) {
        if (p.ownerId === userId && !p.isPublic) {
          presets[name] = p;
        }
      }
    } else {
      return interaction.respond([]);
    }
  } else {
    // 使用：normal 无法使用；admin/authorized 显示自己的私用 + 全体公用
    if (level === "normal") return interaction.respond([]);
    presets = presetService.getUserPresets(guildId, userId, true);
  }

  const presetNames = Object.keys(presets || {});
  const filtered = presetNames
    .filter((n) => n.toLowerCase().includes(focused.value.toLowerCase()))
    .slice(0, 25);

  await interaction.respond(filtered.map((n) => ({ name: n, value: n })));
}

// ---- 保存 ----
async function handleSave(interaction) {
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const presetName = interaction.options.getString("名称");
  const isPublic = interaction.options.getBoolean("公开") || false;

  const level = perm.getPermissionLevel(interaction.member, guildId);
  if (level === "normal") {
    return interaction.reply({ content: perm.PERM_DENIED, flags: MessageFlags.Ephemeral });
  }

  if (isPublic) {
    const publicCount = presetService.getPublicPresetCount(guildId);
    if (publicCount >= config.MAX_PUBLIC_PRESETS_PER_GUILD) {
      return interaction.reply({
        content: `❌ 全服公用预设已达上限（${config.MAX_PUBLIC_PRESETS_PER_GUILD} 条）。`,
        flags: MessageFlags.Ephemeral,
      });
    }
  } else {
    const privateCount = presetService.getPresetCount(guildId, userId);
    if (privateCount >= config.MAX_PRIVATE_PRESETS_PER_USER) {
      return interaction.reply({
        content: `❌ 你的私有预设已达上限（${config.MAX_PRIVATE_PRESETS_PER_USER} 条）。`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

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

// ---- 列表 ----
async function handleList(interaction) {
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;

  const level = perm.getPermissionLevel(interaction.member, guildId);
  if (level === "normal") {
    return interaction.reply({ content: perm.PERM_DENIED, flags: MessageFlags.Ephemeral });
  }

  const isAuth = level === "admin" || level === "authorized";
  const presets = presetService.getUserPresets(guildId, userId, isAuth);
  const names = Object.keys(presets);

  if (names.length === 0) {
    return interaction.reply({
      content: "📭 你还没有保存任何预设，且当前没有可用的公开预设。",
      flags: MessageFlags.Ephemeral,
    });
  }

  const lines = names.map((n) => {
    const p = presets[n];
    const isOwn = p.ownerId === userId;
    const icon = p.isPublic ? "🌍" : "🔒";
    const ownerHint = isOwn ? "" : ` (by <@${p.ownerId}>)`;
    return `• ${icon} **${n}**${ownerHint}`;
  });

  const ownCount = names.filter((n) => presets[n].ownerId === userId).length;
  const publicCount = names.length - ownCount;

  const embed = {
    color: 0x3498db,
    title: "📋 可用频道总结预设",
    description: lines.join("\n"),
    footer: {
      text: `私有 ${ownCount}/${config.MAX_PRIVATE_PRESETS_PER_USER} | 可用公开 ${publicCount} 个`,
    },
  };

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ---- 删除 ----
async function handleDelete(interaction) {
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const presetName = interaction.options.getString("名称");

  const level = perm.getPermissionLevel(interaction.member, guildId);
  if (level === "normal") {
    return interaction.reply({ content: perm.PERM_DENIED, flags: MessageFlags.Ephemeral });
  }

  let preset;

  if (level === "admin") {
    // Admin: 可以看到并删除所有预设
    const allPresets = presetService.getAllPresets(guildId);
    preset = allPresets[presetName] || null;
  } else {
    // 授权用户: 只能从自己的私用预设中查找
    const ownPresets = presetService.getUserPresets(guildId, userId, false);
    const candidate = ownPresets[presetName];
    if (candidate && candidate.ownerId === userId && !candidate.isPublic) {
      preset = candidate;
    }
  }

  if (!preset) {
    return interaction.reply({
      content: `❌ 未找到预设「${presetName}」。`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // 非 Admin 尝试删除公用预设 → 拒绝
  if (preset.isPublic && level !== "admin") {
    return interaction.reply({ content: perm.PERM_DENIED, flags: MessageFlags.Ephemeral });
  }

  let deleted;
  if (level === "admin" && preset.ownerId !== userId) {
    deleted = presetService.forceDeletePreset(guildId, presetName);
  } else {
    deleted = presetService.deletePreset(guildId, userId, presetName);
  }

  return interaction.reply({
    content: deleted
      ? `✅ 预设「${presetName}」已删除。`
      : `❌ 删除失败。`,
    flags: MessageFlags.Ephemeral,
  });
}

// ---- 使用 ----
async function handleUse(interaction) {
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const presetName = interaction.options.getString("名称");

  const level = perm.getPermissionLevel(interaction.member, guildId);
  if (level === "normal") {
    return interaction.reply({ content: perm.PERM_DENIED, flags: MessageFlags.Ephemeral });
  }

  const isAuth = level === "admin" || level === "authorized";
  const preset = presetService.getPreset(guildId, userId, presetName, isAuth);
  if (!preset) {
    return interaction.reply({
      content: `❌ 未找到预设「${presetName}」。`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // 私有预设：仅主人可用
  if (!preset.isPublic && preset.ownerId !== userId) {
    return interaction.reply({ content: perm.PERM_DENIED, flags: MessageFlags.Ephemeral });
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

// ---- 管理面板 ----
async function handleManage(interaction) {
  const guildId = interaction.guild.id;

  const level = perm.getPermissionLevel(interaction.member, guildId);
  if (level !== "admin") {
    return interaction.reply({ content: perm.PERM_DENIED, flags: MessageFlags.Ephemeral });
  }

  const authorizedRoles = presetService.getAllAuthorizedRoles();
  const embed = buildPanelEmbed(authorizedRoles);

  const components = [];
  components.push(buildPanelAddRoleSelect());
  const removeSelect = buildPanelRemoveRoleSelect(authorizedRoles);
  if (removeSelect) components.push(removeSelect);

  return interaction.reply({
    embeds: [embed],
    components,
    flags: MessageFlags.Ephemeral,
  });
}

// ---- 主入口 ----
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
    case "管理":
      return handleManage(interaction);
    default:
      return interaction.reply({
        content: "❌ 未知子命令。",
        flags: MessageFlags.Ephemeral,
      });
  }
}

module.exports = { data, execute, autocomplete };
