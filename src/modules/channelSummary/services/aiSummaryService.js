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
    const messageTexts = messages.map(msg => 
        `${msg.author.display_name}: ${msg.content}`
    ).join('\n');
    
    return `请对以下Discord频道的聊天记录进行总结分析：

频道信息：
- 频道名称: ${channelInfo.name}
- 消息数量: ${messages.length}
- 时间范围: ${channelInfo.timeRange.start} 到 ${channelInfo.timeRange.end}

聊天记录：
${messageTexts}

请用中文提供以下格式的总结：
1. 整体概况（2-3句话）
2. 主要话题（列出3-5个关键话题）
3. 活跃用户（按发言频率排序）
4. 重要信息摘要

请保持总结简洁明了。`;
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