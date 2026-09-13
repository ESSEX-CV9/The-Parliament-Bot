const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const service = require("../services/discussionPresetService");
const {
  buildDiscussionPresetEmbed, buildDiscussionPresetActionRow,
} = require("../components/discussionPresetComponents");

const data = new SlashCommandBuilder()
  .setName("讨论专用总结预设")
  .setDescription("保存、使用或删除本服务器共享的讨论总结预设")
  .setDMPermission(false)
  .addSubcommand(sub => {
    sub.setName("保存").setDescription("保存或覆盖本服务器的讨论专用预设")
      .addStringOption(o => o.setName("名称").setDescription("预设名称").setRequired(true).setMaxLength(100));
    for (const [name, description, maxLength] of [
      ["开始时间", "默认开始时间 (YYYY-MM-DD HH:mm)", 100],
      ["结束时间", "默认结束时间 (YYYY-MM-DD HH:mm)", 100],
      ["模型", "默认模型名称", 1000],
      ["url", "OpenAI 兼容接口地址", 1000],
      ["api", "API Key", 4000],
      ["额外提示词", "默认附加提示词", 4000],
    ]) {
      sub.addStringOption(o => o.setName(name).setDescription(description).setMaxLength(maxLength));
    }
    return sub;
  })
  .addSubcommand(sub => sub.setName("使用").setDescription("使用讨论专用预设执行频道总结")
    .addStringOption(o => o.setName("名称").setDescription("预设名称").setRequired(true).setMaxLength(100).setAutocomplete(true)))
  .addSubcommand(sub => sub.setName("删除").setDescription("删除本服务器的讨论专用预设")
    .addStringOption(o => o.setName("名称").setDescription("预设名称").setRequired(true).setMaxLength(100).setAutocomplete(true)));

async function autocomplete(interaction) {
  if (!interaction.guildId) return interaction.respond([]);
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "名称") return interaction.respond([]);
  const names = service.getPresetNames(interaction.guildId)
    .filter(name => name.toLowerCase().includes(focused.value.toLowerCase())).slice(0, 25);
  return interaction.respond(names.map(name => ({ name, value: name })));
}

async function execute(interaction) {
  const guildId = interaction.guildId;
  const reply = content => interaction.reply({ content, flags: MessageFlags.Ephemeral });
  if (!guildId) return reply("❌ 请在服务器中使用此命令。");
  const name = interaction.options.getString("名称");
  switch (interaction.options.getSubcommand()) {
    case "保存": {
      const values = {
        startTime: interaction.options.getString("开始时间") || "",
        endTime: interaction.options.getString("结束时间") || "",
        model: interaction.options.getString("模型") || "",
        apiBaseUrl: (interaction.options.getString("url") || "").trim(),
        apiKey: (interaction.options.getString("api") || "").trim(),
        extraPrompt: interaction.options.getString("额外提示词") || "",
      };
      if (values.apiBaseUrl && !values.apiKey) {
        return reply("❌ 使用自定义 URL 时请同时填写 API Key，以免将机器人的默认密钥发送到其他地址。");
      }
      const isNew = service.savePreset(guildId, name, values, interaction.user.id);
      return reply(`✅ 讨论专用预设「${name}」已${isNew ? "保存" : "更新"}。`);
    }
    case "删除":
      return reply(service.deletePreset(guildId, name)
        ? `✅ 讨论专用预设「${name}」已删除。` : `❌ 未找到讨论专用预设「${name}」。`);
    case "使用": {
      const preset = service.getPreset(guildId, name);
      if (!preset) return reply(`❌ 未找到讨论专用预设「${name}」。`);
      const flowId = service.generateFlowId();
      service.createFlow(flowId, { ...preset, presetName: name, channelId: interaction.channelId });
      return interaction.reply({
        embeds: [buildDiscussionPresetEmbed(preset, name)],
        components: [buildDiscussionPresetActionRow(flowId)],
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}

module.exports = { data, execute, autocomplete };
