// src/modules/channelArchive/commands/channelArchive.js
const fs = require('fs');
const path = require('path');
const { ChannelType, MessageFlags, SlashCommandBuilder } = require('discord.js');
const { getStore } = require('../store/instance');
const {
    ARCHIVE_STATUS,
    AUDIT_ACTION,
    SUBTHREAD_STATUS,
    TEMP_ROOT,
    VOTE_TYPE,
} = require('../utils/constants');
const { startVote, replyEphemeral } = require('../services/voteService');
const { canParticipate, isAdministrator, validateBusinessChannel } = require('../services/permissionService');
const { getArchiveQueue } = require('../services/archiveQueue');
const { formatTimestamp, describeConfig } = require('../services/configService');
const { statusLabel } = require('../services/votePanel');
const { truncate } = require('../utils/text');

const data = new SlashCommandBuilder()
    .setName('频道归档')
    .setDescription('频道归档与归档频道删除')
    .addSubcommand(subcommand =>
        subcommand
            .setName('发起')
            .setDescription('发起当前频道的归档投票（赛事组 3 票）'))
    .addSubcommand(subcommand =>
        subcommand
            .setName('删除')
            .setDescription('发起当前归档频道的删除投票（管理组 5 票）'))
    .addSubcommand(subcommand =>
        subcommand
            .setName('状态')
            .setDescription('查看当前频道的归档状态与断点'))
    .addSubcommand(subcommand =>
        subcommand
            .setName('重试')
            .setDescription('将失败或中断的归档任务重新加入队列'))
    .addSubcommand(subcommand =>
        subcommand
            .setName('取消归档')
            .setDescription('取消当前频道的归档状态以便重新归档（不会删除已有备份帖）'))
    .addSubcommand(subcommand =>
        subcommand
            .setName('批量归档')
            .setDescription('按频道 ID 批量归档文字频道（仅管理组）')
            .addStringOption(option =>
                option
                    .setName('频道id')
                    .setDescription('一个或多个频道 ID，用空格、逗号或换行分隔')
                    .setRequired(true)));

function threadLink(guildId, threadId) {
    return threadId ? `https://discord.com/channels/${guildId}/${threadId}` : '未生成';
}

function describeVote(vote) {
    if (!vote) return '无';
    return [
        statusLabel(vote.status),
        `同意 ${vote.approvedUsers.length} 人`,
        `过期：${formatTimestamp(vote.expires_at)}`,
    ].join(' · ');
}

async function handleStatus(interaction) {
    const store = getStore();
    const config = store.getConfig(interaction.guild.id);
    const member = interaction.member;
    const allowed = isAdministrator(member, interaction.memberPermissions)
        || (config && (canParticipate(member, config, VOTE_TYPE.ARCHIVE)
            || canParticipate(member, config, VOTE_TYPE.DELETE)));
    if (!allowed) {
        await replyEphemeral(interaction, '❌ 只有赛事组、管理组或管理员可以查看归档状态。');
        return;
    }

    const channelError = validateBusinessChannel(interaction.channel, config);
    if (channelError) {
        await replyEphemeral(interaction, channelError);
        return;
    }

    const channelId = interaction.channel.id;
    const record = store.getArchive(channelId);
    const archiveVote = store.getLatestVoteByChannelAndType(channelId, VOTE_TYPE.ARCHIVE);
    const deleteVote = store.getLatestVoteByChannelAndType(channelId, VOTE_TYPE.DELETE);
    const rows = store.listSubthreads(channelId);
    const completed = rows.filter(row => row.status === SUBTHREAD_STATUS.ARCHIVED).length;
    const queue = getArchiveQueue(interaction.client).describe();

    const lines = [
        `📋 **频道归档状态：${interaction.channel.name}**`,
        '',
        `**归档状态：** ${record ? record.status : '未归档'}`,
        `**主备份帖：** ${record ? threadLink(interaction.guild.id, record.target_thread_id) : '未生成'}`,
        `**已同步：** ${record ? record.total_synced_count : 0} 条`,
        `**高水位：** ${record?.last_synced_message_id || '无'}`,
        `**子区：** ${completed}/${rows.length} 已完成`,
        `**归档投票：** ${describeVote(archiveVote)}`,
        `**删除投票：** ${describeVote(deleteVote)}`,
        `**队列：** 运行中 ${queue.running ? `（${queue.channelId}）` : '否'}，等待 ${queue.waiting} 个`,
    ];
    if (record?.last_error) {
        lines.push(`**最近错误：** ${truncate(record.last_error, 300)}`);
    }
    const failed = rows.filter(row => row.status !== SUBTHREAD_STATUS.ARCHIVED);
    if (failed.length) {
        lines.push('', '**未完成子区：**');
        for (const row of failed.slice(0, 10)) {
            lines.push(`- ${row.thread_name}（${row.status}）${row.last_error ? `：${truncate(row.last_error, 80)}` : ''}`);
        }
        if (failed.length > 10) lines.push(`- 其余 ${failed.length - 10} 个`);
    }
    lines.push('', '**配置：**', describeConfig(config));

    await replyEphemeral(interaction, lines.join('\n'));
}

async function handleRetry(interaction) {
    const store = getStore();
    const config = store.getConfig(interaction.guild.id);
    const allowed = isAdministrator(interaction.member, interaction.memberPermissions)
        || canParticipate(interaction.member, config, VOTE_TYPE.DELETE);
    if (!allowed) {
        await replyEphemeral(interaction, '❌ 只有管理组或管理员可以重试归档任务。');
        return;
    }

    const channelError = validateBusinessChannel(interaction.channel, config);
    if (channelError) {
        await replyEphemeral(interaction, channelError);
        return;
    }

    const channelId = interaction.channel.id;
    const record = store.getArchive(channelId);
    if (!record) {
        await replyEphemeral(interaction, '❌ 该频道没有归档记录，无法重试。');
        return;
    }

    const pendingSub = store.listSubthreads(channelId)
        .some(row => row.status !== SUBTHREAD_STATUS.ARCHIVED);
    const retryable = record.status === ARCHIVE_STATUS.ARCHIVING
        || (record.status === ARCHIVE_STATUS.ARCHIVED && pendingSub);
    if (!retryable) {
        await replyEphemeral(interaction, `❌ 当前状态为 \`${record.status}\`，没有需要重试的归档任务。`);
        return;
    }

    const queued = getArchiveQueue(interaction.client).enqueue(channelId);
    await replyEphemeral(
        interaction,
        queued
            ? '✅ 已重新加入归档队列，将从断点继续。'
            : 'ℹ️ 该任务已在队列中或正在执行，请稍后使用 `/频道归档 状态` 查看进度。',
    );
}

async function handleReset(interaction) {
    const store = getStore();
    const config = store.getConfig(interaction.guild.id);
    const member = interaction.member;
    const allowed = isAdministrator(member, interaction.memberPermissions)
        || (config && (canParticipate(member, config, VOTE_TYPE.DELETE)
            || canParticipate(member, config, VOTE_TYPE.ARCHIVE)));
    if (!allowed) {
        await replyEphemeral(interaction, '❌ 只有管理组、赛事组或管理员可以取消归档状态。');
        return;
    }

    const channel = interaction.channel;
    if (!channel || channel.isThread?.()) {
        await replyEphemeral(interaction, '❌ 请在原文字频道中执行该命令（不要在子区内执行）。');
        return;
    }

    const record = store.getArchive(channel.id);
    if (!record) {
        await replyEphemeral(interaction, '❌ 该频道当前没有归档记录，无需取消。');
        return;
    }
    if (record.status === ARCHIVE_STATUS.DELETED) {
        await replyEphemeral(interaction, '❌ 该频道的归档记录已标记为删除，无法取消。');
        return;
    }
    if (store.getActiveVoteByChannel(channel.id)) {
        await replyEphemeral(interaction, '❌ 该频道还有进行中的投票，请等待投票结束或过期后再试。');
        return;
    }
    if (getArchiveQueue(interaction.client).isBusy(channel.id)) {
        await replyEphemeral(interaction, '❌ 该频道的归档任务正在执行或排队中，请等待结束后再试。');
        return;
    }

    const subCount = store.listSubthreads(channel.id)
        .filter(row => row.target_thread_id).length;
    const oldThreadId = record.target_thread_id;
    store.deleteArchive(channel.id);

    try {
        fs.rmSync(path.join(TEMP_ROOT, channel.id), { recursive: true, force: true });
    } catch (error) {
        console.warn('[ChannelArchive] 清理归档临时目录失败:', error.message);
    }

    console.log(`[ChannelArchive] 已取消归档状态：${channel.name}（${channel.id}）`);
    await replyEphemeral(interaction, [
        `✅ 已取消 **${channel.name}** 的归档状态，现在可以重新执行 \`/频道归档 发起\`。`,
        '',
        `- 旧主备份帖：${threadLink(interaction.guild.id, oldThreadId)}（保留，未删除）`,
        `- 旧子区备份帖：${subCount} 个（保留，未删除）`,
        '',
        '重新归档会创建新的备份帖，旧帖不受影响。',
    ].join('\n'));
}

async function handleBulkArchive(interaction) {
    const store = getStore();
    const config = store.getConfig(interaction.guild.id);
    const allowed = isAdministrator(interaction.member, interaction.memberPermissions)
        || (config && canParticipate(interaction.member, config, VOTE_TYPE.DELETE));
    if (!allowed) {
        await replyEphemeral(interaction, '❌ 只有管理组或管理员可以使用批量归档。');
        return;
    }
    if (!config) {
        await replyEphemeral(interaction, '❌ 本服务器尚未配置归档系统，请管理员先使用 `/归档配置 设置`。');
        return;
    }

    const raw = interaction.options.getString('频道id', true);
    // 支持直接粘贴 ID、频道链接或 <#频道> 形式，按出现顺序去重。
    const ids = [...new Set(raw.match(/\d{15,21}/g) || [])];
    if (!ids.length) {
        await replyEphemeral(interaction, '❌ 未识别到有效的频道 ID。');
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const queue = getArchiveQueue(interaction.client);
    const queued = [];
    const skipped = [];

    for (const id of ids) {
        const channel = interaction.guild.channels.cache.get(id)
            || await interaction.guild.channels.fetch(id).catch(() => null);
        if (!channel) {
            skipped.push(`${id}：未找到该频道`);
            continue;
        }
        if (channel.type !== ChannelType.GuildText) {
            skipped.push(`${channel.name}：不是文字频道`);
            continue;
        }

        const record = store.getArchive(channel.id);
        if (store.getActiveVoteByChannel(channel.id)) {
            skipped.push(`${channel.name}：投票进行中`);
            continue;
        }
        if (record?.status === ARCHIVE_STATUS.ARCHIVED) {
            skipped.push(`${channel.name}：已归档（如需重归档请先取消归档）`);
            continue;
        }
        if (queue.isBusy(channel.id)) {
            skipped.push(`${channel.name}：归档进行中`);
            continue;
        }
        if (record?.status === ARCHIVE_STATUS.ARCHIVING) {
            // 上次失败/中断但未在队列中的任务，直接断点续跑
            const retried = queue.enqueue(channel.id);
            queued.push(`${channel.name}${retried ? '（断点续跑）' : '（已在队列）'}`);
            continue;
        }

        // 清理旧记录（含过期投票残留），确保从干净状态重新归档
        if (record) store.deleteArchive(channel.id);

        store.upsertPendingArchive({
            channelId: channel.id,
            guildId: interaction.guild.id,
            channelName: channel.name,
        });
        store.markArchiveStarted(channel.id, config.target_forum_id);
        store.addAudit({
            guildId: interaction.guild.id,
            actionType: AUDIT_ACTION.ARCHIVE_START,
            channelId: channel.id,
            channelName: channel.name,
            initiatorId: interaction.user.id,
            votersSnapshot: [],
            targetThreadId: null,
        });
        const enqueued = queue.enqueue(channel.id);
        queued.push(`${channel.name}${enqueued ? '' : '（已在队列）'}`);
    }

    const lines = [
        '📦 **批量归档**',
        `已加入队列 **${queued.length}** 个频道，跳过 **${skipped.length}** 个。`,
    ];
    if (queued.length) {
        lines.push('', '**已加入队列：**', ...queued.slice(0, 20).map(name => `- ${name}`));
        if (queued.length > 20) lines.push(`- 其余 ${queued.length - 20} 个`);
    }
    if (skipped.length) {
        lines.push('', '**已跳过：**', ...skipped.slice(0, 20).map(name => `- ${name}`));
        if (skipped.length > 20) lines.push(`- 其余 ${skipped.length - 20} 个`);
    }
    lines.push('', '任务会按队列逐个执行，可用 `/频道归档 状态` 查看进度。');

    console.log(`[ChannelArchive] 批量归档：入队 ${queued.length}，跳过 ${skipped.length}`);
    await replyEphemeral(interaction, lines.join('\n'));
}

async function execute(interaction) {
    try {
        if (!interaction.guild) {
            await replyEphemeral(interaction, '❌ 该命令只能在服务器中使用。');
            return;
        }

        const subcommand = interaction.options.getSubcommand();
        switch (subcommand) {
            case '发起':
                await startVote(interaction, VOTE_TYPE.ARCHIVE);
                return;
            case '删除':
                await startVote(interaction, VOTE_TYPE.DELETE);
                return;
            case '状态':
                await handleStatus(interaction);
                return;
            case '重试':
                await handleRetry(interaction);
                return;
            case '取消归档':
                await handleReset(interaction);
                return;
            case '批量归档':
                await handleBulkArchive(interaction);
                return;
            default:
                await replyEphemeral(interaction, '❌ 未知子命令。');
        }
    } catch (error) {
        console.error('[ChannelArchive] 频道归档命令失败:', error);
        await replyEphemeral(interaction, `❌ 执行失败：${error.message}`);
    }
}

module.exports = {
    data,
    execute,
};
