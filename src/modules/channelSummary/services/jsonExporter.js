// src/modules/channelSummary/services/jsonExporter.js

const fs = require('fs').promises;
const path = require('path');

/**
 * 生成消息数据JSON（不包含AI总结）
 */
function generateMessagesJSON(channelInfo, messages) {
    return {
        export_info: {
            channel_id: channelInfo.id,
            channel_name: channelInfo.name,
            channel_type: channelInfo.type,
            time_range: {
                start: channelInfo.timeRange.start,
                end: channelInfo.timeRange.end
            },
            message_count: messages.length,
            exported_at: new Date().toISOString(),
            generator: "Discord Bot Channel Summary"
        },
        messages: messages
    };
}

/**
 * 保存JSON到临时文件
 */
async function saveToTempFile(messagesData, channelName) {
    try {
        // 创建临时目录
        const tempDir = path.join(process.cwd(), 'temp', 'summaries');
        await fs.mkdir(tempDir, { recursive: true });
        
        // 生成文件名
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `${channelName}-messages-${timestamp}.json`;
        const filePath = path.join(tempDir, fileName);
        
        // 写入文件
        await fs.writeFile(filePath, JSON.stringify(messagesData, null, 2), 'utf8');
        
        return {
            filePath,
            fileName,
            size: JSON.stringify(messagesData).length
        };
    } catch (error) {
        throw new Error(`保存文件失败: ${error.message}`);
    }
}

/**
 * 清理过期的临时文件
 */
async function cleanupTempFiles(retentionHours = 24) {
    try {
        const tempDir = path.join(process.cwd(), 'temp', 'summaries');
        const files = await fs.readdir(tempDir);
        const now = Date.now();
        
        for (const file of files) {
            const filePath = path.join(tempDir, file);
            const stats = await fs.stat(filePath);
            const ageHours = (now - stats.mtime.getTime()) / (1000 * 60 * 60);
            
            if (ageHours > retentionHours) {
                await fs.unlink(filePath);
                console.log(`清理过期总结文件: ${file}`);
            }
        }
    } catch (error) {
        console.warn('清理临时文件时出错:', error.message);
    }
}

module.exports = {
    generateMessagesJSON,
    saveToTempFile,
    cleanupTempFiles
};