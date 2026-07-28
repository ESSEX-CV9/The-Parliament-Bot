// src/modules/botMessage/utils/botMessagePermissions.js
const { checkAdminPermission } = require('../../../core/utils/permissionManager');
const { getBotMessageAllowedRoles } = require('../services/botMessageDatabase');

/**
 * 检查成员是否有权使用「机器人消息」相关指令
 *
 * 规则（与风纪指令一致的受限语义）：
 * - 服务器所有者、Discord 管理员、core 里配置的管理身份组 → 始终允许
 * - 否则必须命中本模块配置的白名单身份组
 *
 * @param {import('discord.js').GuildMember} member
 * @returns {boolean}
 */
function checkBotMessagePermission(member) {
    try {
        if (!member || !member.user || !member.guild || !member.roles) {
            return false;
        }

        if (member.guild.ownerId === member.user.id) {
            return true;
        }

        if (checkAdminPermission(member)) {
            return true;
        }

        const allowedRoles = getBotMessageAllowedRoles(member.guild.id);
        if (!allowedRoles || allowedRoles.length === 0) {
            return false;
        }

        for (const role of member.roles.cache.values()) {
            if (allowedRoles.includes(role.id)) {
                return true;
            }
        }

        return false;
    } catch (error) {
        console.error('[BotMessage] 权限检查出错:', error);
        return false;
    }
}

function getBotMessagePermissionDeniedMessage() {
    return [
        '❌ **权限不足**',
        '',
        '你没有权限使用「机器人消息」相关指令。',
        '',
        '**需要以下之一：**',
        '• 服务器所有者',
        '• 管理员权限',
        '• 已被加入白名单的身份组（`/机器人消息 配置 操作:添加身份组`）',
    ].join('\n');
}

module.exports = {
    checkBotMessagePermission,
    getBotMessagePermissionDeniedMessage,
};
