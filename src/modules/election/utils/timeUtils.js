/**
 * 时间处理工具
 */

/**
 * 解析时间字符串为Date对象
 * @param {string} timeString - 时间字符串 (YYYY-MM-DD HH:mm)
 * @returns {Date|null} 解析后的Date对象或null
 */
function parseElectionTime(timeString) {
    if (!timeString) return null;
    
    try {
        // 支持格式: YYYY-MM-DD HH:mm
        const dateTimeRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
        if (!dateTimeRegex.test(timeString)) {
            throw new Error('时间格式不正确，请使用 YYYY-MM-DD HH:mm 格式');
        }
        
        const date = new Date(timeString.replace(' ', 'T') + ':00.000Z');
        if (isNaN(date.getTime())) {
            throw new Error('无效的时间值');
        }
        
        return date;
    } catch (error) {
        console.error('解析时间失败:', error);
        return null;
    }
}

/**
 * 格式化时间为中文显示
 * @param {Date} date - 时间对象
 * @returns {string} 格式化后的时间字符串
 */
function formatChineseTime(date) {
    if (!date) return '未设置';
    
    const options = {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Shanghai'
    };
    
    return new Intl.DateTimeFormat('zh-CN', options).format(date);
}

/**
 * 检查时间是否已过期
 * @param {Date} date - 要检查的时间
 * @returns {boolean} 是否已过期
 */
function isTimeExpired(date) {
    if (!date) return false;
    return new Date() > date;
}

/**
 * 获取时间状态描述
 * @param {Date} startTime - 开始时间
 * @param {Date} endTime - 结束时间
 * @returns {string} 状态描述
 */
function getTimeStatus(startTime, endTime) {
    const now = new Date();
    
    if (!startTime || !endTime) {
        return '时间未设置';
    }
    
    if (now < startTime) {
        return `还未开始 (${formatChineseTime(startTime)} 开始)`;
    } else if (now >= startTime && now <= endTime) {
        return `进行中 (${formatChineseTime(endTime)} 结束)`;
    } else {
        return `已结束 (${formatChineseTime(endTime)} 结束)`;
    }
}

/**
 * 计算时间差
 * @param {Date} date1 - 时间1
 * @param {Date} date2 - 时间2
 * @returns {string} 时间差描述
 */
function getTimeDifference(date1, date2) {
    const diff = Math.abs(date2 - date1);
    const minutes = Math.floor(diff / (1000 * 60));
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) {
        return `${days}天${hours % 24}小时`;
    } else if (hours > 0) {
        return `${hours}小时${minutes % 60}分钟`;
    } else {
        return `${minutes}分钟`;
    }
}

/**
 * 验证时间范围是否合理
 * @param {Date} startTime - 开始时间
 * @param {Date} endTime - 结束时间
 * @returns {object} 验证结果
 */
function validateTimeRange(startTime, endTime) {
    const now = new Date();
    const errors = [];
    
    if (!startTime || !endTime) {
        errors.push('开始时间和结束时间都必须设置');
    } else {
        if (startTime >= endTime) {
            errors.push('开始时间必须早于结束时间');
        }
        
        if (endTime <= now) {
            errors.push('结束时间必须在未来');
        }
        
        // 检查时间范围是否过短
        const duration = endTime - startTime;
        const minDuration = 30 * 60 * 1000; // 30分钟
        if (duration < minDuration) {
            errors.push('时间范围至少需要30分钟');
        }
    }
    
    return {
        isValid: errors.length === 0,
        errors
    };
}

/**
 * 生成时间选择器选项
 * @returns {Array} 时间选项数组
 */
function generateTimeOptions() {
    const options = [];
    const now = new Date();
    
    // 生成未来7天的时间选项
    for (let day = 0; day < 7; day++) {
        const date = new Date(now);
        date.setDate(date.getDate() + day);
        
        // 每天生成几个时间点
        const timePoints = ['09:00', '12:00', '15:00', '18:00', '21:00'];
        
        for (const time of timePoints) {
            const dateStr = date.toISOString().split('T')[0];
            const timeStr = `${dateStr} ${time}`;
            const displayStr = `${formatChineseTime(parseElectionTime(timeStr))}`;
            
            options.push({
                label: displayStr,
                value: timeStr
            });
        }
    }
    
    return options;
}

module.exports = {
    parseElectionTime,
    formatChineseTime,
    isTimeExpired,
    getTimeStatus,
    getTimeDifference,
    validateTimeRange,
    generateTimeOptions
}; 