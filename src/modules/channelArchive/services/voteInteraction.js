// src/modules/channelArchive/services/voteInteraction.js
const { MessageFlags } = require('discord.js');
const { getStore } = require('../store/instance');
const {
    AUDIT_ACTION,
    VOTE_ACTION,
    VOTE_STATUS,
    VOTE_TYPE,
    parseVoteCustomId,
} = require('../utils/constants');
const { buildPersonalPanel } = require('./votePanel');
const { canParticipate } = require('./permissionService');
const {
    expireIfNeeded,
    refreshPublicPanel,
    thresholdFor,
    triggerPassed,
} = require('./voteService');

function isEphemeralMessage(interaction) {
    return Boolean(interaction.message?.flags?.has?.(MessageFlags.Ephemeral));
}

async function handleVoteInteraction(interaction) {
    const parsed = parseVoteCustomId(interaction.customId);
    if (!parsed) return false;

    try {
        const store = getStore();
        let vote = store.getVote(parsed.voteId);
        if (!vote) {
            await interaction.reply({
                content: '❌ 该投票不存在或已被清理。',
                flags: MessageFlags.Ephemeral,
            }).catch(() => {});
            return true;
        }

        const config = store.getConfig(vote.guild_id);
        if (!config) {
            await interaction.reply({
                content: '❌ 本服务器尚未配置归档系统，请联系管理员。',
                flags: MessageFlags.Ephemeral,
            }).catch(() => {});
            return true;
        }

        vote = await expireIfNeeded(vote);

        if (vote.status !== VOTE_STATUS.ACTIVE) {
            if (parsed.action === VOTE_ACTION.JOIN && !isEphemeralMessage(interaction)) {
                await interaction.reply({
                    ...buildPersonalPanel(vote, interaction.user.id),
                    flags: MessageFlags.Ephemeral,
                }).catch(() => {});
            } else {
                await interaction.update(buildPersonalPanel(vote, interaction.user.id)).catch(() => {});
            }
            await refreshPublicPanel(interaction.client, vote);
            return true;
        }

        if (!canParticipate(interaction.member, config, vote.vote_type)) {
            await interaction.reply({
                content: '❌ 你没有参与该投票所需的身份组。',
                flags: MessageFlags.Ephemeral,
            }).catch(() => {});
            return true;
        }

        switch (parsed.action) {
            case VOTE_ACTION.JOIN: {
                const panel = buildPersonalPanel(vote, interaction.user.id);
                if (isEphemeralMessage(interaction)) {
                    await interaction.update(panel);
                } else {
                    await interaction.reply({ ...panel, flags: MessageFlags.Ephemeral });
                }
                return true;
            }
            case VOTE_ACTION.AGREE: {
                const { vote: updated, justPassed } = store.approveAndCheck(
                    vote.vote_id,
                    interaction.user.id,
                    thresholdFor(vote),
                );
                await interaction.update(buildPersonalPanel(updated, interaction.user.id));
                await refreshPublicPanel(interaction.client, updated);
                if (justPassed) void triggerPassed(updated);
                return true;
            }
            case VOTE_ACTION.WITHDRAW: {
                const updated = store.withdraw(vote.vote_id, interaction.user.id);
                await interaction.update(buildPersonalPanel(updated, interaction.user.id));
                await refreshPublicPanel(interaction.client, updated);
                return true;
            }
            case VOTE_ACTION.OPPOSE: {
                await interaction.update(buildPersonalPanel(vote, interaction.user.id, { confirmMode: true }));
                return true;
            }
            case VOTE_ACTION.CONFIRM: {
                const { changed, vote: updated } = store.veto(vote.vote_id);
                await interaction.update(buildPersonalPanel(updated, interaction.user.id));
                await refreshPublicPanel(interaction.client, updated);
                if (changed) {
                    store.addAudit({
                        guildId: vote.guild_id,
                        actionType: AUDIT_ACTION.VOTE_VETO,
                        channelId: vote.channel_id,
                        channelName: interaction.channel?.name || null,
                        initiatorId: vote.initiator_id,
                        votersSnapshot: vote.approvedUsers,
                        targetThreadId: null,
                    });
                    if (vote.vote_type === VOTE_TYPE.ARCHIVE) {
                        store.deletePendingArchive(vote.channel_id);
                    }
                }
                return true;
            }
            default:
                return false;
        }
    } catch (error) {
        console.error('[ChannelArchive] 处理投票交互失败:', error);
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ 处理投票时出现错误，请稍后重试。',
                    flags: MessageFlags.Ephemeral,
                });
            }
        } catch (_) {
            // ignore
        }
        return true;
    }
}

module.exports = {
    handleVoteInteraction,
};
