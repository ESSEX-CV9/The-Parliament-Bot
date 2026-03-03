const { EmbedBuilder } = require('discord.js');
const {
    insertPunishmentRecord,
    getWarnRoleForGuild,
    getSetting,
} = require('./punishmentDatabase');
const { syncBan, syncUnban, syncMute, syncWarnRole } = require('./syncService');

const MAX_TIMEOUT_MS = 28 * 24 * 3600 * 1000; // Discord timeout 上限 28 天

const COLORS = {
    ban: 0xFF0000,
    unban: 0x00AA00,
    mute: 0xFF8C00,
    warn_role: 0xFFD700,
};

const TITLES = {
    ban: '🔨 成员封禁公告',
    unban: '✅ 成员解封公告',
    mute: '🔇 成员禁言公告',
    warn_role: '⚠️ 成员警告公告',
};

const TYPE_LABELS = {
    ban: '永久封禁',
    unban: '解除封禁',
    mute: '禁言',
    warn_role: '警告身份组',
};

// ========== 公告 ==========

async function sendAnnouncement(client, guildId, { type, targetUserId, executorId, reason, durationLabel, expiresAt, synced }) {
    const channelId = getSetting(guildId, 'announcement_channel_id');
    if (!channelId) return;

    try {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
            console.warn(`[Punishment] 公告频道 ${channelId} 不存在或非文本频道`);
            return;
        }

        const timestamp = Math.floor(Date.now() / 1000);
        let description =
            `**被处罚用户：** <@${targetUserId}> (\`${targetUserId}\`)\n` +
            `**执行管理员：** <@${executorId}>\n` +
            `**处罚类型：** ${TYPE_LABELS[type]}\n` +
            `**原因：** ${reason || '未说明'}\n` +
            `**执行时间：** <t:${timestamp}:F>`;

        if (durationLabel) {
            description += `\n**时长：** ${durationLabel}`;
        }
        if (expiresAt) {
            const expiresTimestamp = Math.floor(new Date(expiresAt).getTime() / 1000);
            description += `\n**到期时间：** <t:${expiresTimestamp}:F>`;
        }
        if (synced) {
            description += `\n**跨服同步：** 是`;
        }

        const embed = new EmbedBuilder()
            .setTitle(TITLES[type])
            .setDescription(description)
            .setColor(COLORS[type])
            .setTimestamp();

        await channel.send({ embeds: [embed] });
    } catch (err) {
        console.error(`[Punishment] 发送公告失败:`, err);
    }
}

function formatSyncResults(results) {
    if (!results || results.length === 0) return '';
    const lines = results.map(r => {
        if (r.success) return `✅ ${r.guildName || r.guildId}`;
        return `❌ ${r.guildId}: ${r.error}`;
    });
    return '\n**跨服同步结果：**\n' + lines.join('\n');
}

// ========== 封禁 ==========

async function executeBan(client, interaction, { targetUser, reason, sync }) {
    const guild = interaction.guild;

    try {
        await guild.members.ban(targetUser.id, { reason: reason || undefined });
    } catch (err) {
        await interaction.editReply(`❌ 封禁失败: ${err.message}`);
        return;
    }

    insertPunishmentRecord({
        guildId: guild.id,
        targetUserId: targetUser.id,
        executorId: interaction.user.id,
        type: 'ban',
        reason,
    });

    let syncResults = [];
    if (sync) {
        syncResults = await syncBan(client, guild.id, targetUser.id, reason);
    }

    await sendAnnouncement(client, guild.id, {
        type: 'ban',
        targetUserId: targetUser.id,
        executorId: interaction.user.id,
        reason,
        synced: sync,
    });

    await interaction.editReply(
        `✅ 已封禁用户 <@${targetUser.id}> (\`${targetUser.id}\`)` +
        (reason ? `\n原因: ${reason}` : '') +
        formatSyncResults(syncResults)
    );
}

// ========== 解封 ==========

async function executeUnban(client, interaction, { userId, reason, sync }) {
    const guild = interaction.guild;

    try {
        await guild.members.unban(userId, reason || undefined);
    } catch (err) {
        await interaction.editReply(`❌ 解封失败: ${err.message}`);
        return;
    }

    insertPunishmentRecord({
        guildId: guild.id,
        targetUserId: userId,
        executorId: interaction.user.id,
        type: 'unban',
        reason,
    });

    let syncResults = [];
    if (sync) {
        syncResults = await syncUnban(client, guild.id, userId, reason);
    }

    await sendAnnouncement(client, guild.id, {
        type: 'unban',
        targetUserId: userId,
        executorId: interaction.user.id,
        reason,
        synced: sync,
    });

    await interaction.editReply(
        `✅ 已解封用户 \`${userId}\`` +
        (reason ? `\n原因: ${reason}` : '') +
        formatSyncResults(syncResults)
    );
}

// ========== 禁言 ==========

async function executeMute(client, interaction, { targetMember, durationMs, durationLabel, reason, addWarnRole, sync }) {
    const guild = interaction.guild;

    if (durationMs > MAX_TIMEOUT_MS) {
        await interaction.editReply(`❌ 禁言时长不能超过 28 天`);
        return;
    }

    try {
        await targetMember.timeout(durationMs, reason || undefined);
    } catch (err) {
        await interaction.editReply(`❌ 禁言失败: ${err.message}`);
        return;
    }

    const expiresAt = new Date(Date.now() + durationMs).toISOString();
    insertPunishmentRecord({
        guildId: guild.id,
        targetUserId: targetMember.id,
        executorId: interaction.user.id,
        type: 'mute',
        reason,
        durationMs,
        expiresAt,
    });

    let warnRoleAdded = false;
    if (addWarnRole) {
        warnRoleAdded = await addWarnRoleToMember(client, guild, targetMember, durationMs, durationLabel, reason, interaction.user.id);
    }

    let syncResults = [];
    if (sync) {
        syncResults = await syncMute(client, guild.id, targetMember.id, durationMs, reason);
        if (addWarnRole) {
            const warnSyncResults = await syncWarnRole(client, guild.id, targetMember.id, durationMs, reason);
            syncResults = syncResults.concat(warnSyncResults.map(r => ({ ...r, note: '警告身份组' })));
        }
    }

    await sendAnnouncement(client, guild.id, {
        type: 'mute',
        targetUserId: targetMember.id,
        executorId: interaction.user.id,
        reason,
        durationLabel,
        expiresAt,
        synced: sync,
    });

    await interaction.editReply(
        `✅ 已禁言用户 <@${targetMember.id}> (\`${targetMember.id}\`)\n` +
        `时长: ${durationLabel}` +
        (warnRoleAdded ? '\n已同时添加警告身份组' : '') +
        (reason ? `\n原因: ${reason}` : '') +
        formatSyncResults(syncResults)
    );
}

// ========== 警告身份组 ==========

async function executeWarnRole(client, interaction, { targetMember, durationMs, durationLabel, reason, sync }) {
    const guild = interaction.guild;

    const added = await addWarnRoleToMember(client, guild, targetMember, durationMs, durationLabel, reason, interaction.user.id);
    if (!added) {
        await interaction.editReply(`❌ 本服务器未配置警告身份组，请先使用 \`/处罚 配置警告身份组\` 进行设置`);
        return;
    }

    let syncResults = [];
    if (sync) {
        syncResults = await syncWarnRole(client, guild.id, targetMember.id, durationMs, reason);
    }

    const expiresAt = new Date(Date.now() + durationMs).toISOString();
    await sendAnnouncement(client, guild.id, {
        type: 'warn_role',
        targetUserId: targetMember.id,
        executorId: interaction.user.id,
        reason,
        durationLabel,
        expiresAt,
        synced: sync,
    });

    await interaction.editReply(
        `✅ 已为用户 <@${targetMember.id}> 添加警告身份组\n` +
        `时长: ${durationLabel}` +
        (reason ? `\n原因: ${reason}` : '') +
        formatSyncResults(syncResults)
    );
}

/**
 * 内部辅助：为成员添加警告身份组并写入 DB
 * @returns {boolean} 是否成功添加
 */
async function addWarnRoleToMember(client, guild, targetMember, durationMs, durationLabel, reason, executorId) {
    const warnRoleId = getWarnRoleForGuild(guild.id);
    if (!warnRoleId) return false;

    try {
        await targetMember.roles.add(warnRoleId, reason || undefined);
    } catch (err) {
        console.error(`[Punishment] 添加警告身份组失败:`, err);
        return false;
    }

    const expiresAt = new Date(Date.now() + durationMs).toISOString();
    insertPunishmentRecord({
        guildId: guild.id,
        targetUserId: targetMember.id,
        executorId,
        type: 'warn_role',
        reason,
        durationMs,
        expiresAt,
    });

    return true;
}

module.exports = {
    executeBan,
    executeUnban,
    executeMute,
    executeWarnRole,
};
