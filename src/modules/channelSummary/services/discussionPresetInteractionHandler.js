const { MessageFlags } = require("discord.js");
const service = require("./discussionPresetService");
const { runPresetSummary } = require("./presetInteractionHandler");
const {
  buildDiscussionPresetEmbed, buildDiscussionPresetActionRow, createDiscussionEditModal,
} = require("../components/discussionPresetComponents");

function getSession(interaction, id) {
  const flow = service.getFlow(id);
  // 仅校验会话上下文，防止参数在不同服务器/频道之间串用。
  return flow && flow.guildId === interaction.guildId && flow.channelId === interaction.channelId ? flow : null;
}
function expired(interaction) {
  return interaction.reply({
    content: "❌ 该讨论专用预设会话已过期，请重新使用 `/讨论专用总结预设 使用`。",
    flags: MessageFlags.Ephemeral,
  });
}

async function handleDiscussionPresetButton(interaction) {
  const match = /^discussion_preset_(confirm|edit|cancel)_(.+)$/.exec(interaction.customId);
  if (!match) return;
  const [, action, id] = match;
  const flow = getSession(interaction, id);
  if (!flow) return expired(interaction);
  if (action === "edit") return interaction.showModal(createDiscussionEditModal(id, flow));
  if (action === "confirm" && flow.apiBaseUrl && !flow.apiKey?.trim()) {
    return interaction.reply({
      content: "❌ 自定义 URL 必须配套 API Key。请重新保存讨论专用预设并填写 API Key 后使用。",
      flags: MessageFlags.Ephemeral,
    });
  }
  service.deleteFlow(id);
  if (action === "cancel") {
    return interaction.update({ content: "❌ 已取消讨论专用预设操作。", embeds: [], components: [] });
  }
  await interaction.deferUpdate();
  return runPresetSummary(interaction, flow);
}

async function handleDiscussionPresetModal(interaction) {
  const prefix = "discussion_preset_edit_modal_";
  if (!interaction.customId.startsWith(prefix)) return;
  const id = interaction.customId.slice(prefix.length);
  if (!getSession(interaction, id)) return expired(interaction);
  const values = {};
  for (const key of ["startTime", "endTime", "model", "extraPrompt"]) {
    values[key] = interaction.fields.getTextInputValue(`discussion_preset_${key}`);
  }
  const flow = service.updateFlowValues(id, values);
  const payload = {
    embeds: [buildDiscussionPresetEmbed(flow, flow.presetName)],
    components: [buildDiscussionPresetActionRow(id)],
  };
  try {
    await interaction.update(payload);
  } catch {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }
}

module.exports = { handleDiscussionPresetButton, handleDiscussionPresetModal };
