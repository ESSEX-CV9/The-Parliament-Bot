// src/modules/channelSummary/services/aiSummaryService.js

const { OpenAI } = require("openai");
const config = require("../config/summaryConfig");

function createAIClient(options = {}) {
  const baseURL = (
    options.baseURL ||
    config.OPENAI_API_CONFIG.BASE_URL ||
    ""
  ).trim();
  const apiKey = (
    options.apiKey ||
    config.OPENAI_API_CONFIG.API_KEY ||
    ""
  ).trim();

  if (!apiKey) {
    throw new Error(
      "缺少 API Key，请通过环境变量 OPENAI_API_KEY 或命令参数 api 提供。",
    );
  }

  const clientOptions = { apiKey };
  if (baseURL) {
    clientOptions.baseURL = baseURL;
  }

  return new OpenAI(clientOptions);
}

async function generateSummary(messages, channelInfo, options = {}) {
  try {
    const ai = createAIClient(options);
    const promptMessages = buildOpenAISummaryPrompt(
      messages,
      channelInfo,
      options.extraPrompt,
    );
    const targetModel = options.model || config.OPENAI_API_CONFIG.MODEL;

    const response = await ai.chat.completions.create({
      model: targetModel,
      messages: promptMessages,
    });

    const summaryText = response.choices[0]?.message?.content || "";
    if (!summaryText) {
      throw new Error("AI 响应为空");
    }

    return parseSummaryResponse(summaryText, messages);
  } catch (error) {
    console.error("AI summary generation failed:", error);
    return generateFallbackSummary(messages, channelInfo);
  }
}

function buildOpenAISummaryPrompt(messages, channelInfo, extraPrompt = null) {
  const userMessages = {};

  messages.forEach((msg) => {
    const username = msg.author.display_name;
    if (!userMessages[username]) {
      userMessages[username] = [];
    }
    userMessages[username].push(msg.content);
  });

  const userSummaries = Object.entries(userMessages)
    .map(([username, msgs]) => `${username}: ${msgs.join(" ")}`)
    .join("\n\n");

  let systemPrompt = `你是一个专业的 Discord 聊天分析助手。请对以下聊天记录进行详细分析，总结核心话题、关键信息以及每个主要参与用户的发言要点。

请用中文提供详细的总结分析，并严格遵循以下格式：

## 讨论概览
（在这里对整体讨论的背景、氛围和主要议题进行概括性描述）

## 用户发言分析
（针对每一个活跃用户，详细分析其发言的主要观点、关注重点。对于发言较少或无实质内容的用户可以简略或忽略）

## 核心话题总结
（在这里提炼出 2-3 个最主要的讨论话题和相关结论）

## 关键信息汇总
（在这里列出讨论中产生的任何重要决定、计划、约定或有价值的结论性信息）

请确保分析客观、详细且有深度，能够准确反映出讨论的全貌。`;

  const trimmedExtraPrompt =
    typeof extraPrompt === "string" ? extraPrompt.trim() : "";
  if (trimmedExtraPrompt) {
    systemPrompt += `\n\n## 额外要求\n以下是发起人追加的自定义要求，请在不破坏上述默认总结结构的前提下尽量满足：\n${trimmedExtraPrompt}`;
  }

  const userPrompt = `频道信息：
- 频道名称: ${channelInfo.name}
- 消息数量: ${messages.length}
- 参与用户数: ${Object.keys(userMessages).length}
- 时间范围: ${new Date(channelInfo.timeRange.start).toLocaleString("zh-CN")} 到 ${new Date(channelInfo.timeRange.end).toLocaleString("zh-CN")}

用户发言内容：
${userSummaries}`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

function parseSummaryResponse(summaryText, messages) {
  const userStats = {};
  messages.forEach((msg) => {
    const username = msg.author.display_name;
    userStats[username] = (userStats[username] || 0) + 1;
  });

  const sortedUsers = Object.entries(userStats)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([name]) => name);

  return {
    overview: summaryText,
    key_topics: extractTopics(summaryText),
    participant_stats: {
      most_active_users: sortedUsers,
      total_participants: Object.keys(userStats).length,
      message_distribution: userStats,
    },
    generated_at: new Date().toISOString(),
  };
}

function extractTopics(summaryText) {
  const topics = [];
  const lines = summaryText.split("\n");

  for (const line of lines) {
    if (line.includes("话题") || line.includes("主题")) {
      const matches = line.match(/[:：]\s*(.+)/);
      if (matches) {
        topics.push(...matches[1].split(/[，,、]/));
      }
    }
  }

  return topics
    .slice(0, 5)
    .map((topic) => topic.trim())
    .filter(Boolean);
}

function generateFallbackSummary(messages, channelInfo) {
  const userStats = {};

  messages.forEach((msg) => {
    const username = msg.author.display_name;
    userStats[username] = (userStats[username] || 0) + 1;
  });

  const sortedUsers = Object.entries(userStats)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([name]) => name);

  return {
    overview: `本频道在指定时间段内共有 ${messages.length} 条消息，由 ${Object.keys(userStats).length} 位用户参与讨论。AI 总结暂时不可用，因此返回基础统计摘要。`,
    key_topics: ["AI 总结暂时不可用"],
    participant_stats: {
      most_active_users: sortedUsers,
      total_participants: Object.keys(userStats).length,
      message_distribution: userStats,
    },
    generated_at: new Date().toISOString(),
  };
}

module.exports = {
  generateSummary,
  createAIClient,
};
