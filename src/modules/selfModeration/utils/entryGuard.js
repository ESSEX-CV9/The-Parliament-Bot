// src\modules\selfModeration\utils\entryGuard.js
const { getSelfModerationSettings, checkUserGlobalCooldown } = require('../../../core/utils/database');
const {
    checkSelfModerationPermission,
    getSelfModerationPermissionDeniedMessage,
    checkSelfModerationBlacklist,
    getSelfModerationBlacklistMessage
} = require('../../../core/utils/permissionManager');
const { validateChannel } = require('./channelValidator');

// 冷却提示里展示的功能名（与各斜杠指令原有文案保持一致）
const COOLDOWN_LABELS = {
    mute: '禁言用户',
    delete: '删除消息',
    serious_mute: '严肃禁言'
};

/**
 * 自助管理投票入口的通用前置校验。
 *
 * 与斜杠指令中的校验顺序完全一致：配置 → 权限 → 黑名单 → 全局冷却 → 当前频道。
 * 本函数只做判断不做回复，由调用方决定用 reply 还是 editReply（右键+弹窗的场景
 * 在 showModal 之前不能 defer，因此必须把回复方式交给调用方）。
 *
 * @param {import('discord.js').Interaction} interaction - 交互对象
 * @param {string} type - 操作类型 ('delete' | 'mute' | 'serious_mute')
 * @returns {Promise<{ok: boolean, message?: string, settings?: object}>}
 */
async function runSelfModerationPreChecks(interaction, type) {
    // 严肃禁言沿用 mute 权限域（与 moderationService 中的处理一致）
    const permType = (type === 'serious_mute') ? 'mute' : type;

    // 获取设置
    const settings = await getSelfModerationSettings(interaction.guild.id);
    if (!settings) {
        return { ok: false, message: '❌ 该服务器未配置自助管理功能，请联系管理员设置。' };
    }

    // 检查用户权限
    const hasPermission = checkSelfModerationPermission(interaction.member, permType, settings);
    if (!hasPermission) {
        return { ok: false, message: getSelfModerationPermissionDeniedMessage(permType) };
    }

    // 检查用户是否在黑名单中
    const blacklistCheck = await checkSelfModerationBlacklist(interaction.guild.id, interaction.user.id);
    if (blacklistCheck.isBlacklisted) {
        return { ok: false, message: getSelfModerationBlacklistMessage(blacklistCheck.reason, blacklistCheck.expiresAt) };
    }

    // 检查全局冷却时间
    const cooldownCheck = await checkUserGlobalCooldown(interaction.guild.id, interaction.user.id, type);
    if (cooldownCheck.inCooldown) {
        const hours = Math.floor(cooldownCheck.remainingMinutes / 60);
        const minutes = cooldownCheck.remainingMinutes % 60;
        let timeText = '';
        if (hours > 0) timeText += `${hours}小时`;
        if (minutes > 0) timeText += `${minutes}分钟`;

        const label = COOLDOWN_LABELS[type] || type;
        return { ok: false, message: `❌ 您的${label}功能正在冷却中，请等待 **${timeText}** 后再试。` };
    }

    // 检查当前频道权限（右键时当前频道即目标消息所在频道）
    const currentChannelAllowed = await validateChannel(interaction.channel.id, settings, interaction.channel);
    if (!currentChannelAllowed) {
        return { ok: false, message: '❌ 此频道不允许使用自助管理功能。请在管理员设置的允许频道中使用此指令。' };
    }

    return { ok: true, settings };
}

module.exports = {
    runSelfModerationPreChecks
};
