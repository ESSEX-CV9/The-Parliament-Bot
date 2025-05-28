// src/modules/contest/utils/contestPermissions.js
const { checkAdminPermission } = require('../../../core/utils/permissionManager');

/**
 * 检查用户是否有申请赛事的权限
 */
function checkContestApplicationPermission(member, contestSettings) {
    try {
        console.log(`检查赛事申请权限 - 用户: ${member.user.tag}`);
        
        // 管理员总是有权限
        if (checkAdminPermission(member)) {
            console.log(`✅ 管理员权限 - ${member.user.tag}`);
            return true;
        }
        
        // 如果没有设置申请权限，默认所有人都可以申请
        if (!contestSettings || !contestSettings.applicationPermissionRoles || contestSettings.applicationPermissionRoles.length === 0) {
            console.log(`✅ 未设置权限限制，默认允许 - ${member.user.tag}`);
            return true;
        }
        
        // 检查是否有指定身份组
        const userRoleIds = member.roles.cache.map(role => role.id);
        const hasPermission = contestSettings.applicationPermissionRoles.some(roleId => 
            userRoleIds.includes(roleId)
        );
        
        console.log(`申请权限检查结果: ${hasPermission} - ${member.user.tag}`);
        return hasPermission;
        
    } catch (error) {
        console.error('检查申请权限时出错:', error);
        return false;
    }
}

/**
 * 检查用户是否有审核权限
 */
function checkContestReviewPermission(member, contestSettings) {
    try {
        console.log(`检查赛事审核权限 - 用户: ${member.user.tag}`);
        
        // 管理员总是有权限
        if (checkAdminPermission(member)) {
            console.log(`✅ 管理员权限 - ${member.user.tag}`);
            return true;
        }
        
        // 检查是否有审核员身份组
        if (!contestSettings || !contestSettings.reviewerRoles || contestSettings.reviewerRoles.length === 0) {
            console.log(`❌ 未设置审核员身份组 - ${member.user.tag}`);
            return false;
        }
        
        const userRoleIds = member.roles.cache.map(role => role.id);
        const hasPermission = contestSettings.reviewerRoles.some(roleId => 
            userRoleIds.includes(roleId)
        );
        
        console.log(`审核权限检查结果: ${hasPermission} - ${member.user.tag}`);
        return hasPermission;
        
    } catch (error) {
        console.error('检查审核权限时出错:', error);
        return false;
    }
}

/**
 * 检查用户是否有管理特定赛事频道的权限
 */
function checkContestManagePermission(member, contestChannelData) {
    try {
        console.log(`检查赛事管理权限 - 用户: ${member.user.tag}, 频道: ${contestChannelData.channelId}`);
        
        // 管理员总是有权限
        if (checkAdminPermission(member)) {
            console.log(`✅ 管理员权限 - ${member.user.tag}`);
            return true;
        }
        
        // 申请人有权限
        if (member.user.id === contestChannelData.applicantId) {
            console.log(`✅ 申请人权限 - ${member.user.tag}`);
            return true;
        }
        
        console.log(`❌ 无管理权限 - ${member.user.tag}`);
        return false;
        
    } catch (error) {
        console.error('检查管理权限时出错:', error);
        return false;
    }
}

/**
 * 获取申请权限不足的错误消息
 */
function getApplicationPermissionDeniedMessage(allowedRoles = []) {
    let message = `❌ **权限不足**\n\n您没有权限申请举办赛事。\n\n**需要以下权限之一：**\n• 服务器管理员权限`;
    
    if (allowedRoles.length > 0) {
        message += `\n• 以下身份组之一：${allowedRoles.map(role => `\`${role}\``).join('、')}`;
    }
    
    message += `\n\n请联系服务器管理员获取相应权限。`;
    return message;
}

/**
 * 获取审核权限不足的错误消息
 */
function getReviewPermissionDeniedMessage() {
    return `❌ **权限不足**\n\n您没有权限审核赛事申请。只有管理员和赛事审核员可以进行审核操作。`;
}

/**
 * 获取管理权限不足的错误消息
 */
function getManagePermissionDeniedMessage() {
    return `❌ **权限不足**\n\n您没有权限管理此赛事频道。只有赛事申请人和管理员可以管理赛事。`;
}

module.exports = {
    checkContestApplicationPermission,
    checkContestReviewPermission,
    checkContestManagePermission,
    getApplicationPermissionDeniedMessage,
    getReviewPermissionDeniedMessage,
    getManagePermissionDeniedMessage
};