// src/modules/channelSummary/services/aiSummaryService.js

const { GoogleGenAI } = require('@google/genai');
const config = require('../config/summaryConfig');

let genAI;

/**
 * 初始化AI服务
 */
function initializeAI() {
    if (!process.env.GOOGLE_GENAI_API_KEY) {
        throw new Error('缺少 GOOGLE_GENAI_API_KEY 环境变量');
    }
    
    if (!genAI) {
        genAI = new GoogleGenAI({ 
            apiKey: process.env.GOOGLE_GENAI_API_KEY 
        });
    }
    
    return genAI;
}

/**
 * 生成消息总结
 */
async function generateSummary(messages, channelInfo) {
    try {
        const ai = initializeAI();
        
        const prompt = buildSummaryPrompt(messages, channelInfo);
        
        const response = await ai.models.generateContent({
            model: config.GEMINI_MODEL,
            contents: prompt
        });
        
        const summaryText = response.text;
        
        return parseSummaryResponse(summaryText, messages);
    } catch (error) {
        console.error('AI总结生成失败:', error);
        return generateFallbackSummary(messages, channelInfo);
    }
}

/**
 * 构建总结提示词
 */
function buildSummaryPrompt(messages, channelInfo) {
    // 按用户分组消息
    const userMessages = {};
    messages.forEach(msg => {
        const username = msg.author.display_name;
        if (!userMessages[username]) {
            userMessages[username] = [];
        }
        userMessages[username].push(msg.content);
    });
    
    // 构建用户发言汇总
    const userSummaries = Object.entries(userMessages)
        .map(([username, msgs]) => `${username}: ${msgs.join(' ')}`)
        .join('\n\n');
    
    return `请对以下Discord频道的聊天记录进行详细分析，重点总结每个用户的发言主旨和讨论重点：

频道信息：
- 频道名称: ${channelInfo.name}
- 消息数量: ${messages.length}
- 参与用户数: ${Object.keys(userMessages).length}
- 时间范围: ${new Date(channelInfo.timeRange.start).toLocaleString('zh-CN')} 到 ${new Date(channelInfo.timeRange.end).toLocaleString('zh-CN')}

用户发言内容：
${userSummaries}

请用中文提供详细的总结分析，格式如下：

## 讨论概览
（整体讨论的背景和主要议题）

## 用户发言分析
（针对每个活跃用户，分析其发言的主要观点、关注重点和与其他用户异同点，每个用户至少300字。对于只有一两句，且没有实际讨论内容的用户可以忽略，重点关注有实际讨论内容的用户）

## 核心议题总结
（提炼出的主要讨论话题和结论）

## 关键信息汇总
（重要的决策、计划或结论性信息）

请确保分析详细且有针对性，突出每个用户的独特观点和与其他用户异同点。`;
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