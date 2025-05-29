// src\core\config\timeconfig.js
// 时间配置文件 - 方便测试时快速调整时间

// 是否为测试模式（true = 测试模式，时间大幅缩短；false = 生产模式，正常时间）
const TEST_MODE = false; // 改为 false 可切换到测试模式

// 测试模式下的时间设置（以分钟为单位，方便测试）
const TEST_CONFIG = {
    // 提案系统
    PROPOSAL_DEADLINE_MINUTES: 1,           // 提案截止时间：2分钟
    PROPOSAL_CHECK_INTERVAL_MINUTES: 1,     // 提案检查间隔：1分钟
    
    // 法庭申请系统  
    COURT_APPLICATION_DEADLINE_MINUTES: 3,  // 法庭申请截止时间：3分钟
    COURT_APPLICATION_CHECK_INTERVAL_MINUTES: 1, // 法庭申请检查间隔：1分钟
    
    // 法庭投票系统
    COURT_VOTE_DURATION_MINUTES: 1,         // 投票持续时间：5分钟
    COURT_VOTE_PUBLIC_DELAY_MINUTES: 1,     // 公开票数延迟：2分钟
    COURT_VOTE_CHECK_INTERVAL_MINUTES: 0.25, // 投票检查间隔：30秒

    // 自助管理系统
    SELF_MODERATION_VOTE_DURATION_MINUTES: 2,    // 投票持续时间：2分钟（测试）
    SELF_MODERATION_CHECK_INTERVAL_MINUTES: 0.5, // 检查间隔：30秒
};

// 生产模式下的时间设置（以小时/天为单位，正常使用）
const PRODUCTION_CONFIG = {
    // 提案系统
    PROPOSAL_DEADLINE_HOURS: 24,            // 提案截止时间：24小时
    PROPOSAL_CHECK_INTERVAL_MINUTES: 20,    // 提案检查间隔：20分钟
    
    // 法庭申请系统
    COURT_APPLICATION_DEADLINE_HOURS: 48,   // 法庭申请截止时间：48小时（2天）
    COURT_APPLICATION_CHECK_INTERVAL_MINUTES: 30, // 法庭申请检查间隔：30分钟
    
    // 法庭投票系统
    COURT_VOTE_DURATION_HOURS: 24,          // 投票持续时间：24小时
    COURT_VOTE_PUBLIC_DELAY_HOURS: 12,      // 公开票数延迟：12小时
    COURT_VOTE_CHECK_INTERVAL_MINUTES: 5,   // 投票检查间隔：5分钟

    // 自助管理系统
    SELF_MODERATION_VOTE_DURATION_MINUTES: 10,   // 投票持续时间：10分钟
    SELF_MODERATION_CHECK_INTERVAL_MINUTES: 0.5,   // 检查间隔：1分钟
};

// 白天/夜晚模式配置
const DAY_NIGHT_CONFIG = {
    // 北京时间白天时段（6:00 - 次日2:00 为白天模式）
    DAY_START_HOUR: 6,   // 白天开始时间（6点）
    DAY_END_HOUR: 2,     // 白天结束时间（次日2点）- 如果小于开始时间，表示跨越午夜
    
    // 夜晚模式的调整系数
    NIGHT_DELETE_THRESHOLD_MULTIPLIER: 0.7, // 夜晚删除阈值 = 白天 * 0.7
    NIGHT_MUTE_THRESHOLD_MULTIPLIER: 0.75,   // 夜晚禁言阈值 = 白天 * 0.75
};

// 判断当前是否为白天（基于北京时间）
function isDayTime() {
    const now = new Date();
    // 转换为北京时间 (UTC+8)
    const beijingTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
    const hour = beijingTime.getUTCHours();
    
    const startHour = DAY_NIGHT_CONFIG.DAY_START_HOUR;
    const endHour = DAY_NIGHT_CONFIG.DAY_END_HOUR;
    
    // 如果结束时间小于开始时间，说明跨越了午夜
    if (endHour < startHour) {
        // 跨越午夜的情况：例如 6:00 到次日 3:00
        // 白天时段包括：[6-23] 和 [0-2]
        return hour >= startHour || hour < endHour;
    } else {
        // 普通情况：例如 6:00 到 22:00
        return hour >= startHour && hour < endHour;
    }
}

// 获取当前时段标识
function getCurrentTimeMode() {
    return isDayTime() ? '☀️ 白天模式' : '🌙 夜晚模式';
}

// 获取时间段的描述文字
function getTimeRangeDescription() {
    const startHour = DAY_NIGHT_CONFIG.DAY_START_HOUR;
    const endHour = DAY_NIGHT_CONFIG.DAY_END_HOUR;
    
    if (endHour < startHour) {
        // 跨越午夜
        return `${startHour}:00 - 次日${endHour}:00`;
    } else {
        // 同一天
        return `${startHour}:00 - ${endHour}:00`;
    }
}

// 禁言时长配置（分钟）- 原始配置保持不变
const BASE_MUTE_DURATIONS = {
    LEVEL_1: { threshold: 1, duration: 10 },   // 15个⚠️ -> 10分钟
    LEVEL_2: { threshold: 30, duration: 20 },   // 30个⚠️ -> 20分钟  
    LEVEL_3: { threshold: 60, duration: 40 },   // 60个⚠️ -> 40分钟
    LEVEL_4: { threshold: 80, duration: 60 },  // 80个⚠️ -> 1小时
    LEVEL_5: { threshold: 100, duration: 120 }  // 100个⚠️ -> 2小时
};

// 删除消息阈值 - 原始配置
const BASE_DELETE_THRESHOLD = 1; // 10个⚠️删除消息

// 动态获取当前时段的禁言配置
const MUTE_DURATIONS = new Proxy(BASE_MUTE_DURATIONS, {
    get(target, prop) {
        if (!(prop in target)) return target[prop];
        
        const level = target[prop];
        const isDay = isDayTime();
        
        return {
            threshold: isDay ? level.threshold : Math.floor(level.threshold * DAY_NIGHT_CONFIG.NIGHT_MUTE_THRESHOLD_MULTIPLIER),
            duration: level.duration // 禁言时长不变，只调整触发阈值
        };
    }
});

// 动态获取当前时段的删除阈值
Object.defineProperty(global, 'DELETE_THRESHOLD', {
    get() {
        const isDay = isDayTime();
        return isDay ? BASE_DELETE_THRESHOLD : Math.floor(BASE_DELETE_THRESHOLD * DAY_NIGHT_CONFIG.NIGHT_DELETE_THRESHOLD_MULTIPLIER);
    }
});

// 为了兼容直接引用，也提供常量形式
const DELETE_THRESHOLD = new Proxy({}, {
    get(target, prop) {
        const isDay = isDayTime();
        const value = isDay ? BASE_DELETE_THRESHOLD : Math.floor(BASE_DELETE_THRESHOLD * DAY_NIGHT_CONFIG.NIGHT_DELETE_THRESHOLD_MULTIPLIER);
        
        if (prop === 'valueOf' || prop === Symbol.toPrimitive) {
            return () => value;
        }
        
        return value;
    },
    has(target, prop) {
        return true;
    },
    ownKeys(target) {
        return ['valueOf', Symbol.toPrimitive];
    }
});

// 获取当前配置
function getTimeConfig() {
    return TEST_MODE ? TEST_CONFIG : PRODUCTION_CONFIG;
}

// 获取提案截止时间
function getProposalDeadline() {
    const config = getTimeConfig();
    const deadline = new Date();
    
    if (TEST_MODE) {
        deadline.setMinutes(deadline.getMinutes() + config.PROPOSAL_DEADLINE_MINUTES);
    } else {
        deadline.setHours(deadline.getHours() + config.PROPOSAL_DEADLINE_HOURS);
    }
    
    return deadline;
}

// 获取法庭申请截止时间
function getCourtApplicationDeadline() {
    const config = getTimeConfig();
    const deadline = new Date();
    
    if (TEST_MODE) {
        deadline.setMinutes(deadline.getMinutes() + config.COURT_APPLICATION_DEADLINE_MINUTES);
    } else {
        deadline.setHours(deadline.getHours() + config.COURT_APPLICATION_DEADLINE_HOURS);
    }
    
    return deadline;
}

// 获取法庭投票结束时间
function getCourtVoteEndTime() {
    const config = getTimeConfig();
    const endTime = new Date();
    
    if (TEST_MODE) {
        endTime.setMinutes(endTime.getMinutes() + config.COURT_VOTE_DURATION_MINUTES);
    } else {
        endTime.setHours(endTime.getHours() + config.COURT_VOTE_DURATION_HOURS);
    }
    
    return endTime;
}

// 获取法庭投票公开时间
function getCourtVotePublicTime() {
    const config = getTimeConfig();
    const publicTime = new Date();
    
    if (TEST_MODE) {
        publicTime.setMinutes(publicTime.getMinutes() + config.COURT_VOTE_PUBLIC_DELAY_MINUTES);
    } else {
        publicTime.setHours(publicTime.getHours() + config.COURT_VOTE_PUBLIC_DELAY_HOURS);
    }
    
    return publicTime;
}

// 获取自助管理投票结束时间
function getSelfModerationVoteEndTime() {
    const config = getTimeConfig();
    const endTime = new Date();
    
    endTime.setMinutes(endTime.getMinutes() + config.SELF_MODERATION_VOTE_DURATION_MINUTES);
    
    return endTime;
}

// 获取检查间隔（毫秒）
function getCheckIntervals() {
    const config = getTimeConfig();
    
    return {
        proposalCheck: config.PROPOSAL_CHECK_INTERVAL_MINUTES * 60 * 1000,
        courtApplicationCheck: config.COURT_APPLICATION_CHECK_INTERVAL_MINUTES * 60 * 1000,
        courtVoteCheck: config.COURT_VOTE_CHECK_INTERVAL_MINUTES * 60 * 1000,
        selfModerationCheck: config.SELF_MODERATION_CHECK_INTERVAL_MINUTES * 60 * 1000,
    };
}

// 打印当前时间配置
function printTimeConfig() {
    const mode = TEST_MODE ? '🧪 测试模式' : '🚀 生产模式';
    const timeMode = getCurrentTimeMode();
    const config = getTimeConfig();
    
    console.log(`\n=== 时间配置 - ${mode} ===`);
    console.log(`⏰ 当前时段: ${timeMode}`);
    
    // 显示当前删除阈值和禁言阈值 - 修复这里
    const currentDeleteThreshold = isDayTime() ? BASE_DELETE_THRESHOLD : Math.floor(BASE_DELETE_THRESHOLD * DAY_NIGHT_CONFIG.NIGHT_DELETE_THRESHOLD_MULTIPLIER);
    console.log(`🗑️ 当前删除阈值: ${currentDeleteThreshold}`);
    console.log(`🔇 当前禁言阈值: Level1=${MUTE_DURATIONS.LEVEL_1.threshold}, Level2=${MUTE_DURATIONS.LEVEL_2.threshold}, Level3=${MUTE_DURATIONS.LEVEL_3.threshold}`);
    
    if (TEST_MODE) {
        console.log(`📝 提案截止时间: ${config.PROPOSAL_DEADLINE_MINUTES} 分钟`);
        console.log(`🏛️ 法庭申请截止时间: ${config.COURT_APPLICATION_DEADLINE_MINUTES} 分钟`);
        console.log(`🗳️ 法庭投票时间: ${config.COURT_VOTE_DURATION_MINUTES} 分钟`);
        console.log(`👁️ 票数公开延迟: ${config.COURT_VOTE_PUBLIC_DELAY_MINUTES} 分钟`);
        console.log(`🛡️ 自助管理投票时间: ${config.SELF_MODERATION_VOTE_DURATION_MINUTES} 分钟`);
        console.log(`⏰ 检查间隔: 提案=${config.PROPOSAL_CHECK_INTERVAL_MINUTES}分钟, 申请=${config.COURT_APPLICATION_CHECK_INTERVAL_MINUTES}分钟, 投票=${config.COURT_VOTE_CHECK_INTERVAL_MINUTES}分钟, 自助管理=${config.SELF_MODERATION_CHECK_INTERVAL_MINUTES}分钟`);
    } else {
        console.log(`📝 提案截止时间: ${config.PROPOSAL_DEADLINE_HOURS} 小时`);
        console.log(`🏛️ 法庭申请截止时间: ${config.COURT_APPLICATION_DEADLINE_HOURS} 小时`);
        console.log(`🗳️ 法庭投票时间: ${config.COURT_VOTE_DURATION_HOURS} 小时`);
        console.log(`👁️ 票数公开延迟: ${config.COURT_VOTE_PUBLIC_DELAY_HOURS} 小时`);
        console.log(`🛡️ 自助管理投票时间: ${config.SELF_MODERATION_VOTE_DURATION_MINUTES} 分钟`);
        console.log(`⏰ 检查间隔: 提案=${config.PROPOSAL_CHECK_INTERVAL_MINUTES}分钟, 申请=${config.COURT_APPLICATION_CHECK_INTERVAL_MINUTES}分钟, 投票=${config.COURT_VOTE_CHECK_INTERVAL_MINUTES}分钟, 自助管理=${config.SELF_MODERATION_CHECK_INTERVAL_MINUTES}分钟`);
    }
    
    console.log(`\n--- 白天/夜晚配置 ---`);
    console.log(`☀️ 白天时段: ${getTimeRangeDescription()} (北京时间)`);
    console.log(`🌙 夜晚时段: ${DAY_NIGHT_CONFIG.DAY_END_HOUR < DAY_NIGHT_CONFIG.DAY_START_HOUR ? `${DAY_NIGHT_CONFIG.DAY_END_HOUR}:00 - ${DAY_NIGHT_CONFIG.DAY_START_HOUR}:00` : `${DAY_NIGHT_CONFIG.DAY_END_HOUR}:00 - ${DAY_NIGHT_CONFIG.DAY_START_HOUR}:00`} (北京时间)`);
    console.log(`🗑️ 删除阈值: 白天=${BASE_DELETE_THRESHOLD}, 夜晚=${Math.floor(BASE_DELETE_THRESHOLD * DAY_NIGHT_CONFIG.NIGHT_DELETE_THRESHOLD_MULTIPLIER)}`);
    console.log(`🔇 禁言阈值调整: 夜晚为白天的${(DAY_NIGHT_CONFIG.NIGHT_MUTE_THRESHOLD_MULTIPLIER * 100)}%`);
    console.log(`===============================\n`);
}

module.exports = {
    TEST_MODE,
    getTimeConfig,
    getProposalDeadline,
    getCourtApplicationDeadline,
    getCourtVoteEndTime,
    getCourtVotePublicTime,
    getSelfModerationVoteEndTime,
    getCheckIntervals,
    printTimeConfig,
    MUTE_DURATIONS,
    DELETE_THRESHOLD,
    // 新增导出
    isDayTime,
    getCurrentTimeMode,
    DAY_NIGHT_CONFIG,
    getTimeRangeDescription
};