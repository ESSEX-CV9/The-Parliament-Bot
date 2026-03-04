const { EmbedBuilder } = require('discord.js');
const {
    getConfig,
    getConfigsByMainGuild,
    getConfigBySubGuild,
    getEligibleRoles,
    isUserBlacklisted,
    isOnCooldown,
    getActiveRequestByOwner,
    createInviteRequest,
    setCooldown,
    markRequestConsumed,
} = require('../utils/controlledInviteDatabase');

/**
 * 处理按钮点击申请邀请码
 * customId 格式: ci_request:{sub_guild_id}
 */
async function handleInviteRequest(interaction) {
    const customId = interaction.customId;
    const subGuildId = customId.replace('ci_request:', '');

    // 1. 查找配置
    const config = getConfigBySubGuild(subGuildId);
    if (!config) {
        await interaction.reply({ content: '❌ 系统配置异常，请联系管理员', ephemeral: true });
        return;
    }

    const mainGuildId = config.main_guild_id;

    // 2. 校验配置启用
    if (!config.enabled) {
        await interaction.reply({ content: '❌ 受控邀请功能当前已禁用', ephemeral: true });
        return;
    }

    // 3. 校验邀请码频道已设置
    if (!config.sub_invite_channel_id) {
        await interaction.reply({ content: '❌ 系统尚未完成配置（缺少邀请码频道），请联系管理员', ephemeral: true });
        return;
    }

    const userId = interaction.user.id;

    // 4. 校验黑名单
    if (isUserBlacklisted(mainGuildId, userId, subGuildId)) {
        await interaction.reply({ content: '🚫 你已被禁止申请邀请码', ephemeral: true });
        return;
    }

    // 5. 校验冷却
    const cooldownInfo = isOnCooldown(mainGuildId, subGuildId, userId);
    if (cooldownInfo.onCooldown) {
        const cdTs = Math.floor(new Date(cooldownInfo.nextAvailableAt).getTime() / 1000);
        await interaction.reply({
            content: `⏳ 冷却中，请等待至 <t:${cdTs}:R> 后再试`,
            ephemeral: true,
        });
        return;
    }

    // 6. 校验资格身份组
    const eligibleRoles = getEligibleRoles(mainGuildId);
    if (eligibleRoles.length > 0) {
        const memberRoles = interaction.member.roles.cache.map(r => r.id);
        const hasEligible = eligibleRoles.some(roleId => memberRoles.includes(roleId));
        if (!hasEligible) {
            await interaction.reply({ content: '❌ 你没有申请资格，需要以下身份组之一：\n' + eligibleRoles.map(r => `<@&${r}>`).join(', '), ephemeral: true });
            return;
        }
    }

    // 7. 校验是否已在分服
    try {
        const subGuild = await interaction.client.guilds.fetch(subGuildId).catch(() => null);
        if (subGuild) {
            const member = await subGuild.members.fetch(userId).catch(() => null);
            if (member) {
                await interaction.reply({ content: '❌ 你已经在分服中，无需申请邀请码', ephemeral: true });
                return;
            }
        }
    } catch {
        // 无法访问分服，继续
    }

    // 8. 校验是否已有活跃邀请码
    const existingRequest = getActiveRequestByOwner(mainGuildId, subGuildId, userId);
    if (existingRequest) {
        const expiresTs = Math.floor(new Date(existingRequest.expires_at).getTime() / 1000);
        await interaction.reply({
            content: `❌ 你已有一个未过期的邀请码：\n🔗 ${existingRequest.invite_url}\n⏱️ 过期时间: <t:${expiresTs}:R>`,
            ephemeral: true,
        });
        return;
    }

    // 9. 创建邀请码
    await interaction.deferReply({ ephemeral: true });

    try {
        const subGuild = await interaction.client.guilds.fetch(subGuildId);
        const inviteChannel = await subGuild.channels.fetch(config.sub_invite_channel_id);

        const invite = await inviteChannel.createInvite({
            maxAge: config.invite_max_age_seconds,
            maxUses: 1,
            unique: true,
            reason: `受控邀请 - 申请人: ${interaction.user.tag} (${userId})`,
        });

        // 10. 写入数据库
        const expiresAt = new Date(Date.now() + config.invite_max_age_seconds * 1000).toISOString();
        createInviteRequest({
            mainGuildId,
            subGuildId,
            ownerUserId: userId,
            inviteCode: invite.code,
            inviteUrl: invite.url,
            expiresAt,
        });

        // 11. 更新冷却
        const nextAvailable = new Date(Date.now() + config.cooldown_seconds * 1000).toISOString();
        setCooldown(mainGuildId, subGuildId, userId, nextAvailable);

        // 12. 返回结果
        const expiresTs = Math.floor(new Date(expiresAt).getTime() / 1000);
        const subName = subGuild.name;

        const embed = new EmbedBuilder()
            .setTitle('🔗 邀请码已生成')
            .setDescription([
                `**目标分服**: ${subName}`,
                `**邀请链接**: ${invite.url}`,
                `**过期时间**: <t:${expiresTs}:R>`,
                '',
                '> ⚠️ 此邀请码仅限本人使用，请勿分享给他人。',
                '> 分享邀请码将导致您被永久禁止再次获取邀请码。',
            ].join('\n'))
            .setColor(0x57F287)
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

        // 13. 发送日志
        await sendLog(interaction.client, config, `📋 **邀请码申请**\n用户: <@${userId}>\n分服: ${subName}\n邀请码: \`${invite.code}\`\n过期: <t:${expiresTs}:R>`);

    } catch (err) {
        console.error('[ControlledInvite] 创建邀请码失败:', err);
        await interaction.editReply(`❌ 创建邀请码失败: ${err.message}`);
    }
}

/**
 * 发送日志到配置的日志频道
 */
async function sendLog(client, config, message) {
    if (!config.log_channel_id) return;
    try {
        const channel = await client.channels.fetch(config.log_channel_id).catch(() => null);
        if (channel) {
            await channel.send(message);
        }
    } catch (err) {
        console.error('[ControlledInvite] 发送日志失败:', err);
    }
}

module.exports = { handleInviteRequest, sendLog };
