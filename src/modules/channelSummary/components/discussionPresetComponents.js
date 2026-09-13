const {
  buildPresetEmbed, buildPresetActionRow, createEditPresetModal,
} = require("./presetComponents");

function buildDiscussionPresetEmbed(values, name) {
  const embed = buildPresetEmbed(values, name);
  // Discord Embed 字段最多 1024 字符；完整参数仍保存在 flow 中。
  embed.fields = embed.fields.map(field => ({
    ...field,
    value: field.value.length > 1024 ? field.value.slice(0, 1021) + "..." : field.value,
  }));
  return embed;
}

function buildDiscussionPresetActionRow(flowId) {
  const row = buildPresetActionRow(flowId);
  for (const button of row.components) {
    button.setCustomId(`discussion_${button.data.custom_id}`);
  }
  return row;
}

function createDiscussionEditModal(flowId, values) {
  const modal = createEditPresetModal(flowId, values)
    .setCustomId(`discussion_preset_edit_modal_${flowId}`);
  for (const row of modal.components) {
    for (const input of row.components) {
      input.setCustomId(`discussion_${input.data.custom_id}`);
      // 留空继续使用频道总结已有的默认时间。
      input.setRequired(false);
    }
  }
  return modal;
}

module.exports = {
  buildDiscussionPresetEmbed, buildDiscussionPresetActionRow, createDiscussionEditModal,
};
