// src/utils/permissionManager.js
const { PermissionFlagsBits } = require('discord.js');

// 配置允许使用管理指令的身份组名称
const ALLOWED_ROLE_NAMES = [
    '管理组',
    '类脑紧急管理组',
    'BOT维护员',
    '赛博公仆',
    '紧急状态委员',
    // 在这里添加更多允许的身份组名称
];

// 配置允许使用管理指令的Discord原生权限
const ALLOWED_PERMISSIONS = [
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageChannels,
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
    ALLOWED_PERMISSIONS
};