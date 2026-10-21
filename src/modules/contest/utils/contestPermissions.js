// src/modules/contest/utils/contestPermissions.js
const { checkAdminPermission } = require('../../../core/utils/permissionManager');

/**
 * 检查用户是否有申请赛事的权限
 */
function checkContestApplicationPermission(member, contestSettings) {
    try {
        if (!member?.user || !member.guild || typeof member.roles?.cache?.has !== 'function' ||
            !contestSettings || typeof contestSettings !== 'object' || Array.isArray(contestSettings)) {
            return false;
        }

        console.log(`检查赛事申请权限 - 用户: ${member.user.tag}`);

        const allowedRoles = contestSettings?.applicationPermissionRoles;
        // 旧配置没有此字段时视为未设置；损坏的配置不能当作无限制。
        if (allowedRoles !== undefined && (!Array.isArray(allowedRoles) ||
            !allowedRoles.every(roleId => typeof roleId === 'string' && roleId.length > 0))) {
            return false;
        }

        // 如果没有设置申请权限，默认所有人都可以申请
        if (allowedRoles === undefined || allowedRoles.length === 0) {
            console.log(`✅ 未设置权限限制，默认允许 - ${member.user.tag}`);
            return true;
        }

        // 申请资格统一按身份组判断，管理员和服务器所有者同样需要持有。
        const hasPermission = allowedRoles.some(roleId => member.roles.cache.has(roleId));

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
 * 检查用户是否有绑定身份组的权限
 */
function checkContestRoleBindingPermission(member, contestSettings) {
    // 权限和审核
    return checkContestReviewPermission(member, contestSettings)
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
 * 检查用户是否有管理比赛身份组的权限（主办方或审核员）
 */
function checkContestRoleManagePermission(member, contestChannelData, contestSettings) {
    try {
        console.log(`检查身份组管理权限 - 用户: ${member.user.tag}, 频道: ${contestChannelData.channelId}`);

        // 管理员总是有权限
        if (checkAdminPermission(member)) {
            console.log(`✅ 管理员权限 - ${member.user.tag}`);
            return true;
        }

        // 申请人（主办方）有权限
        if (member.user.id === contestChannelData.applicantId) {
            console.log(`✅ 申请人权限 - ${member.user.tag}`);
            return true;
        }

        // 审核员有权限
        if (checkContestReviewPermission(member, contestSettings)) {
            // checkContestReviewPermission 内部会打印日志，所以这里不用重复
            console.log(`✅ 审核员权限 - ${member.user.tag}`);
            return true;
        }

        console.log(`❌ 无身份组管理权限 - ${member.user.tag}`);
        return false;

    } catch (error) {
        console.error('检查身份组管理权限时出错:', error);
        return false;
    }
}

/**
 * 获取申请权限不足的错误消息，参数为配置的身份组ID。
 */
function getApplicationPermissionDeniedMessage(allowedRoles = []) {
    let message = `❌ **权限不足**\n\n您没有权限申请举办赛事。`;

    if (Array.isArray(allowedRoles) && allowedRoles.length > 0) {
        const roleIds = allowedRoles.filter(roleId => typeof roleId === 'string' && roleId.length > 0);
        if (roleIds.length > 0) {
            message += `\n\n**需要持有以下前置身份组之一：**\n${roleIds.map(roleId => `• <@&${roleId}>（ID：\`${roleId}\`）`).join('\n')}`;
        }
    }

    message += `\n\n管理员申请同样需要前置身份组。请联系服务器管理员检查申请资格；若身份组已删除或无法显示，请重新设置或清除前置身份组限制。`;
    return message;
}

/**
 * 获取审核权限不足的错误消息
 */
function getReviewPermissionDeniedMessage() {
    return `❌ **权限不足**\n\n您没有权限审核赛事申请。只有管理员和赛事审核员可以进行审核操作。`;
}

/**
 * 获取身份组绑定权限不足的错误消息
 */
function getRoleBindingPermissionDeniedMessage() {
    return `❌ **权限不足**\n\n您没有权限绑定赛事身份组。只有管理员和赛事审核员可以进行绑定操作。`;
}

/**
 * 获取身份组管理权限不足的错误消息
 */
function getContestRoleManagePermissionDeniedMessage() {
    return `❌ **权限不足**\n\n您没有权限管理比赛身份组。只有赛事申请人、审核员和管理员可以管理赛事。`;
}

/**
 * 获取管理权限不足的错误消息
 */
function getManagePermissionDeniedMessage() {
    return `❌ **权限不足**\n\n您没有权限管理此赛事频道。只有赛事申请人和管理员可以管理赛事。`;
}

/**
 * 检查身份组是否为纯装饰性（无任何权限）
 * @param {import('discord.js').Role} role - 要检查的身份组对象
 * @returns {boolean}
 */
function isRoleDecorative(role) {
    // BigInt 0n 代表没有任何权限位被设置
    return role.permissions.bitfield === 0n;
}

module.exports = {
    checkContestApplicationPermission,
    checkContestReviewPermission,
    checkContestManagePermission,
    checkContestRoleBindingPermission,
    checkContestRoleManagePermission,
    getApplicationPermissionDeniedMessage,
    getReviewPermissionDeniedMessage,
    getRoleBindingPermissionDeniedMessage,
    getContestRoleManagePermissionDeniedMessage,
    getManagePermissionDeniedMessage,
    isRoleDecorative,
};
