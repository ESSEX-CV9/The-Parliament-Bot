// src\core\utils\permissionManager.js
const { PermissionFlagsBits } = require('discord.js');
const { isUserInSelfModerationBlacklist } = require('./database');

// 配置允许使用管理指令的身份组ID
// TODO: 替换为实际的身份组ID
const ALLOWED_ROLE_IDS = [
    '1290637015821451315', // 总管理
    '1385066450829705226', // 执行管理
    '1289224017789583453', 
    // 在这里添加更多允许的身份组ID
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
        // 安全检查 member 对象
        if (!member || !member.user || !member.guild || !member.roles) {
            return false;
        }

        // 检查是否是服务器所有者
        if (member.guild.ownerId === member.user.id) {
            return true;
        }

        // 检查Discord原生权限
        if (member.permissions) {
            for (const permission of ALLOWED_PERMISSIONS) {
                if (member.permissions.has(permission)) {
                    return true;
                }
            }
        }

        // 检查是否拥有允许的身份组（按ID匹配）
        if (member.roles.cache) {
            for (const userRole of member.roles.cache.values()) {
                if (ALLOWED_ROLE_IDS.includes(userRole.id)) {
                    return true;
                }
            }
        }

        return false;

    } catch (error) {
        console.error('权限检查过程中出错:', error);
        return false;
    }
}

/**
 * 检查一组角色ID是否包含管理员角色
 * @param {string[]} roleIds - 角色ID数组
 * @returns {boolean} 是否包含管理员角色
 */
function checkAdminByRoleIds(roleIds) {
    if (!roleIds || !Array.isArray(roleIds)) return false;
    return roleIds.some(id => ALLOWED_ROLE_IDS.includes(id));
}

/**
 * 获取权限不足时的错误消息
 * @returns {string} 错误消息
 */
function getPermissionDeniedMessage() {
    return `❌ **权限不足**\n\n您没有权限使用此指令。\n\n**需要以下权限之一：**\n• 服务器所有者\n• 管理员权限\n• 指定管理身份组之一\n\n请联系服务器管理员获取相应权限。`;
}

/**
 * 获取允许的身份组ID列表
 * @returns {string[]} 允许的身份组ID数组
 */
function getAllowedRoles() {
    return [...ALLOWED_ROLE_IDS];
}

/**
 * 获取允许的权限列表
 * @returns {bigint[]} 允许的权限数组
 */
function getAllowedPermissions() {
    return [...ALLOWED_PERMISSIONS];
}

/**
 * 获取用户权限详情（用于调试）
 * @param {GuildMember} member - 服务器成员对象
 * @returns {object} 权限详情
 */
function getUserPermissionDetails(member) {
    try {
        const userRoles = [];
        const userRoleIds = [];

        if (member.roles && member.roles.cache) {
            member.roles.cache.forEach(role => {
                userRoles.push({
                    name: role.name,
                    id: role.id
                });
                userRoleIds.push(role.id);
            });
        }

        let hasNativePermissions = false;
        if (member.permissions) {
            hasNativePermissions = ALLOWED_PERMISSIONS.some(permission =>
                member.permissions.has(permission)
            );
        }

        const allowedUserRoles = userRoleIds.filter(roleId =>
            ALLOWED_ROLE_IDS.includes(roleId)
        );

        return {
            userId: member.user ? member.user.id : 'unknown',
            userTag: member.user ? member.user.tag : 'unknown',
            isOwner: member.guild ? (member.guild.ownerId === member.user.id) : false,
            hasNativePermissions,
            userRoles,
            userRoleIds,
            allowedUserRoles,
            allowedRolesList: [...ALLOWED_ROLE_IDS],
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
            userRoleIds: [],
            allowedUserRoles: [],
            allowedRolesList: [...ALLOWED_ROLE_IDS],
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
        // 安全检查
        if (!member || !member.user || !member.guild || !member.roles || !settings) {
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
            return checkAdminPermission(member);
        }

        // 检查是否是服务器所有者
        if (member.guild.ownerId === member.user.id) {
            return true;
        }

        // 检查是否拥有指定的身份组
        const userRoleIds = [];
        if (member.roles.cache) {
            member.roles.cache.forEach(role => {
                userRoleIds.push(role.id);
            });
        }

        return allowedRoles.some(roleId => userRoleIds.includes(roleId));

    } catch (error) {
        console.error('自助管理权限检查过程中出错:', error);
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
        if (!settings || !settings.allowedChannels) {
            return true;
        }
        return settings.allowedChannels.includes(channelId);
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
        if (!member || !member.user || !member.guild || !member.roles) {
            return false;
        }

        // 如果没有设置表单权限，默认所有人都可以使用
        if (!formPermissionSettings || !formPermissionSettings.allowedRoles || formPermissionSettings.allowedRoles.length === 0) {
            return true;
        }

        // 服务器所有者总是有权限
        if (member.guild.ownerId === member.user.id) {
            return true;
        }

        // 管理员也有权限
        if (checkAdminPermission(member)) {
            return true;
        }

        // 检查是否拥有指定的身份组
        const userRoleIds = [];
        if (member.roles.cache) {
            member.roles.cache.forEach(role => {
                userRoleIds.push(role.id);
            });
        }

        return formPermissionSettings.allowedRoles.some(roleId => userRoleIds.includes(roleId));

    } catch (error) {
        console.error('表单权限检查过程中出错:', error);
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
        if (!member || !member.user || !member.guild || !member.roles) {
            return false;
        }

        // 如果没有设置支持按钮权限，默认所有人都可以使用
        if (!supportPermissionSettings || !supportPermissionSettings.allowedRoles || supportPermissionSettings.allowedRoles.length === 0) {
            return true;
        }

        // 服务器所有者总是有权限
        if (member.guild.ownerId === member.user.id) {
            return true;
        }

        // 管理员也有权限
        if (checkAdminPermission(member)) {
            return true;
        }

        // 检查是否拥有指定的身份组
        const userRoleIds = [];
        if (member.roles.cache) {
            member.roles.cache.forEach(role => {
                userRoleIds.push(role.id);
            });
        }

        return supportPermissionSettings.allowedRoles.some(roleId => userRoleIds.includes(roleId));

    } catch (error) {
        console.error('支持按钮权限检查过程中出错:', error);
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
        const result = await isUserInSelfModerationBlacklist(guildId, userId);
        return result;
    } catch (error) {
        console.error('检查自助管理黑名单时出错:', error);
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

module.exports = {
    checkAdminPermission,
    checkAdminByRoleIds,
    getPermissionDeniedMessage,
    getAllowedRoles,
    getAllowedPermissions,
    getUserPermissionDetails,
    ALLOWED_ROLE_IDS,
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
