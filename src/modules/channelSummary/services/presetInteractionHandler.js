// src/modules/channelSummary/services/presetInteractionHandler.js

const { MessageFlags, AttachmentBuilder } = require("discord.js");
const presetService = require("./presetService");
const perm = require("./permissionService");
const {
  buildPresetEmbed,
  buildPresetActionRow,
  createEditPresetModal,
  buildPanelEmbed,
  buildPanelAddRoleSelect,
  buildPanelRemoveRoleSelect,
} = require("../components/presetComponents");
const { parseTimeInput, validateTimeRange } = require("../utils/timeParser");
const { collectMessages } = require("./messageCollector");
const { generateSummary } = require("./aiSummaryService");
const {
  generateMessagesJSON,
  saveToTempFile,
  cleanupTempFiles,
} = require("./jsonExporter");
const {
  generatePlainTextSummary,
  splitLongText,
  createSummaryTextFile,
} = require("../utils/summaryFormatter");
const summaryConfig = require("../config/summaryConfig");
const { applyTimeDefaults } = require("../commands/summarizeChannel");

// ---- 按钮处理 ----
async function handlePresetButton(interaction) {
  const customId = interaction.customId;

  if (customId.startsWith("preset_confirm_")) {
    return handleConfirm(interaction);
  } else if (customId.startsWith("preset_edit_")) {
    return handleEdit(interaction);
  } else if (customId.startsWith("preset_cancel_")) {
    return handleCancel(interaction);
  }
}

async function handleConfirm(interaction) {
  const flowId = interaction.customId.replace("preset_confirm_", "");
  const flow = presetService.getFlow(flowId);

  if (!flow) {
    return interaction.reply({
      content: "❌ 该预设会话已过期，请重新使用 `/总结预设 使用`。",
      flags: MessageFlags.Ephemeral,
    });
  }

  presetService.deleteFlow(flowId);
  await interaction.deferUpdate();
  await runPresetSummary(interaction, flow);
}

async function runPresetSummary(interaction, flow) {
  try {
    let channel = interaction.channel;
    if (!channel) {
      try {
        channel = await interaction.guild.channels.fetch(interaction.channelId);
      } catch {
        await interaction.editReply({
          content: "❌ 无法获取频道信息。",
          embeds: [],
          components: [],
        });
        return;
      }
    }

    const { startTimeStr, endTimeStr, usedDefaultTime } = applyTimeDefaults(
      flow.startTime,
      flow.endTime,
    );

    const startTime = parseTimeInput(startTimeStr);
    const endTime = parseTimeInput(endTimeStr);
    validateTimeRange(startTime, endTime, summaryConfig.MAX_TIME_RANGE_DAYS);

    let collectingMsg = "⏳ 开始收集消息...";
    if (usedDefaultTime) {
      collectingMsg += `\n> 📌 预设未设置完整时间参数，已自动拉取本频道近 ${summaryConfig.DEFAULT_TIME_RANGE_DAYS} 天内的消息（上限 ${summaryConfig.MAX_MESSAGES} 条）进行总结。`;
    }
    await interaction.editReply({
      content: collectingMsg,
      embeds: [],
      components: [],
    });

    const messages = await collectMessages(
      channel,
      startTime,
      endTime,
      summaryConfig.MAX_MESSAGES,
    );

    if (messages.length === 0) {
      return await interaction.editReply({
        content: "❌ 在指定时间范围内没有找到任何消息。",
        embeds: [],
        components: [],
      });
    }

    await interaction.editReply({
      content: `📊 收集到 ${messages.length} 条消息，正在生成AI总结...`,
      embeds: [],
      components: [],
    });

    const channelInfo = {
      id: channel.id,
      name: channel.name || "未命名频道",
      type: channel.type,
      timeRange: {
        start: startTime.toISOString(),
        end: endTime.toISOString(),
      },
    };

    const aiSummary = await generateSummary(
      messages,
      channelInfo,
      flow.model || null,
      {
        apiBaseUrl: flow.apiBaseUrl || null,
        apiKey: flow.apiKey || null,
        extraPrompt: flow.extraPrompt || null,
      },
    );

    await interaction.editReply({
      content: "📝 正在生成文件和总结...",
      embeds: [],
      components: [],
    });

    const messagesData = generateMessagesJSON(channelInfo, messages);
    const fileInfo = await saveToTempFile(messagesData, channelInfo.name);

    const attachment = new AttachmentBuilder(fileInfo.filePath, {
      name: fileInfo.fileName,
    });

    cleanupTempFiles(summaryConfig.FILE_RETENTION_HOURS).catch(console.warn);

    const completionEmbed = {
      color: 0x00ff00,
      title: "✅ 频道内容总结完成",
      fields: [
        { name: "频道", value: channelInfo.name, inline: true },
        { name: "消息数量", value: messages.length.toString(), inline: true },
        {
          name: "参与用户",
          value: aiSummary.participant_stats.total_participants.toString(),
          inline: true,
        },
        { name: "时间范围", value: `${startTimeStr} 至 ${endTimeStr}`, inline: false },
        { name: "文件大小", value: `${Math.round(fileInfo.size / 1024)} KB`, inline: true },
      ],
      description: "📁 消息数据已导出到JSON文件\n🤖 AI总结将以公开消息发送",
      timestamp: new Date().toISOString(),
    };

    await interaction.editReply({
      content: "处理完成！AI总结即将以公开消息发送...",
      embeds: [completionEmbed],
      files: [attachment],
    });

    const plainTextSummary = generatePlainTextSummary(
      aiSummary,
      channelInfo,
      messages.length,
    );
    const summaryParts = splitLongText(plainTextSummary);

    await interaction.channel.send(
      `📋 **频道内容总结** (由 ${interaction.user.displayName} 发起)\n` +
        `⏰ 时间范围: ${startTimeStr} 至 ${endTimeStr}`,
    );

    for (let i = 0; i < summaryParts.length; i++) {
      const part = summaryParts[i];
      const isLastPart = i === summaryParts.length - 1;

      if (isLastPart && summaryParts.length > 1) {
        try {
          const textFile = await createSummaryTextFile(
            aiSummary,
            channelInfo,
            messages.length,
          );
          const textAttachment = new AttachmentBuilder(textFile.filePath, {
            name: textFile.fileName,
          });
          await interaction.channel.send({
            content: `${part}\n\n📄 **完整总结已保存为文件**`,
            files: [textAttachment],
          });
        } catch (fileError) {
          console.warn("创建文本文件失败:", fileError);
          await interaction.channel.send(part);
        }
      } else {
        await interaction.channel.send(part);
      }

      if (i < summaryParts.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  } catch (error) {
    console.error("预设总结执行失败:", error);
    const errorMessage =
      error.message.includes("不支持的时间格式") ||
      error.message.includes("无效的时间") ||
      error.message.includes("时间范围")
        ? error.message
        : "执行总结时发生错误，请稍后重试。";
    try {
      await interaction.editReply({
        content: `❌ ${errorMessage}`,
        embeds: [],
        components: [],
      });
    } catch {
      try {
        await interaction.followUp({
          content: `❌ ${errorMessage}`,
          flags: MessageFlags.Ephemeral,
        });
      } catch { /* 忽略 */ }
    }
  }
}

async function handleEdit(interaction) {
  const flowId = interaction.customId.replace("preset_edit_", "");
  const flow = presetService.getFlow(flowId);

  if (!flow) {
    return interaction.reply({
      content: "❌ 该预设会话已过期。",
      flags: MessageFlags.Ephemeral,
    });
  }

  const modal = createEditPresetModal(flowId, {
    startTime: flow.startTime,
    endTime: flow.endTime,
    model: flow.model,
    extraPrompt: flow.extraPrompt,
  });

  await interaction.showModal(modal);
}

async function handleCancel(interaction) {
  const flowId = interaction.customId.replace("preset_cancel_", "");
  presetService.deleteFlow(flowId);

  if (interaction.message) {
    await interaction.update({
      content: "❌ 已取消预设操作。",
      embeds: [],
      components: [],
    });
  } else {
    await interaction.reply({
      content: "❌ 已取消预设操作。",
      flags: MessageFlags.Ephemeral,
    });
  }
}

// ---- Modal 处理 ----
async function handlePresetModal(interaction) {
  const flowId = interaction.customId.replace("preset_edit_modal_", "");
  const flow = presetService.getFlow(flowId);

  if (!flow) {
    return interaction.reply({
      content: "❌ 该预设会话已过期。",
      flags: MessageFlags.Ephemeral,
    });
  }

  const newStartTime = interaction.fields.getTextInputValue("preset_startTime");
  const newEndTime = interaction.fields.getTextInputValue("preset_endTime");
  const newModel = interaction.fields.getTextInputValue("preset_model");
  const newExtraPrompt = interaction.fields.getTextInputValue("preset_extraPrompt");

  presetService.updateFlowValues(flowId, {
    startTime: newStartTime,
    endTime: newEndTime,
    model: newModel,
    extraPrompt: newExtraPrompt,
  });

  const updatedFlow = presetService.getFlow(flowId);

  const embed = buildPresetEmbed(
    {
      startTime: updatedFlow.startTime,
      endTime: updatedFlow.endTime,
      model: updatedFlow.model,
      apiBaseUrl: updatedFlow.apiBaseUrl,
      apiKey: updatedFlow.apiKey,
      extraPrompt: updatedFlow.extraPrompt,
    },
    updatedFlow.presetName,
    {
      viewerUserId: interaction.user.id,
      ownerId: updatedFlow.ownerId,
      isPublic: updatedFlow.isPublic,
    },
  );
  const row = buildPresetActionRow(flowId);

  try {
    await interaction.update({ embeds: [embed], components: [row] });
  } catch {
    await interaction.reply({
      embeds: [embed],
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  }
}

// ---- 管理面板选择菜单处理 ----
async function handlePresetSelect(interaction) {
  const guildId = interaction.guild.id;
  const customId = interaction.customId;

  const level = perm.getPermissionLevel(interaction.member, guildId);
  if (level !== "admin") {
    return interaction.reply({ content: perm.PERM_DENIED, flags: MessageFlags.Ephemeral });
  }

  const authorizedRoles = presetService.getAllAuthorizedRoles();

  if (customId === "preset_panel_add_role") {
    // 添加授权身份组
    const roleId = interaction.values[0];
    presetService.addAuthorizedRole(roleId);

    const updatedRoles = presetService.getAllAuthorizedRoles();
    const embed = buildPanelEmbed(updatedRoles);
    embed.description += `\n\n✅ 已添加授权身份组 <@&${roleId}>。`;

    const components = [];
    components.push(buildPanelAddRoleSelect());
    const removeSelect = buildPanelRemoveRoleSelect(updatedRoles);
    if (removeSelect) components.push(removeSelect);

    await interaction.update({ embeds: [embed], components });

  } else if (customId === "preset_panel_remove_role") {
    // 移除授权身份组
    const roleId = interaction.values[0];
    presetService.removeAuthorizedRole(roleId);

    const updatedRoles = presetService.getAllAuthorizedRoles();
    const embed = buildPanelEmbed(updatedRoles);
    embed.description += `\n\n✅ 已移除授权身份组 <@&${roleId}>。`;

    const components = [];
    components.push(buildPanelAddRoleSelect());
    const removeSelect = buildPanelRemoveRoleSelect(updatedRoles);
    if (removeSelect) components.push(removeSelect);

    await interaction.update({ embeds: [embed], components });
  }
}

module.exports = {
  handlePresetButton,
  handlePresetModal,
  handlePresetSelect,
};
