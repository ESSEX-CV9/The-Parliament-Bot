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
    COURT_VOTE_CHECK_INTERVAL_MINUTES: 0.5, // 投票检查间隔：30秒
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
};

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

// 获取检查间隔（毫秒）
function getCheckIntervals() {
    const config = getTimeConfig();
    
    return {
        proposalCheck: config.PROPOSAL_CHECK_INTERVAL_MINUTES * 60 * 1000,
        courtApplicationCheck: config.COURT_APPLICATION_CHECK_INTERVAL_MINUTES * 60 * 1000,
        courtVoteCheck: config.COURT_VOTE_CHECK_INTERVAL_MINUTES * 60 * 1000,
    };
}

// 打印当前时间配置
function printTimeConfig() {
    const mode = TEST_MODE ? '🧪 测试模式' : '🚀 生产模式';
    const config = getTimeConfig();
    
    console.log(`\n=== 时间配置 - ${mode} ===`);
    
    if (TEST_MODE) {
        console.log(`📝 提案截止时间: ${config.PROPOSAL_DEADLINE_MINUTES} 分钟`);
        console.log(`🏛️ 法庭申请截止时间: ${config.COURT_APPLICATION_DEADLINE_MINUTES} 分钟`);
        console.log(`🗳️ 法庭投票时间: ${config.COURT_VOTE_DURATION_MINUTES} 分钟`);
        console.log(`👁️ 票数公开延迟: ${config.COURT_VOTE_PUBLIC_DELAY_MINUTES} 分钟`);
        console.log(`⏰ 检查间隔: 提案=${config.PROPOSAL_CHECK_INTERVAL_MINUTES}分钟, 申请=${config.COURT_APPLICATION_CHECK_INTERVAL_MINUTES}分钟, 投票=${config.COURT_VOTE_CHECK_INTERVAL_MINUTES}分钟`);
    } else {
        console.log(`📝 提案截止时间: ${config.PROPOSAL_DEADLINE_HOURS} 小时`);
        console.log(`🏛️ 法庭申请截止时间: ${config.COURT_APPLICATION_DEADLINE_HOURS} 小时`);
        console.log(`🗳️ 法庭投票时间: ${config.COURT_VOTE_DURATION_HOURS} 小时`);
        console.log(`👁️ 票数公开延迟: ${config.COURT_VOTE_PUBLIC_DELAY_HOURS} 小时`);
        console.log(`⏰ 检查间隔: 提案=${config.PROPOSAL_CHECK_INTERVAL_MINUTES}分钟, 申请=${config.COURT_APPLICATION_CHECK_INTERVAL_MINUTES}分钟, 投票=${config.COURT_VOTE_CHECK_INTERVAL_MINUTES}分钟`);
    }
    
    console.log(`===============================\n`);
}

module.exports = {
    TEST_MODE,
    getTimeConfig,
    getProposalDeadline,
    getCourtApplicationDeadline,
    getCourtVoteEndTime,
    getCourtVotePublicTime,
    getCheckIntervals,
    printTimeConfig
};