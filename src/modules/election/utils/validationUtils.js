/**
 * 验证工具
 */

/**
 * 验证职位配置
 * @param {Array} positions - 职位数组
 * @returns {object} 验证结果
 */
function validatePositions(positions) {
    const errors = [];
    
    if (!Array.isArray(positions) || positions.length === 0) {
        errors.push('至少需要设置一个职位');
        return { isValid: false, errors };
    }
    
    const positionIds = new Set();
    const positionNames = new Set();
    
    for (let i = 0; i < positions.length; i++) {
        const position = positions[i];
        
        // 检查必要字段
        if (!position.id || !position.name) {
            errors.push(`职位 ${i + 1}: 职位ID和名称不能为空`);
            continue;
        }
        
        // 检查重复ID
        if (positionIds.has(position.id)) {
            errors.push(`职位 ${i + 1}: 职位ID "${position.id}" 已存在`);
        }
        positionIds.add(position.id);
        
        // 检查重复名称
        if (positionNames.has(position.name)) {
            errors.push(`职位 ${i + 1}: 职位名称 "${position.name}" 已存在`);
        }
        positionNames.add(position.name);
        
        // 验证当选人数
        if (!position.maxWinners || position.maxWinners < 1 || position.maxWinners > 10) {
            errors.push(`职位 ${i + 1}: 当选人数必须在1-10之间`);
        }
        
        // 验证职位名称长度
        if (position.name.length > 20) {
            errors.push(`职位 ${i + 1}: 职位名称不能超过20个字符`);
        }
        
        // 修改：验证数字ID格式
        const idRegex = /^\d+$/;
        if (!idRegex.test(position.id)) {
            errors.push(`职位 ${i + 1}: 职位ID必须是数字`);
        }
    }
    
    return {
        isValid: errors.length === 0,
        errors
    };
}

/**
 * 验证报名数据
 * @param {object} registrationData - 报名数据
 * @param {object} electionData - 选举数据
 * @returns {object} 验证结果
 */
function validateRegistration(registrationData, electionData) {
    const errors = [];
    
    // 检查必要字段
    if (!registrationData.userId) {
        errors.push('用户ID不能为空');
    }
    
    if (!registrationData.firstChoicePosition) {
        errors.push('必须选择第一志愿');
    }
    
    // 验证第一志愿是否存在
    if (registrationData.firstChoicePosition && electionData.positions) {
        if (!electionData.positions[registrationData.firstChoicePosition]) {
            errors.push('第一志愿职位不存在');
        }
    }
    
    // 验证第二志愿
    if (registrationData.secondChoicePosition) {
        if (!electionData.positions[registrationData.secondChoicePosition]) {
            errors.push('第二志愿职位不存在');
        }
        
        // 第一志愿和第二志愿不能相同
        if (registrationData.firstChoicePosition === registrationData.secondChoicePosition) {
            errors.push('第一志愿和第二志愿不能相同');
        }
    }
    
    // 验证自我介绍长度
    if (registrationData.selfIntroduction && registrationData.selfIntroduction.length > 500) {
        errors.push('自我介绍不能超过500个字符');
    }
    
    return {
        isValid: errors.length === 0,
        errors
    };
}

/**
 * 验证选举名称
 * @param {string} name - 选举名称
 * @returns {object} 验证结果
 */
function validateElectionName(name) {
    const errors = [];
    
    if (!name || name.trim().length === 0) {
        errors.push('选举名称不能为空');
    } else if (name.length > 50) {
        errors.push('选举名称不能超过50个字符');
    } else if (name.length < 3) {
        errors.push('选举名称至少需要3个字符');
    }
    
    return {
        isValid: errors.length === 0,
        errors
    };
}

/**
 * 验证投票数据
 * @param {Array} candidateIds - 候选人ID数组
 * @param {number} maxSelections - 最大选择数
 * @param {Array} availableCandidates - 可选候选人
 * @returns {object} 验证结果
 */
function validateVoteData(candidateIds, maxSelections, availableCandidates) {
    const errors = [];
    
    if (!Array.isArray(candidateIds)) {
        errors.push('候选人数据格式错误');
        return { isValid: false, errors };
    }
    
    if (candidateIds.length === 0) {
        errors.push('至少需要选择一个候选人');
    } else if (candidateIds.length > maxSelections) {
        errors.push(`最多只能选择 ${maxSelections} 个候选人`);
    }
    
    // 检查重复选择
    const uniqueIds = new Set(candidateIds);
    if (uniqueIds.size !== candidateIds.length) {
        errors.push('不能重复选择同一个候选人');
    }
    
    // 检查候选人是否存在
    const availableIds = availableCandidates.map(c => c.userId);
    for (const candidateId of candidateIds) {
        if (!availableIds.includes(candidateId)) {
            errors.push(`候选人 ${candidateId} 不存在`);
        }
    }
    
    return {
        isValid: errors.length === 0,
        errors
    };
}

/**
 * 验证权限
 * @param {object} member - Discord成员对象
 * @param {Array} requiredRoles - 需要的角色ID数组
 * @returns {boolean} 是否有权限
 */
function validatePermission(member, requiredRoles = []) {
    if (!member) return false;
    
    // 检查管理员权限
    if (member.permissions && member.permissions.has('Administrator')) {
        return true;
    }
    
    // 检查特定角色
    if (requiredRoles.length > 0) {
        return requiredRoles.some(roleId => member.roles.cache.has(roleId));
    }
    
    return false;
}

/**
 * 生成唯一ID
 * @param {string} prefix - 前缀
 * @returns {string} 唯一ID
 */
function generateUniqueId(prefix = '') {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `${prefix}${timestamp}_${random}`;
}

/**
 * 清理用户输入
 * @param {string} input - 用户输入
 * @param {number} maxLength - 最大长度
 * @returns {string} 清理后的输入
 */
function sanitizeInput(input, maxLength = 500) {
    if (!input) return '';
    
    return input
        .trim()
        .substring(0, maxLength)
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // 移除控制字符
        .replace(/\s+/g, ' '); // 合并多个空格
}

/**
 * 检查选举状态是否允许操作
 * @param {string} currentStatus - 当前状态
 * @param {string} requiredStatus - 需要的状态
 * @returns {boolean} 是否允许操作
 */
function validateElectionStatus(currentStatus, requiredStatus) {
    const statusHierarchy = {
        'setup': 0,
        'registration': 1,
        'voting': 2,
        'completed': 3
    };
    
    if (typeof requiredStatus === 'string') {
        return currentStatus === requiredStatus;
    }
    
    if (Array.isArray(requiredStatus)) {
        return requiredStatus.includes(currentStatus);
    }
    
    return false;
}

module.exports = {
    validatePositions,
    validateRegistration,
    validateElectionName,
    validateVoteData,
    validatePermission,
    generateUniqueId,
    sanitizeInput,
    validateElectionStatus
}; 