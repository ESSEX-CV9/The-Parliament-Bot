// src/modules/channelSummary/utils/timeParser.js

/**
 * 解析用户输入的时间字符串
 */
function parseTimeInput(timeStr) {
    if (!timeStr) return null;
    
    const now = new Date();
    let parsed;
    
    // 格式：YYYY-MM-DD HH:mm
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(timeStr)) {
        parsed = new Date(timeStr);
    }
    // 格式：YYYY-MM-DD
    else if (/^\d{4}-\d{2}-\d{2}$/.test(timeStr)) {
        parsed = new Date(timeStr + ' 00:00');
    }
    // 格式：MM-DD (使用今年)
    else if (/^\d{2}-\d{2}$/.test(timeStr)) {
        parsed = new Date(`${now.getFullYear()}-${timeStr} 00:00`);
    }
    // 格式：HH:mm (使用今天)
    else if (/^\d{2}:\d{2}$/.test(timeStr)) {
        const today = now.toISOString().split('T')[0];
        parsed = new Date(`${today} ${timeStr}`);
    }
    else {
        throw new Error(`不支持的时间格式: ${timeStr}\n支持格式: YYYY-MM-DD, YYYY-MM-DD HH:mm, MM-DD, HH:mm`);
    }
    
    if (isNaN(parsed.getTime())) {
        throw new Error(`无效的时间: ${timeStr}`);
    }
    
    return parsed;
}

/**
 * 验证时间范围
 */
function validateTimeRange(startTime, endTime, maxDays = 7) {
    if (startTime >= endTime) {
        throw new Error('开始时间必须早于结束时间');
    }
    
    const diffDays = (endTime - startTime) / (1000 * 60 * 60 * 24);
    if (diffDays > maxDays) {
        throw new Error(`时间范围不能超过 ${maxDays} 天`);
    }
    
    const now = new Date();
    if (endTime > now) {
        throw new Error('结束时间不能是未来时间');
    }
}

module.exports = {
    parseTimeInput,
    validateTimeRange
};