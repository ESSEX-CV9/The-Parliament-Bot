// src/modules/channelSummary/commands/summarizeChannel.js

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  AttachmentBuilder,
} = require("discord.js");
const { parseTimeInput, validateTimeRange } = require("../utils/timeParser");
const { collectMessages } = require("../services/messageCollector");
const { generateSummary } = require("../services/aiSummaryService");
const {
  generateMessagesJSON,
  saveToTempFile,
  cleanupTempFiles,
} = require("../services/jsonExporter");
const {
  formatSummaryForDiscord,
  generateSummaryText,
  generatePlainTextSummary,
  splitLongText,
  createSummaryTextFile,
} = require("../utils/summaryFormatter");
const config = require("../config/summaryConfig");

/**
 * 格式化 Date → "YYYY-MM-DD HH:mm"
 */
function formatDateTime(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

/**
 * 为未提供的时间参数填充默认值。
 * 返回 { startTimeStr, endTimeStr, usedDefaultTime }
 */
function applyTimeDefaults(startTimeStr, endTimeStr) {
  const now = new Date();
  let usedDefaultTime = false;

  let resolvedEnd = endTimeStr;
  let resolvedStart = startTimeStr;

  if (!resolvedEnd || !resolvedEnd.trim()) {
    resolvedEnd = formatDateTime(now);
    usedDefaultTime = true;
  }
  if (!resolvedStart || !resolvedStart.trim()) {
    const thirtyDaysAgo = new Date(now.getTime() - config.DEFAULT_TIME_RANGE_DAYS * 24 * 60 * 60 * 1000);
    resolvedStart = formatDateTime(thirtyDaysAgo);
    usedDefaultTime = true;
  }

  return { startTimeStr: resolvedStart, endTimeStr: resolvedEnd, usedDefaultTime };
}

const data = new SlashCommandBuilder()
  .setName("总结频道内容")
  .setDescription("总结指定时间段内的频道消息")
  .addStringOption((option) =>
    option
      .setName("开始时间")
      .setDescription("开始时间 (YYYY-MM-DD HH:mm)，不填默认 30 天前")
      .setRequired(false),
  )
  .addStringOption((option) =>
    option
      .setName("结束时间")
      .setDescription("结束时间 (YYYY-MM-DD HH:mm)，不填默认当前时间")
      .setRequired(false),
  )
  .addStringOption((option) =>
    option
      .setName("模型")
      .setDescription("指定用于总结的AI模型，不填则使用默认模型")
      .setRequired(false),
  )
  .addStringOption((option) =>
    option
      .setName("url")
      .setDescription("可选，OpenAI 兼容接口地址（覆盖默认 Base URL）")
      .setRequired(false),
  )
  .addStringOption((option) =>
    option
      .setName("api")
      .setDescription("可选，API Key（覆盖默认环境变量）")
      .setRequired(false),
  )
  .addStringOption((option) =>
    option
      .setName("额外提示词")
      .setDescription("可选，附加在默认系统提示词之后")
      .setRequired(false),
  );

/**
 * 执行频道总结的核心逻辑，可被 slash command 和 preset flow 共同调用。
 * @param {Interaction} interaction
 * @param {object} params
 * @param {string|null} params.startTimeStr
 * @param {string|null} params.endTimeStr
 * @param {string|null} params.model
 * @param {string|null} params.apiBaseUrl
 * @param {string|null} params.apiKey
 * @param {string|null} params.extraPrompt
 * @param {object} [params.channel]
 */
async function executeSummary(interaction, params) {
  if (!interaction || !interaction.isRepliable()) {
    console.error("无效的交互对象");
    return;
  }

  let channel = params.channel || interaction.channel;
  if (!channel) {
    try {
      channel = await interaction.guild.channels.fetch(interaction.channelId);
    } catch (error) {
      console.error("无法获取频道信息:", error);
      return;
    }
  }

  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (deferError) {
    console.error("Defer回复失败:", deferError);
    try {
      await interaction.reply({
        content: "❌ 交互已过期，请重新尝试命令。",
        ephemeral: true,
      });
    } catch (replyError) {
      console.error("直接回复也失败:", replyError);
    }
    return;
  }

  if (!channel) {
    return await interaction.editReply(
      "❌ 无法获取频道信息，请确保在正确的频道中使用此命令。",
    );
  }

  const isValidChannel =
    channel.isTextBased() ||
    (channel.isThread && channel.isThread()) ||
    channel.type === 0 ||
    channel.type === 11;

  if (!isValidChannel) {
    return await interaction.editReply(
      "❌ 此命令只能在文字频道或线程中使用。",
    );
  }

  const { model, apiBaseUrl, apiKey, extraPrompt } = params;

  // 应用时间默认值
  const { startTimeStr, endTimeStr, usedDefaultTime } = applyTimeDefaults(
    params.startTimeStr,
    params.endTimeStr,
  );

  const startTime = parseTimeInput(startTimeStr);
  const endTime = parseTimeInput(endTimeStr);
  validateTimeRange(startTime, endTime, config.MAX_TIME_RANGE_DAYS);

  // 进度消息：若使用了默认时间，追加说明
  let collectingMsg = "⏳ 开始收集消息...";
  if (usedDefaultTime) {
    collectingMsg += `\n> 📌 未检测到时间参数，已自动拉取本频道近 ${config.DEFAULT_TIME_RANGE_DAYS} 天内的消息（上限 ${config.MAX_MESSAGES} 条）进行总结。`;
  }
  await interaction.editReply(collectingMsg);

  const messages = await collectMessages(
    channel,
    startTime,
    endTime,
    config.MAX_MESSAGES,
  );

  if (messages.length === 0) {
    return await interaction.editReply(
      "❌ 在指定时间范围内没有找到任何消息。",
    );
  }

  await interaction.editReply(
    `📊 收集到 ${messages.length} 条消息，正在生成AI总结...`,
  );

  const channelInfo = {
    id: channel.id,
    name: channel.name || "未命名频道",
    type: channel.type,
    timeRange: {
      start: startTime.toISOString(),
      end: endTime.toISOString(),
    },
  };

  const aiSummary = await generateSummary(messages, channelInfo, model, {
    apiBaseUrl,
    apiKey,
    extraPrompt,
  });

  await interaction.editReply("📝 正在生成文件和总结...");

  const messagesData = generateMessagesJSON(channelInfo, messages);
  const fileInfo = await saveToTempFile(messagesData, channelInfo.name);

  const attachment = new AttachmentBuilder(fileInfo.filePath, {
    name: fileInfo.fileName,
  });

  cleanupTempFiles(config.FILE_RETENTION_HOURS).catch(console.warn);

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
      {
        name: "时间范围",
        value: `${startTimeStr} 至 ${endTimeStr}`,
        inline: false,
      },
      {
        name: "文件大小",
        value: `${Math.round(fileInfo.size / 1024)} KB`,
        inline: true,
      },
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
}

async function execute(interaction) {
  try {
    const startTimeStr = interaction.options.getString("开始时间");
    const endTimeStr = interaction.options.getString("结束时间");
    const model = interaction.options.getString("模型");
    const apiBaseUrl = interaction.options.getString("url");
    const apiKey = interaction.options.getString("api");
    const extraPrompt = interaction.options.getString("额外提示词");

    await executeSummary(interaction, {
      startTimeStr,
      endTimeStr,
      model,
      apiBaseUrl,
      apiKey,
      extraPrompt,
    });
  } catch (error) {
    console.error("频道总结命令执行失败:", error);

    const errorMessage =
      error.message.includes("不支持的时间格式") ||
      error.message.includes("无效的时间") ||
      error.message.includes("时间范围")
        ? error.message
        : "执行总结时发生错误，请稍后重试。";

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(`❌ ${errorMessage}`);
      } else {
        await interaction.reply({
          content: `❌ ${errorMessage}`,
          ephemeral: true,
        });
      }
    } catch (replyError) {
      console.error("错误回复失败:", replyError);
    }
  }
}

module.exports = {
  data,
  execute,
  executeSummary,
  applyTimeDefaults,
  formatDateTime,
};
