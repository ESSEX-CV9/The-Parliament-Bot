// src/modules/channelArchive/services/voteService.js
const { randomUUID } = require('node:crypto');
const { MessageFlags } = require('discord.js');
const { getStore } = require('../store/instance');
const {
    ARCHIVE_STATUS,
    VOTE_DURATION_MS,
    VOTE_STATUS,
    VOTE_THRESHOLD,
    VOTE_TYPE,
} = require('../utils/constants');
const { buildPublicPanel, buildPersonalPanel } = require('./votePanel');
const { canParticipate, getRoleMention, validateBusinessChannel } = require('./permissionService');
const { getVoteHandlers } = require('./hooks');

async function replyEphemeral(interaction, content) {
    if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ content }).catch(() => {});
    } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
}

async function refreshPublicPanel(client, vote) {
    if (!vote?.message_id) return;
    try {
        const channel = await client.channels.fetch(vote.channel_id).catch(() => null);
        if (!channel) return;
        const message = await channel.messages.fetch(vote.message_id).catch(() => null);
        if (!message) return;
        const panel = buildPublicPanel(vote, channel.name);
        await message.edit(panel);
    } catch (error) {
        console.warn(`[ChannelArchive] 刷新投票面板失败 vote=${vote?.vote_id}:`, error.message);
    }
}

async function triggerPassed(vote) {
    try {
        if (vote.vote_type === VOTE_TYPE.ARCHIVE) {
            const handler = getVoteHandlers().onArchivePassed;
            if (handler) await handler(vote);
        } else if (vote.vote_type === VOTE_TYPE.DELETE) {
            const handler = getVoteHandlers().onDeletePassed;
            if (handler) await handler(vote);
        }
    } catch (error) {
        console.error(`[ChannelArchive] 投票通过后的动作执行失败 vote=${vote.vote_id}:`, error);
    }
}

async function startVote(interaction, voteType) {
    if (!interaction.guild) {
        await replyEphemeral(interaction, '❌ 该命令只能在服务器中使用。');
        return;
    }

    const store = getStore();
    const config = store.getConfig(interaction.guild.id);
    const channel = interaction.channel;
    const channelError = validateBusinessChannel(channel, config);
    if (channelError) {
        await replyEphemeral(interaction, channelError);
        return;
    }

    if (!canParticipate(interaction.member, config, voteType)) {
        await replyEphemeral(
            interaction,
            `❌ 你没有发起该投票所需的身份组：${getRoleMention(
                voteType === VOTE_TYPE.DELETE ? config.mod_role_id : config.event_role_id,
            )}`,
        );
        return;
    }

    const record = store.getArchive(channel.id);

    if (voteType === VOTE_TYPE.ARCHIVE) {
        if (record && [ARCHIVE_STATUS.ARCHIVING, ARCHIVE_STATUS.ARCHIVED, ARCHIVE_STATUS.DELETED].includes(record.status)) {
            await replyEphemeral(interaction, '❌ 该频道已经归档或正在归档，不能重复发起归档投票。');
            return;
        }
    } else {
        if (!record || record.status !== ARCHIVE_STATUS.ARCHIVED) {
            await replyEphemeral(interaction, '❌ 该频道尚未完成归档，不能发起删除投票。');
            return;
        }
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    store.expireOverdueVotes();
    const latest = store.getLatestVoteByChannel(channel.id);
    if (latest && latest.status === VOTE_STATUS.EXPIRED) {
        await refreshPublicPanel(interaction.client, latest);
    }
    const active = store.getActiveVoteByChannel(channel.id);
    if (active) {
        await refreshPublicPanel(interaction.client, active);
        await interaction.editReply({ content: '❌ 该频道已有进行中的投票，请先等待结束或过期。' });
        return;
    }

    if (voteType === VOTE_TYPE.DELETE) {
        const mainThread = record.target_thread_id
            ? await interaction.client.channels.fetch(record.target_thread_id).catch(() => null)
            : null;
        if (!mainThread || !mainThread.isThread?.()) {
            await interaction.editReply({ content: '❌ 主备份帖已不存在，已阻止删除投票。请先重新归档。' });
            return;
        }
        if (record.target_forum_id && mainThread.parentId !== record.target_forum_id) {
            await interaction.editReply({ content: '❌ 主备份帖已不在目标论坛中，已阻止删除投票。' });
            return;
        }
    }

    const voteId = randomUUID();
    const expiresAt = Date.now() + VOTE_DURATION_MS;
    const draftVote = {
        vote_id: voteId,
        guild_id: interaction.guild.id,
        channel_id: channel.id,
        message_id: '',
        vote_type: voteType,
        initiator_id: interaction.user.id,
        approvedUsers: [interaction.user.id],
        status: VOTE_STATUS.ACTIVE,
        expires_at: expiresAt,
    };

    let message;
    try {
        const panel = buildPublicPanel(draftVote, channel.name);
        message = await channel.send({ ...panel, allowedMentions: { parse: [] } });
    } catch (error) {
        await interaction.editReply({ content: `❌ 发送投票面板失败：${error.message}` });
        return;
    }

    let vote;
    try {
        vote = store.createVote({
            voteId,
            guildId: interaction.guild.id,
            channelId: channel.id,
            messageId: message.id,
            voteType,
            initiatorId: interaction.user.id,
            approvedUsers: [interaction.user.id],
            expiresAt,
        });
    } catch (error) {
        await message.delete().catch(() => {});
        await interaction.editReply({ content: `❌ 创建投票失败：${error.message}` });
        return;
    }

    if (voteType === VOTE_TYPE.ARCHIVE) {
        store.upsertPendingArchive({
            channelId: channel.id,
            guildId: interaction.guild.id,
            channelName: channel.name,
        });
    }

    await interaction.editReply(buildPersonalPanel(vote, interaction.user.id));
}

async function expireIfNeeded(vote) {
    if (!vote || vote.status !== VOTE_STATUS.ACTIVE) return vote;
    if (vote.expires_at > Date.now()) return vote;
    const store = getStore();
    store.expireVote(vote.vote_id);
    return store.getVote(vote.vote_id);
}

function thresholdFor(vote) {
    return VOTE_THRESHOLD[vote.vote_type] || 3;
}

module.exports = {
    startVote,
    refreshPublicPanel,
    triggerPassed,
    expireIfNeeded,
    thresholdFor,
    replyEphemeral,
};
