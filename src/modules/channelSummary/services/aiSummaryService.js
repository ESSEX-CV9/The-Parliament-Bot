// src/modules/channelSummary/services/aiSummaryService.js

const { OpenAI } = require('openai');
const config = require('../config/summaryConfig');

let openAIClient;

/**
 * 初始化AI服务
 */
function initializeAI() {
    if (!config.OPENAI_API_CONFIG.API_KEY) {
        throw new Error('缺少 OPENAI_API_KEY 环境变量');
    }
    
    if (!openAIClient) {
        openAIClient = new OpenAI({
            apiKey: config.OPENAI_API_CONFIG.API_KEY,
            baseURL: config.OPENAI_API_CONFIG.BASE_URL,
        });
    }
    
    return openAIClient;
}

/**
 * 生成消息总结
 */
async function generateSummary(messages, channelInfo, model = null) {
    try {
        const ai = initializeAI();
        
        const promptMessages = buildOpenAISummaryPrompt(messages, channelInfo);
        
        // 如果用户没有指定模型，则使用配置中的默认模型
        const targetModel = model || config.OPENAI_API_CONFIG.MODEL;

        const response = await ai.chat.completions.create({
            model: targetModel,
            messages: promptMessages,
        });
        
        const summaryText = response.choices[0]?.message?.content || '';
        
        if (!summaryText) {
            throw new Error('AI响应为空');
        }
        
        return parseSummaryResponse(summaryText, messages);
    } catch (error) {
        console.error('AI总结生成失败:', error);
        return generateFallbackSummary(messages, channelInfo);
    }
}

/**
 * 构建OpenAI兼容的总结提示词
 */
function buildOpenAISummaryPrompt(messages, channelInfo) {
    const userMessages = {};
    messages.forEach(msg => {
        const username = msg.author.display_name;
        if (!userMessages[username]) {
            userMessages[username] = [];
        }
        userMessages[username].push(msg.content);
    });
    
    const userSummaries = Object.entries(userMessages)
        .map(([username, msgs]) => `${username}: ${msgs.join(' ')}`)
        .join('\n\n');
    
    const systemPrompt = `你是一个专业的Discord聊天分析助手。请对以下聊天记录进行详细分析，总结核心议题、关键信息以及每个主要参与用户的发言要点。

请用中文提供详细的总结分析，并严格遵循以下格式：

## 讨论概览
（在这里对整体讨论的背景、氛围和主要议题进行概括性描述）

## 用户发言分析
（针对每个活跃用户，详细分析其发言的主要观点、关注重点。对于发言较少或无实质内容的用户可以简略或忽略）

## 核心议题总结
（在这里提炼出2-3个最主要的讨论话题和相关结论）

## 关键信息汇总
（在这里列出讨论中产生的任何重要决定、计划、约定或有价值的结论性信息）

请确保分析客观、详细且有深度，能够准确反映出讨论的全貌。`;

    const userPrompt = `频道信息：
- 频道名称: ${channelInfo.name}
- 消息数量: ${messages.length}
- 参与用户数: ${Object.keys(userMessages).length}
- 时间范围: ${new Date(channelInfo.timeRange.start).toLocaleString('zh-CN')} 到 ${new Date(channelInfo.timeRange.end).toLocaleString('zh-CN')}

用户发言内容：
${userSummaries}`;

    return [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ];
}


/**
 * 解析AI响应
 */
function parseSummaryResponse(summaryText, messages) {
    // 统计参与者信息
    const userStats = {};
    messages.forEach(msg => {
        const username = msg.author.display_name;
        userStats[username] = (userStats[username] || 0) + 1;
    });
    
    const sortedUsers = Object.entries(userStats)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5)
        .map(([name]) => name);
    
    return {
        overview: summaryText,
        key_topics: extractTopics(summaryText),
        participant_stats: {
            most_active_users: sortedUsers,
            total_participants: Object.keys(userStats).length,
            message_distribution: userStats
        },
        generated_at: new Date().toISOString()
    };
}

/**
 * 从总结中提取话题（简单实现）
 */
function extractTopics(summaryText) {
    // 这里可以实现更复杂的话题提取逻辑
    const topics = [];
    const lines = summaryText.split('\n');
    
    for (const line of lines) {
        if (line.includes('话题') || line.includes('主题')) {
            const matches = line.match(/[：:]\s*(.+)/);
            if (matches) {
                topics.push(...matches[1].split(/[,，、]/));
            }
        }
    }
    
    return topics.slice(0, 5).map(topic => topic.trim());
}

/**
 * 生成备用总结（当AI失败时）
 */
function generateFallbackSummary(messages, channelInfo) {
    const userStats = {};
    const contentWords = [];
    
    messages.forEach(msg => {
        const username = msg.author.display_name;
        userStats[username] = (userStats[username] || 0) + 1;
        
        // 简单的关键词提取
        const words = msg.content.split(/\s+/).filter(word => word.length > 2);
        contentWords.push(...words);
    });
    
    const sortedUsers = Object.entries(userStats)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5)
        .map(([name]) => name);
    
    return {
        overview: `本频道在指定时间段内共有 ${messages.length} 条消息，由 ${Object.keys(userStats).length} 位用户参与讨论。`,
        key_topics: ['自动生成的总结暂不可用'],
        participant_stats: {
            most_active_users: sortedUsers,
            total_participants: Object.keys(userStats).length,
            message_distribution: userStats
        },
        generated_at: new Date().toISOString()
    };
}

module.exports = {
    generateSummary,
    initializeAI
};
