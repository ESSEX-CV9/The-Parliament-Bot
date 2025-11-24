// src\core\utils\permissionManager.js
const { PermissionFlagsBits } = require('discord.js');
const { isUserInSelfModerationBlacklist } = require('./database');

// 配置允许使用管理指令的身份组名称
const ALLOWED_ROLE_NAMES = [
    '管理组',
    '高级权限',
    '类脑紧急管理组',
    '赛博公仆',
    '紧急状态委员',
    '风干腊肉'
    // 在这里添加更多允许的身份组名称
];

// 配置允许使用管理指令的Discord原生权限
const ALLOWED_PERMISSIONS = [
    PermissionFlagsBits.Administrator,
];

/**
 * 检查用户是否有权限使用管理指令
 * @param {GuildMember} member - 服务器成员对象
 * @returns {boolean} 是否有权限
 */
function checkAdminPermission(member) {
    try {
        console.log(`\n=== 权限检查开始 ===`);
        console.log(`用户: ${member.user.tag} (${member.user.id})`);
        console.log(`服务器: ${member.guild.name} (${member.guild.id})`);
        
        // 安全检查 member 对象
        if (!member || !member.user || !member.guild || !member.roles) {
            console.log(`❌ 成员对象不完整`);
            console.log(`=== 权限检查结束 ===\n`);
            return false;
        }
        
        // 获取用户的所有身份组
        const userRoles = [];
        const userRoleNames = [];
        
        if (member.roles.cache) {
            member.roles.cache.forEach(role => {
                userRoles.push({
                    name: role.name,
                    id: role.id
                });
                userRoleNames.push(role.name);
            });
        }
        
        console.log(`用户身份组:`, userRoles);
        console.log(`允许的身份组:`, ALLOWED_ROLE_NAMES);
        
        // 检查是否是服务器所有者
        if (member.guild.ownerId === member.user.id) {
            console.log(`✅ 权限检查 - 服务器所有者: ${member.user.tag}`);
            console.log(`=== 权限检查结束 ===\n`);
            return true;
        }
        
        // 检查Discord原生权限
        if (member.permissions) {
            for (const permission of ALLOWED_PERMISSIONS) {
                if (member.permissions.has(permission)) {
                    console.log(`✅ 权限检查 - 拥有原生权限: ${member.user.tag}, 权限码: ${permission}`);
                    console.log(`=== 权限检查结束 ===\n`);
                    return true;
                }
            }
        }
        
        // 检查是否拥有允许的身份组
        console.log(`用户身份组名称列表:`, userRoleNames);
        
        // 详细检查每个身份组
        const matchingRoles = [];
        if (member.roles.cache) {
            for (const userRole of member.roles.cache.values()) {
                console.log(`检查身份组: "${userRole.name}" 是否在允许列表中...`);
                if (ALLOWED_ROLE_NAMES.includes(userRole.name)) {
                    matchingRoles.push(userRole.name);
                    console.log(`✅ 匹配的身份组: "${userRole.name}"`);
                } else {
                    console.log(`❌ 不匹配的身份组: "${userRole.name}"`);
                }
            }
        }
        
        if (matchingRoles.length > 0) {
            console.log(`✅ 权限检查 - 拥有允许的身份组: ${member.user.tag}, 匹配的身份组: ${matchingRoles.join(', ')}`);
            console.log(`=== 权限检查结束 ===\n`);
            return true;
        }
        
        console.log(`❌ 权限检查 - 权限不足: ${member.user.tag}`);
        console.log(`用户所有身份组: ${userRoleNames.join(', ')}`);
        console.log(`允许的身份组: ${ALLOWED_ROLE_NAMES.join(', ')}`);
        console.log(`=== 权限检查结束 ===\n`);
        return false;
        
    } catch (error) {
        console.error('权限检查过程中出错:', error);
        console.log(`=== 权限检查结束（出错） ===\n`);
        return false;
    }
}

/**
 * 获取权限不足时的错误消息
 * @returns {string} 错误消息
 */
function getPermissionDeniedMessage() {
    return `❌ **权限不足**\n\n您没有权限使用此指令。\n\n**需要以下权限之一：**\n• 服务器所有者\n• 管理员权限\n• 管理服务器权限\n• 管理频道权限\n• 以下身份组之一：${ALLOWED_ROLE_NAMES.map(role => `\`${role}\``).join('、')}\n\n请联系服务器管理员获取相应权限。`;
}

/**
 * 获取允许的身份组列表（用于其他文件调用）
 * @returns {string[]} 允许的身份组名称数组
 */
function getAllowedRoles() {
    return [...ALLOWED_ROLE_NAMES];
}

/**
 * 获取允许的权限列表
 * @returns {bigint[]} 允许的权限数组
 */
function getAllowedPermissions() {
    return [...ALLOWED_PERMISSIONS];
}

/**
 * 添加新的允许身份组（运行时添加）
 * @param {string} roleName - 身份组名称
 */
function addAllowedRole(roleName) {
    if (!ALLOWED_ROLE_NAMES.includes(roleName)) {
        ALLOWED_ROLE_NAMES.push(roleName);
        console.log(`已添加新的允许身份组: "${roleName}"`);
        console.log(`当前允许的身份组列表:`, ALLOWED_ROLE_NAMES);
    } else {
        console.log(`身份组 "${roleName}" 已存在于允许列表中`);
    }
}

/**
 * 移除允许的身份组（运行时移除）
 * @param {string} roleName - 身份组名称
 */
function removeAllowedRole(roleName) {
    const index = ALLOWED_ROLE_NAMES.indexOf(roleName);
    if (index > -1) {
        ALLOWED_ROLE_NAMES.splice(index, 1);
        console.log(`已移除允许身份组: "${roleName}"`);
        console.log(`当前允许的身份组列表:`, ALLOWED_ROLE_NAMES);
    } else {
        console.log(`身份组 "${roleName}" 不在允许列表中`);
    }
}

/**
 * 获取用户权限详情（用于调试）
 * @param {GuildMember} member - 服务器成员对象
 * @returns {object} 权限详情
 */
function getUserPermissionDetails(member) {
    try {
        // 安全获取用户身份组信息
        const userRoles = [];
        const userRoleNames = [];
        
        if (member.roles && member.roles.cache) {
            member.roles.cache.forEach(role => {
                userRoles.push({
                    name: role.name,
                    id: role.id
                });
                userRoleNames.push(role.name);
            });
        }
        
        // 安全检查原生权限
        let hasNativePermissions = false;
        if (member.permissions) {
            hasNativePermissions = ALLOWED_PERMISSIONS.some(permission => 
                member.permissions.has(permission)
            );
        }
        
        // 安全获取匹配的身份组
        const allowedUserRoles = userRoleNames.filter(roleName => 
            ALLOWED_ROLE_NAMES.includes(roleName)
        );
        
        return {
            userId: member.user ? member.user.id : 'unknown',
            userTag: member.user ? member.user.tag : 'unknown',
            isOwner: member.guild ? (member.guild.ownerId === member.user.id) : false,
            hasNativePermissions,
            userRoles,
            userRoleNames,
            allowedUserRoles,
            allowedRolesList: [...ALLOWED_ROLE_NAMES],
            hasPermission: checkAdminPermission(member)
        };
    } catch (error) {
        console.error('获取用户权限详情时出错:', error);
        return {
            userId: 'error',
            userTag: 'error',
            isOwner: false,
            hasNativePermissions: false,
            userRoles: [],
            userRoleNames: [],
            allowedUserRoles: [],
            allowedRolesList: [...ALLOWED_ROLE_NAMES],
            hasPermission: false,
            error: error.message
        };
    }
}

/**
 * 检查用户是否有权限使用自助管理功能
 * @param {GuildMember} member - 服务器成员对象
 * @param {string} type - 权限类型 ('delete' 或 'mute')
 * @param {object} settings - 自助管理设置
 * @returns {boolean} 是否有权限
 */
function checkSelfModerationPermission(member, type, settings) {
    try {
        console.log(`\n=== 自助管理权限检查开始 ===`);
        console.log(`用户: ${member.user.tag} (${member.user.id})`);
        console.log(`权限类型: ${type}`);
        console.log(`服务器: ${member.guild.name} (${member.guild.id})`);
        
        // 安全检查
        if (!member || !member.user || !member.guild || !member.roles || !settings) {
            console.log(`❌ 参数不完整`);
            console.log(`=== 自助管理权限检查结束 ===\n`);
            return false;
        }
        
        // 如果没有配置特定权限，使用管理员权限
        let allowedRoles = [];
        if (type === 'delete' && settings.deleteRoles) {
            allowedRoles = settings.deleteRoles;
        } else if (type === 'mute' && settings.muteRoles) {
            allowedRoles = settings.muteRoles;
        }
        
        // 如果没有配置特定权限，回退到管理员权限检查
        if (!allowedRoles || allowedRoles.length === 0) {
            console.log(`未配置${type}权限，使用管理员权限检查`);
            const hasAdminPermission = checkAdminPermission(member);
            console.log(`=== 自助管理权限检查结束 ===\n`);
            return hasAdminPermission;
        }
        
        // 检查是否是服务器所有者
        if (member.guild.ownerId === member.user.id) {
            console.log(`✅ 自助管理权限检查 - 服务器所有者: ${member.user.tag}`);
            console.log(`=== 自助管理权限检查结束 ===\n`);
            return true;
        }
        
        // 检查是否拥有指定的身份组
        const userRoleIds = [];
        if (member.roles.cache) {
            member.roles.cache.forEach(role => {
                userRoleIds.push(role.id);
            });
        }
        
        console.log(`用户身份组ID:`, userRoleIds);
        console.log(`允许的身份组ID:`, allowedRoles);
        
        // 检查是否有匹配的身份组
        const hasMatchingRole = allowedRoles.some(roleId => userRoleIds.includes(roleId));
        
        if (hasMatchingRole) {
            console.log(`✅ 自助管理权限检查 - 拥有${type}权限: ${member.user.tag}`);
            console.log(`=== 自助管理权限检查结束 ===\n`);
            return true;
        }
        
        console.log(`❌ 自助管理权限检查 - ${type}权限不足: ${member.user.tag}`);
        console.log(`=== 自助管理权限检查结束 ===\n`);
        return false;
        
    } catch (error) {
        console.error('自助管理权限检查过程中出错:', error);
        console.log(`=== 自助管理权限检查结束（出错） ===\n`);
        return false;
    }
}

/**
 * 检查频道是否允许使用自助管理功能
 * @param {string} channelId - 频道ID
 * @param {object} settings - 自助管理设置
 * @returns {boolean} 是否允许
 */
function checkSelfModerationChannelPermission(channelId, settings) {
    try {
        console.log(`检查频道权限: ${channelId}`);
        
        if (!settings || !settings.allowedChannels) {
            console.log(`未配置允许的频道，默认允许`);
            return true;
        }
        
        const allowed = settings.allowedChannels.includes(channelId);
        console.log(`频道${channelId}是否允许使用自助管理: ${allowed}`);
        return allowed;
        
    } catch (error) {
        console.error('检查频道权限时出错:', error);
        return false;
    }
}

/**
 * 获取自助管理权限不足时的错误消息
 * @param {string} type - 权限类型
 * @returns {string} 错误消息
 */
function getSelfModerationPermissionDeniedMessage(type) {
    const actionName = type === 'delete' ? '删除搬屎消息' : '禁言搬屎用户';
    return `❌ **权限不足**\n\n您没有权限使用 \`/${actionName}\` 指令。`;
}


/**
 * 检查用户是否有权限使用表单
 * @param {GuildMember} member - 服务器成员对象
 * @param {object} formPermissionSettings - 表单权限设置
 * @returns {boolean} 是否有权限
 */
function checkFormPermission(member, formPermissionSettings) {
    try {
        console.log(`\n=== 表单权限检查开始 ===`);
        console.log(`用户: ${member.user.tag} (${member.user.id})`);
        console.log(`服务器: ${member.guild.name} (${member.guild.id})`);
        
        // 安全检查
        if (!member || !member.user || !member.guild || !member.roles) {
            console.log(`❌ 成员对象不完整`);
            console.log(`=== 表单权限检查结束 ===\n`);
            return false;
        }
        
        // 如果没有设置表单权限，默认所有人都可以使用
        if (!formPermissionSettings || !formPermissionSettings.allowedRoles || formPermissionSettings.allowedRoles.length === 0) {
            console.log(`✅ 表单权限检查 - 未设置权限限制，默认允许: ${member.user.tag}`);
            console.log(`=== 表单权限检查结束 ===\n`);
            return true;
        }
        
        // 检查是否是服务器所有者（所有者总是有权限）
        if (member.guild.ownerId === member.user.id) {
            console.log(`✅ 表单权限检查 - 服务器所有者: ${member.user.tag}`);
            console.log(`=== 表单权限检查结束 ===\n`);
            return true;
        }
        
        // 管理员也有权限
        if (checkAdminPermission(member)) {
            console.log(`✅ 表单权限检查 - 拥有管理员权限: ${member.user.tag}`);
            console.log(`=== 表单权限检查结束 ===\n`);
            return true;
        }
        
        // 检查是否拥有指定的身份组
        const userRoleIds = [];
        if (member.roles.cache) {
            member.roles.cache.forEach(role => {
                userRoleIds.push(role.id);
            });
        }
        
        console.log(`用户身份组ID:`, userRoleIds);
        console.log(`允许的身份组ID:`, formPermissionSettings.allowedRoles);
        
        // 检查是否有匹配的身份组
        const hasMatchingRole = formPermissionSettings.allowedRoles.some(roleId => userRoleIds.includes(roleId));
        
        if (hasMatchingRole) {
            console.log(`✅ 表单权限检查 - 拥有允许的身份组: ${member.user.tag}`);
            console.log(`=== 表单权限检查结束 ===\n`);
            return true;
        }
        
        console.log(`❌ 表单权限检查 - 权限不足: ${member.user.tag}`);
        console.log(`=== 表单权限检查结束 ===\n`);
        return false;
        
    } catch (error) {
        console.error('表单权限检查过程中出错:', error);
        console.log(`=== 表单权限检查结束（出错） ===\n`);
        return false;
    }
}

/**
 * 获取表单权限不足时的错误消息
 * @param {array} allowedRoleNames - 允许的身份组名称数组
 * @returns {string} 错误消息
 */
function getFormPermissionDeniedMessage(allowedRoleNames = []) {
    let message = `❌ **权限不足**\n\n您没有权限使用此表单。\n\n**需要以下权限之一：**\n• 服务器所有者\n• 管理员权限`;
    
    if (allowedRoleNames.length > 0) {
        message += `\n• 以下身份组之一：${allowedRoleNames.map(role => `\`${role}\``).join('、')}`;
    }
    
    message += `\n\n请联系服务器管理员获取相应权限。`;
    return message;
}

/**
 * 检查用户是否有权限使用支持按钮
 * @param {GuildMember} member - 服务器成员对象
 * @param {object} supportPermissionSettings - 支持按钮权限设置
 * @returns {boolean} 是否有权限
 */
function checkSupportPermission(member, supportPermissionSettings) {
    try {
        console.log(`\n=== 支持按钮权限检查开始 ===`);
        console.log(`用户: ${member.user.tag} (${member.user.id})`);
        console.log(`服务器: ${member.guild.name} (${member.guild.id})`);
        
        // 安全检查
        if (!member || !member.user || !member.guild || !member.roles) {
            console.log(`❌ 成员对象不完整`);
            console.log(`=== 支持按钮权限检查结束 ===\n`);
            return false;
        }
        
        // 如果没有设置支持按钮权限，默认所有人都可以使用
        if (!supportPermissionSettings || !supportPermissionSettings.allowedRoles || supportPermissionSettings.allowedRoles.length === 0) {
            console.log(`✅ 支持按钮权限检查 - 未设置权限限制，默认允许: ${member.user.tag}`);
            console.log(`=== 支持按钮权限检查结束 ===\n`);
            return true;
        }
        
        // 检查是否是服务器所有者（所有者总是有权限）
        if (member.guild.ownerId === member.user.id) {
            console.log(`✅ 支持按钮权限检查 - 服务器所有者: ${member.user.tag}`);
            console.log(`=== 支持按钮权限检查结束 ===\n`);
            return true;
        }
        
        // 管理员也有权限
        if (checkAdminPermission(member)) {
            console.log(`✅ 支持按钮权限检查 - 拥有管理员权限: ${member.user.tag}`);
            console.log(`=== 支持按钮权限检查结束 ===\n`);
            return true;
        }
        
        // 检查是否拥有指定的身份组
        const userRoleIds = [];
        if (member.roles.cache) {
            member.roles.cache.forEach(role => {
                userRoleIds.push(role.id);
            });
        }
        
        console.log(`用户身份组ID:`, userRoleIds);
        console.log(`允许的身份组ID:`, supportPermissionSettings.allowedRoles);
        
        // 检查是否有匹配的身份组
        const hasMatchingRole = supportPermissionSettings.allowedRoles.some(roleId => userRoleIds.includes(roleId));
        
        if (hasMatchingRole) {
            console.log(`✅ 支持按钮权限检查 - 拥有允许的身份组: ${member.user.tag}`);
            console.log(`=== 支持按钮权限检查结束 ===\n`);
            return true;
        }
        
        console.log(`❌ 支持按钮权限检查 - 权限不足: ${member.user.tag}`);
        console.log(`=== 支持按钮权限检查结束 ===\n`);
        return false;
        
    } catch (error) {
        console.error('支持按钮权限检查过程中出错:', error);
        console.log(`=== 支持按钮权限检查结束（出错） ===\n`);
        return false;
    }
}

/**
 * 获取支持按钮权限不足时的错误消息
 * @param {array} allowedRoleNames - 允许的身份组名称数组
 * @returns {string} 错误消息
 */
function getSupportPermissionDeniedMessage(allowedRoleNames = []) {
    let message = `❌ **权限不足**\n\n您没有权限支持此提案。\n\n**需要以下权限之一：**\n• 服务器所有者\n• 管理员权限`;
    
    if (allowedRoleNames.length > 0) {
        message += `\n• 以下身份组之一：${allowedRoleNames.map(role => `\`${role}\``).join('、')}`;
    }
    
    message += `\n\n请联系服务器管理员获取相应权限。`;
    return message;
}

/**
 * 检查用户是否在自助管理黑名单中
 * @param {string} guildId - 服务器ID
 * @param {string} userId - 用户ID
 * @returns {Promise<object>} { isBlacklisted: boolean, reason: string, expiresAt: string, bannedBy: string }
 */
async function checkSelfModerationBlacklist(guildId, userId) {
    try {
        console.log(`\n=== 自助管理黑名单检查开始 ===`);
        console.log(`服务器: ${guildId}`);
        console.log(`用户: ${userId}`);
        
        const result = await isUserInSelfModerationBlacklist(guildId, userId);
        
        if (result.isBlacklisted) {
            console.log(`❌ 用户在黑名单中`);
            console.log(`封禁原因: ${result.reason || '无'}`);
            console.log(`过期时间: ${result.expiresAt || '永久'}`);
        } else {
            console.log(`✅ 用户不在黑名单中`);
        }
        
        console.log(`=== 自助管理黑名单检查结束 ===\n`);
        return result;
        
    } catch (error) {
        console.error('检查自助管理黑名单时出错:', error);
        console.log(`=== 自助管理黑名单检查结束（出错） ===\n`);
        return { isBlacklisted: false, reason: null, expiresAt: null, bannedBy: null };
    }
}

/**
 * 获取自助管理黑名单错误消息
 * @param {string} reason - 封禁原因（可选）
 * @param {string} expiresAt - 过期时间（可选）
 * @returns {string} 错误消息
 */
function getSelfModerationBlacklistMessage(reason = null, expiresAt = null) {
    let message = `❌ **您已被禁止使用自助管理功能**\n\n`;
    
    if (reason) {
        message += `**封禁原因：** ${reason}\n\n`;
    }
    
    if (expiresAt) {
        const expiryTimestamp = Math.floor(new Date(expiresAt).getTime() / 1000);
        message += `**解除时间：** <t:${expiryTimestamp}:F> (<t:${expiryTimestamp}:R>)\n\n`;
    } else {
        message += `**解除时间：** 永久封禁\n\n`;
    }
    
    message += `如有疑问，请联系服务器管理员。`;
    
    return message;
}

// 启动时打印配置信息
console.log(`\n=== 权限管理模块已加载 ===`);
console.log(`允许的身份组:`, ALLOWED_ROLE_NAMES);
console.log(`允许的原生权限数量:`, ALLOWED_PERMISSIONS.length);
console.log(`================================\n`);

module.exports = {
    checkAdminPermission,
    getPermissionDeniedMessage,
    getAllowedRoles,
    getAllowedPermissions,
    addAllowedRole,
    removeAllowedRole,
    getUserPermissionDetails,
    ALLOWED_ROLE_NAMES,
    ALLOWED_PERMISSIONS,

    // 表单权限相关导出
    checkFormPermission,
    getFormPermissionDeniedMessage,
    // 支持按钮权限相关导出
    checkSupportPermission,
    getSupportPermissionDeniedMessage,

    // 自助管理权限相关导出
    checkSelfModerationPermission,
    checkSelfModerationChannelPermission,
    getSelfModerationPermissionDeniedMessage,
    
    // 自助管理黑名单相关导出
    checkSelfModerationBlacklist,
    getSelfModerationBlacklistMessage
};