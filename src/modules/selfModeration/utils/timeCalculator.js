// src\modules\selfModeration\utils\timeCalculator.js
const { MUTE_DURATIONS } = require('../../../core/config/timeconfig');

/**
 * 根据⚠️数量计算禁言时长
 * @param {number} reactionCount - ⚠️反应数量
 * @returns {object} {level: number, duration: number, threshold: number}
 */
function calculateMuteDuration(reactionCount) {
    // 按照阈值从高到低检查
    const levels = Object.keys(MUTE_DURATIONS).reverse();
    
    for (const level of levels) {
        const config = MUTE_DURATIONS[level];
        if (reactionCount >= config.threshold) {
            return {
                level: level,
                duration: config.duration,
                threshold: config.threshold
            };
        }
    }
    
    // 如果没有达到任何阈值
    return {
        level: null,
        duration: 0,
        threshold: 0
    };
}

/**
 * 计算需要增加的禁言时间（考虑已经执行的禁言）
 * @param {number} newReactionCount - 新的⚠️反应数量
 * @param {number} currentMuteDuration - 当前已执行的禁言时长（分钟）
 * @returns {object} {additionalDuration: number, totalDuration: number, newLevel: string}
 */
function calculateAdditionalMuteDuration(newReactionCount, currentMuteDuration) {
    const newMuteInfo = calculateMuteDuration(newReactionCount);
    
    if (!newMuteInfo.level) {
        return {
            additionalDuration: 0,
            totalDuration: currentMuteDuration,
            newLevel: null
        };
    }
    
    const totalShouldBe = newMuteInfo.duration;
    const additionalDuration = Math.max(0, totalShouldBe - currentMuteDuration);
    
    return {
        additionalDuration,
        totalDuration: totalShouldBe,
        newLevel: newMuteInfo.level
    };
}

/**
 * 格式化时长显示
 * @param {number} minutes - 分钟数
 * @returns {string} 格式化的时长字符串
 */
function formatDuration(minutes) {
    if (minutes < 60) {
        return `${minutes}分钟`;
    } else if (minutes < 1440) { // 小于24小时
        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;
        if (remainingMinutes === 0) {
            return `${hours}小时`;
        } else {
            return `${hours}小时${remainingMinutes}分钟`;
        }
    } else {
        const days = Math.floor(minutes / 1440);
        const remainingHours = Math.floor((minutes % 1440) / 60);
        if (remainingHours === 0) {
            return `${days}天`;
        } else {
            return `${days}天${remainingHours}小时`;
        }
    }
}

/**
 * 获取所有禁言等级的描述
 * @returns {string} 禁言等级描述
 */
function getMuteLevelsDescription() {
    const levels = Object.entries(MUTE_DURATIONS);
    return levels.map(([level, config]) => 
        `${config.threshold}个⚠️ → ${formatDuration(config.duration)}`
    ).join('\n');
}

module.exports = {
    calculateMuteDuration,
    calculateAdditionalMuteDuration,
    formatDuration,
    getMuteLevelsDescription
};