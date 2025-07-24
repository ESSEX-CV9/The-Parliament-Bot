// src/modules/proposal/utils/proposalPermissions.js
const { getProposalSettings } = require('./proposalDatabase');
const { checkAdminPermission } = require('../../../core/utils/permissionManager');

/**
 * 检查用户是否具有议案审核权限
 * @param {GuildMember} member - Discord成员对象
 * @param {Object} proposalSettings - 议案设置对象
 * @returns {boolean} 是否具有审核权限
 */
function checkProposalReviewPermission(member, proposalSettings) {
    // 管理员始终具有权限
    if (checkAdminPermission(member)) {
        console.log(`用户 ${member.user.tag} 具有管理员权限，允许审核议案`);
        return true;
    }
    
    // 检查是否设置了审核员身份组
    if (!proposalSettings || !proposalSettings.reviewerRoles || proposalSettings.reviewerRoles.length === 0) {
        console.log(`未设置审核员身份组，只有管理员可以审核议案`);
        return false;
    }
    
    // 检查用户是否拥有审核员身份组
    const userRoles = member.roles.cache;
    const hasReviewerRole = proposalSettings.reviewerRoles.some(roleId => userRoles.has(roleId));
    
    if (hasReviewerRole) {
        console.log(`用户 ${member.user.tag} 具有审核员身份组，允许审核议案`);
        return true;
    }
    
    console.log(`用户 ${member.user.tag} 没有审核权限`);
    return false;
}

/**
 * 获取权限被拒绝时的消息
 * @returns {string} 拒绝消息
 */
function getReviewPermissionDeniedMessage() {
    return '❌ 您没有审核议案的权限。只有管理员或指定的审核员可以审核议案。';
}

/**
 * 检查用户是否可以编辑议案（只有议案作者可以编辑）
 * @param {string} userId - 用户ID
 * @param {Object} proposalApplication - 议案申请对象
 * @returns {boolean} 是否可以编辑
 */
function checkProposalEditPermission(userId, proposalApplication) {
    return proposalApplication && proposalApplication.authorId === userId;
}

/**
 * 获取编辑权限被拒绝时的消息
 * @returns {string} 拒绝消息
 */
function getEditPermissionDeniedMessage() {
    return '❌ 只有议案作者可以编辑议案内容。';
}

/**
 * 检查用户是否可以撤销议案（只有议案作者可以撤销）
 * @param {string} userId - 用户ID
 * @param {Object} proposalApplication - 议案申请对象
 * @returns {boolean} 是否可以撤销
 */
function checkProposalWithdrawPermission(userId, proposalApplication) {
    return proposalApplication && proposalApplication.authorId === userId;
}

/**
 * 获取撤销权限被拒绝时的消息
 * @returns {string} 拒绝消息
 */
function getWithdrawPermissionDeniedMessage() {
    return '❌ 只有议案作者可以撤销议案。';
}

/**
 * 检查用户是否可以发布议案到投票频道（需要审核权限）
 * @param {GuildMember} member - Discord成员对象
 * @param {Object} proposalSettings - 议案设置对象
 * @returns {boolean} 是否可以发布
 */
function checkProposalPublishPermission(member, proposalSettings) {
    return checkProposalReviewPermission(member, proposalSettings);
}

/**
 * 获取发布权限被拒绝时的消息
 * @returns {string} 拒绝消息
 */
function getPublishPermissionDeniedMessage() {
    return '❌ 您没有发布议案的权限。只有管理员或指定的审核员可以发布议案。';
}

/**
 * 异步检查议案审核权限
 * @param {GuildMember} member - Discord成员对象
 * @param {string} guildId - 服务器ID
 * @returns {Promise<boolean>} 是否具有审核权限
 */
async function checkProposalReviewPermissionAsync(member, guildId) {
    try {
        const proposalSettings = await getProposalSettings(guildId);
        return checkProposalReviewPermission(member, proposalSettings);
    } catch (error) {
        console.error('检查议案审核权限时出错:', error);
        return false;
    }
}

/**
 * 获取用户拥有的审核员身份组名称列表
 * @param {GuildMember} member - Discord成员对象
 * @param {Object} proposalSettings - 议案设置对象
 * @returns {Promise<string[]>} 身份组名称列表
 */
async function getUserReviewerRoleNames(member, proposalSettings) {
    const roleNames = [];
    
    if (!proposalSettings || !proposalSettings.reviewerRoles) {
        return roleNames;
    }
    
    for (const roleId of proposalSettings.reviewerRoles) {
        try {
            if (member.roles.cache.has(roleId)) {
                const role = await member.guild.roles.fetch(roleId);
                if (role) {
                    roleNames.push(role.name);
                }
            }
        } catch (error) {
            // 忽略获取身份组名称的错误
        }
    }
    
    return roleNames;
}

module.exports = {
    checkProposalReviewPermission,
    getReviewPermissionDeniedMessage,
    checkProposalEditPermission,
    getEditPermissionDeniedMessage,
    checkProposalWithdrawPermission,
    getWithdrawPermissionDeniedMessage,
    checkProposalPublishPermission,
    getPublishPermissionDeniedMessage,
    checkProposalReviewPermissionAsync,
    getUserReviewerRoleNames
}; 