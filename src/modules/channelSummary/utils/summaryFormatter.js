// src/modules/channelSummary/utils/summaryFormatter.js

const fs = require('fs').promises;
const path = require('path');

/**
 * 格式化AI总结为Discord消息格式
 */
function formatSummaryForDiscord(aiSummary, channelInfo, messageCount) {
    const { overview, key_topics, participant_stats } = aiSummary;
    
    // 构建Embed
    const embed = {
        color: 0x3498db,
        title: '🤖 AI频道内容总结',
        description: overview,
        fields: [],
        footer: {
            text: `总结生成于 ${new Date().toLocaleString('zh-CN')}`,
            icon_url: 'https://cdn.discordapp.com/embed/avatars/0.png'
        }
    };
    
    // 添加基本信息
    embed.fields.push({
        name: '📊 统计信息',
        value: [
            `📝 **消息数量**: ${messageCount}`,
            `👥 **参与用户**: ${participant_stats.total_participants}人`,
            `⏰ **时间范围**: ${formatTimeRange(channelInfo.timeRange)}`
        ].join('\n'),
        inline: false
    });
    
    // 添加主要话题
    if (key_topics && key_topics.length > 0) {
        embed.fields.push({
            name: '🏷️ 主要话题',
            value: key_topics.map(topic => `• ${topic}`).join('\n') || '暂无识别到的话题',
            inline: true
        });
    }
    
    // 添加活跃用户
    if (participant_stats.most_active_users && participant_stats.most_active_users.length > 0) {
        embed.fields.push({
            name: '🌟 最活跃用户',
            value: participant_stats.most_active_users
                .slice(0, 5)
                .map((user, index) => {
                    const messageCount = participant_stats.message_distribution[user] || 0;
                    const medal = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][index] || '📝';
                    return `${medal} ${user} (${messageCount}条)`;
                })
                .join('\n'),
            inline: true
        });
    }
    
    return embed;
}

/**
 * 格式化时间范围显示
 */
function formatTimeRange(timeRange) {
    const start = new Date(timeRange.start);
    const end = new Date(timeRange.end);
    
    const formatDate = (date) => {
        return date.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    };
    
    return `${formatDate(start)} 至 ${formatDate(end)}`;
}

/**
 * 生成简短的总结文本（用于引用）
 */
function generateSummaryText(aiSummary, messageCount, userCount) {
    const overview = aiSummary.overview;
    
    // 如果overview太长，截取前200字符
    const shortOverview = overview.length > 200 ? 
        overview.substring(0, 200) + '...' : overview;
    
    return `📋 **频道总结** (${messageCount}条消息, ${userCount}位用户)\n\n${shortOverview}`;
}

/**
 * 分割长文本为多个消息
 */
function splitLongText(text, maxLength = 1900) {
    if (text.length <= maxLength) {
        return [text];
    }
    
    const parts = [];
    let currentPart = '';
    const lines = text.split('\n');
    
    for (const line of lines) {
        if ((currentPart + line).length > maxLength) {
            if (currentPart) {
                parts.push(currentPart.trim());
                currentPart = '';
            }
            
            // 如果单行就超长，强制分割
            if (line.length > maxLength) {
                const words = line.split(' ');
                let currentLine = '';
                for (const word of words) {
                    if ((currentLine + word).length > maxLength) {
                        if (currentLine) {
                            parts.push(currentLine.trim());
                            currentLine = '';
                        }
                    }
                    currentLine += word + ' ';
                }
                if (currentLine) {
                    currentPart = currentLine;
                }
            } else {
                currentPart = line + '\n';
            }
        } else {
            currentPart += line + '\n';
        }
    }
    
    if (currentPart.trim()) {
        parts.push(currentPart.trim());
    }
    
    return parts;
}

/**
 * 生成简洁的纯文本总结
 */
function generatePlainTextSummary(aiSummary, channelInfo, messageCount) {
    const timeRange = formatTimeRange(channelInfo.timeRange);
    
    return `📋 **${channelInfo.name} 频道总结**
⏰ 时间范围: ${timeRange}
📊 消息数量: ${messageCount} 条
👥 参与用户: ${aiSummary.participant_stats.total_participants} 人

${aiSummary.overview}`;
}

/**
 * 创建总结文本文件
 */
async function createSummaryTextFile(aiSummary, channelInfo, messageCount) {
    const timeRange = formatTimeRange(channelInfo.timeRange);
    const timestamp = new Date().toLocaleString('zh-CN').replace(/[:/]/g, '-');
    
    const fullText = `${channelInfo.name} 频道总结
生成时间: ${new Date().toLocaleString('zh-CN')}
时间范围: ${timeRange}
消息数量: ${messageCount} 条
参与用户: ${aiSummary.participant_stats.total_participants} 人

${'='.repeat(50)}

${aiSummary.overview}

${'='.repeat(50)}

参与用户统计:
${Object.entries(aiSummary.participant_stats.message_distribution)
    .sort(([,a], [,b]) => b - a)
    .map(([user, count]) => `${user}: ${count} 条消息`)
    .join('\n')}`;
    
    const fileName = `${channelInfo.name}_总结_${timestamp}.txt`;
    const tempDir = path.join(process.cwd(), 'temp');
    
    // 确保临时目录存在
    await fs.mkdir(tempDir, { recursive: true });
    
    const filePath = path.join(tempDir, fileName);
    await fs.writeFile(filePath, fullText, 'utf8');
    
    const stats = await fs.stat(filePath);
    
    return {
        filePath,
        fileName,
        size: stats.size
    };
}

module.exports = {
    formatSummaryForDiscord,
    formatTimeRange,
    generateSummaryText,
    generatePlainTextSummary,
    splitLongText,
    createSummaryTextFile
};