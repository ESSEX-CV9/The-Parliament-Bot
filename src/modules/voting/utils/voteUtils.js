const crypto = require('crypto');

// 生成唯一的投票ID
function generateVoteId() {
    const timestamp = Date.now().toString(36);
    const randomStr = crypto.randomBytes(4).toString('hex');
    return `vote_${timestamp}_${randomStr}`;
}

// 解析灵活的时间格式
function parseFlexibleTime(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') {
        return { valid: false, minutes: 0 };
    }
    
    let totalMinutes = 0;
    
    // 正则表达式匹配各种时间单位
    // 支持：d/day/days, h/hour/hours, m/min/minute/minutes
    const patterns = [
        { regex: /(\d+)\s*d(?:ay|ays)?/gi, multiplier: 24 * 60 }, // 天
        { regex: /(\d+)\s*h(?:our|ours)?/gi, multiplier: 60 },     // 小时
        { regex: /(\d+)\s*m(?:in|inute|inutes)?/gi, multiplier: 1 } // 分钟
    ];
    
    let hasMatches = false;
    
    for (const pattern of patterns) {
        const matches = [...timeStr.matchAll(pattern.regex)];
        for (const match of matches) {
            const value = parseInt(match[1]);
            if (!isNaN(value) && value >= 0) {
                totalMinutes += value * pattern.multiplier;
                hasMatches = true;
            }
        }
    }
    
    if (!hasMatches) {
        return { valid: false, minutes: 0 };
    }
    
    return { valid: true, minutes: totalMinutes };
}

// 验证投票选项
function validateVoteOptions(optionsText) {
    if (!optionsText || typeof optionsText !== 'string') {
        return { valid: false, error: '投票选项不能为空' };
    }
    
    const options = optionsText.split(',').map(opt => opt.trim()).filter(opt => opt.length > 0);
    
    if (options.length < 2) {
        return { valid: false, error: '至少需要两个投票选项' };
    }
    
    if (options.length > 10) {
        return { valid: false, error: '投票选项不能超过10个' };
    }
    
    // 检查是否有重复选项
    const uniqueOptions = [...new Set(options)];
    if (uniqueOptions.length !== options.length) {
        return { valid: false, error: '投票选项不能重复' };
    }
    
    // 检查选项长度
    for (const option of options) {
        if (option.length > 50) {
            return { valid: false, error: '单个选项长度不能超过50个字符' };
        }
    }
    
    return { valid: true, options: uniqueOptions };
}

// 验证结束时间
function validateEndTime(endTimeText) {
    if (!endTimeText || typeof endTimeText !== 'string') {
        return { valid: false, error: '结束时间不能为空' };
    }
    
    const timeStr = endTimeText.trim().toLowerCase();
    
    // 尝试解析新格式（如：6d4h27m, 72h, 30min等）
    const flexibleTimeResult = parseFlexibleTime(timeStr);
    if (flexibleTimeResult.valid) {
        const totalMinutes = flexibleTimeResult.minutes;
        
        if (totalMinutes <= 0) {
            return { valid: false, error: '结束时间必须大于0' };
        }
        
        if (totalMinutes > 10080) { // 7天 = 7 * 24 * 60
            return { valid: false, error: '结束时间不能超过7天' };
        }
        
        return { valid: true, minutes: totalMinutes };
    }
    
    // 如果新格式解析失败，尝试旧格式（纯数字分钟）
    const minutes = parseInt(timeStr);
    
    if (!isNaN(minutes)) {
        if (minutes <= 0) {
            return { valid: false, error: '结束时间必须大于0' };
        }
        
        if (minutes > 10080) { // 7天 = 7 * 24 * 60
            return { valid: false, error: '结束时间不能超过7天' };
        }
        
        return { valid: true, minutes };
    }
    
    return { 
        valid: false, 
        error: '时间格式错误。支持格式：30（分钟）、6d4h27m（6天4小时27分钟）、72h（72小时）、30min（30分钟）等' 
    };
}

// 解析投票设置
function parseVoteSettings(settingsText) {
    const settings = {
        isAnonymous: false,
        isRealTime: true
    };
    
    if (!settingsText || typeof settingsText !== 'string') {
        return settings;
    }
    
    const pairs = settingsText.split(',');
    
    for (const pair of pairs) {
        const [key, value] = pair.split(':').map(s => s.trim());
        
        if (key === '匿名' || key === '匿名投票') {
            settings.isAnonymous = value === '是' || value === 'true';
        } else if (key === '实时显示' || key === '实时') {
            settings.isRealTime = value === '是' || value === 'true';
        }
    }
    
    return settings;
}

// 验证角色权限
function validateRoles(guild, rolesText) {
    if (!rolesText || typeof rolesText !== 'string') {
        return { valid: true, roles: [] };
    }
    
    const roleNames = rolesText.split(',').map(role => role.trim()).filter(role => role.length > 0);
    const validRoles = [];
    const invalidRoles = [];
    
    for (const roleName of roleNames) {
        const role = guild.roles.cache.find(r => 
            r.name.toLowerCase() === roleName.toLowerCase()
        );
        
        if (role) {
            validRoles.push(role.id);
        } else {
            invalidRoles.push(roleName);
        }
    }
    
    if (invalidRoles.length > 0) {
        return { 
            valid: false, 
            error: `找不到以下身份组: ${invalidRoles.join(', ')}` 
        };
    }
    
    return { valid: true, roles: validRoles };
}

// 格式化时间差
function formatTimeDiff(endTime) {
    const now = new Date();
    const diff = endTime.getTime() - now.getTime();
    
    if (diff <= 0) {
        return '已结束';
    }
    
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    
    if (days > 0) {
        return `${days}天${hours}小时`;
    } else if (hours > 0) {
        return `${hours}小时${minutes}分钟`;
    } else {
        return `${minutes}分钟`;
    }
}

// 检查用户投票权限
function checkVotePermission(member, allowedRoles) {
    if (!allowedRoles || allowedRoles.length === 0) {
        return true; // 没有限制，所有人都可以投票
    }
    
    return allowedRoles.some(roleId => member.roles.cache.has(roleId));
}

// 获取用户当前投票
function getUserVote(userId, votes) {
    for (const [option, voters] of Object.entries(votes)) {
        if (voters.includes(userId)) {
            return option;
        }
    }
    return null;
}

// 计算投票百分比
function calculatePercentage(votes, totalVotes) {
    if (totalVotes === 0) return 0;
    return ((votes / totalVotes) * 100).toFixed(1);
}

// 生成投票摘要
function generateVoteSummary(voteData) {
    const totalVotes = Object.values(voteData.votes).reduce(
        (total, voters) => total + voters.length, 0
    );
    
    const summary = {
        title: voteData.title,
        totalVotes,
        options: voteData.options.map(option => ({
            option,
            votes: voteData.votes[option]?.length || 0,
            percentage: calculatePercentage(
                voteData.votes[option]?.length || 0, 
                totalVotes
            )
        })).sort((a, b) => b.votes - a.votes),
        isActive: new Date() < voteData.endTime,
        endTime: voteData.endTime,
        isAnonymous: voteData.isAnonymous,
        isRealTime: voteData.isRealTime
    };
    
    return summary;
}

module.exports = {
    generateVoteId,
    validateVoteOptions,
    validateEndTime,
    parseVoteSettings,
    validateRoles,
    formatTimeDiff,
    checkVotePermission,
    getUserVote,
    calculatePercentage,
    generateVoteSummary
};

// 测试时间解析功能的辅助函数（仅用于调试）
function testTimeParsingExamples() {
    const testCases = [
        '6d4h27m',
        '72h',
        '30min',
        '1d',
        '2h30m',
        '60',
        '5days2hours',
        '1hour30minutes',
        '90min',
        '2d12h',
        '24hours'
    ];
    
    console.log('=== 时间解析测试 ===');
    testCases.forEach(testCase => {
        const result = validateEndTime(testCase);
        if (result.valid) {
            const hours = Math.floor(result.minutes / 60);
            const mins = result.minutes % 60;
            console.log(`${testCase} -> ${result.minutes}分钟 (${hours}小时${mins}分钟)`);
        } else {
            console.log(`${testCase} -> 错误: ${result.error}`);
        }
    });
    console.log('=== 测试结束 ===');
}

// 如果需要测试，可以取消注释下面这行
// testTimeParsingExamples(); 