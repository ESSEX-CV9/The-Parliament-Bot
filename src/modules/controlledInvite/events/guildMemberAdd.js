const {
    getConfigBySubGuild,
    getAllConfigs,
    getActiveRequestByOwner,
    markRequestConsumed,
    revokeActiveByOwnerAndSubGuild,
    addToBlacklist,
    isUserBlacklisted,
} = require('../utils/controlledInviteDatabase');
const { sendLog } = require('../services/inviteService');

/**
 * GuildMemberAdd 处理器 —— 链路 1（入服处理）
 * 只关心"进来的人"，不做任何码的溯源。与码主追责完全解耦。
 *
 * 判定矩阵：
 * 有 active 记录 + 在主服 → 放行，标记 consumed
 * 有 active 记录 + 不在主服 → kick + 撤销码 + 拉黑
 * 无记录 + 在主服 → kick + 日志告警
 * 无记录 + 不在主服 → ban + 日志告警
 */
async function controlledInviteGuildMemberAddHandler(member) {
    // 跳过 Bot
    if (member.user.bot) return;

    const subGuildId = member.guild.id;

    // 检查该服务器是否是某个配置的分服
    const config = getConfigBySubGuild(subGuildId);
    if (!config) return; // 不是受控分服，忽略
    if (!config.enabled) return; // 未启用，忽略

    const mainGuildId = config.main_guild_id;
    const userId = member.user.id;
    const userTag = member.user.tag;

    try {
        // 步骤 1：查数据库 - 加入者是否有 active 的申请记录
        const activeRequest = getActiveRequestByOwner(mainGuildId, subGuildId, userId);

        // 步骤 2：查主服 - 加入者是否在主服中
        let isInMainGuild = false;
        try {
            const mainGuild = await member.client.guilds.fetch(mainGuildId);
            const mainMember = await mainGuild.members.fetch(userId).catch(() => null);
            isInMainGuild = !!mainMember;
        } catch {
            // 无法访问主服，保守处理
            console.warn(`[ControlledInvite] 无法访问主服 ${mainGuildId}，对加入者 ${userTag} 保守处理`);
        }

        // ===== 判定矩阵 =====

        if (activeRequest && isInMainGuild) {
            // ✅ 有记录 + 在主服 → 放行
            markRequestConsumed(activeRequest.id);
            console.log(`[ControlledInvite] ✅ 合法加入: ${userTag} (${userId}) -> 分服 ${subGuildId}`);
            await sendLog(member.client, config,
                `✅ **合法加入**\n用户: <@${userId}>\n邀请码: \`${activeRequest.invite_code}\``);
            return;
        }

        if (activeRequest && !isInMainGuild) {
            // 🔴 有记录但退了主服 → kick + 撤销码 + 拉黑
            revokeActiveByOwnerAndSubGuild(mainGuildId, subGuildId, userId);
            addToBlacklist({
                mainGuildId,
                userId,
                subGuildId,
                reason: '申请邀请码后退出主服',
                sourceRequestId: activeRequest.id,
                createdBy: 'system',
            });

            await member.kick('受控邀请: 申请邀请码后退出主服').catch(() => {});
            console.log(`[ControlledInvite] 🔴 申请后退主服: ${userTag} (${userId}) -> kick`);
            await sendLog(member.client, config,
                `🔴 **申请后退主服 - 已踢出并拉黑**\n用户: <@${userId}>\n邀请码: \`${activeRequest.invite_code}\``);
            return;
        }

        if (!activeRequest && isInMainGuild) {
            // ⚠️ 无记录 + 在主服 → kick + 告警
            await member.kick('受控邀请: 无邀请记录的非法加入').catch(() => {});
            console.log(`[ControlledInvite] ⚠️ 无记录加入(在主服): ${userTag} (${userId}) -> kick`);
            await sendLog(member.client, config,
                `⚠️ **无邀请记录加入（在主服）- 已踢出**\n用户: <@${userId}>\n可能存在其他邀请渠道泄漏，请检查服务器邀请设置`);
            return;
        }

        if (!activeRequest && !isInMainGuild) {
            // 🔴 无记录 + 不在主服 → ban
            if (config.ban_on_unknown_join) {
                await member.ban({ reason: '受控邀请: 完全陌生的非法加入' }).catch(() => {});
                console.log(`[ControlledInvite] 🔴 陌生人加入: ${userTag} (${userId}) -> ban`);
                await sendLog(member.client, config,
                    `🔴 **陌生人非法加入 - 已封禁**\n用户: <@${userId}>\n不在主服且无邀请记录`);
            } else {
                await member.kick('受控邀请: 完全陌生的非法加入').catch(() => {});
                console.log(`[ControlledInvite] 🔴 陌生人加入: ${userTag} (${userId}) -> kick（封禁策略关闭）`);
                await sendLog(member.client, config,
                    `🔴 **陌生人非法加入 - 已踢出**\n用户: <@${userId}>\n不在主服且无邀请记录（封禁策略未开启）`);
            }
            return;
        }

    } catch (err) {
        console.error(`[ControlledInvite] GuildMemberAdd 处理出错: ${err.message}`, err);
        await sendLog(member.client, config,
            `❌ **入服处理异常**\n用户: <@${userId}>\n错误: ${err.message}`);
    }
}

module.exports = { controlledInviteGuildMemberAddHandler };
