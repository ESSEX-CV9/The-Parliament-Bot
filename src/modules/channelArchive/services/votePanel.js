// src/modules/channelArchive/services/votePanel.js
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const {
    VOTE_ACTION,
    VOTE_STATUS,
    VOTE_THRESHOLD,
    VOTE_TYPE,
    VOTE_ACTION_LABEL,
    voteCustomId,
} = require('../utils/constants');

const TYPE_TITLE = {
    [VOTE_TYPE.ARCHIVE]: '🗳️ 频道归档投票',
    [VOTE_TYPE.DELETE]: '🗳️ 归档频道删除投票',
};

const TYPE_DESCRIPTION = {
    [VOTE_TYPE.ARCHIVE]: '同意后 Bot 会把本频道历史还原到目标论坛，并生成文本备份。',
    [VOTE_TYPE.DELETE]: '同意后 Bot 会删除本频道。删除不可恢复，且删除前会核验论坛备份帖仍然存在。',
};

function statusColor(status) {
    switch (status) {
        case VOTE_STATUS.PASSED: return 0x57f287;
        case VOTE_STATUS.VETOED: return 0xed4245;
        case VOTE_STATUS.EXPIRED: return 0x99aab5;
        default: return 0x5865f2;
    }
}

function statusLabel(status) {
    switch (status) {
        case VOTE_STATUS.PASSED: return '✅ 已通过';
        case VOTE_STATUS.VETOED: return '❌ 已否决';
        case VOTE_STATUS.EXPIRED: return '⌛ 已过期';
        default: return '🟢 进行中';
    }
}

function formatApprovers(vote, limit = 20) {
    if (!vote.approvedUsers.length) return '暂无';
    const mentions = vote.approvedUsers.slice(0, limit).map(id => `<@${id}>`);
    const suffix = vote.approvedUsers.length > limit ? ` 等 ${vote.approvedUsers.length} 人` : '';
    return mentions.join('、') + suffix;
}

function thresholdFor(vote) {
    return VOTE_THRESHOLD[vote.vote_type] || 3;
}

function buildPublicPanel(vote, channelName) {
    const threshold = thresholdFor(vote);
    const count = vote.approvedUsers.length;
    const embed = new EmbedBuilder()
        .setTitle(TYPE_TITLE[vote.vote_type] || '🗳️ 投票')
        .setColor(statusColor(vote.status))
        .setDescription([
            `**频道：** <#${vote.channel_id}>${channelName ? `（${channelName}）` : ''}`,
            `**发起人：** <@${vote.initiator_id}>`,
            `**规则：** 赛事组/管理组按配置身份组投票；发起人自动计入第 1 票；一票否决即时生效。`,
            TYPE_DESCRIPTION[vote.vote_type] || '',
        ].join('\n'))
        .addFields(
            {
                name: `当前同意 (${count}/${threshold})`,
                value: formatApprovers(vote),
            },
            {
                name: '状态',
                value: `${statusLabel(vote.status)}\n结束时间：<t:${Math.floor(vote.expires_at / 1000)}:R>`,
            },
        )
        .setFooter({ text: `投票ID：${vote.vote_id}` })
        .setTimestamp(new Date());

    const components = [];
    if (vote.status === VOTE_STATUS.ACTIVE) {
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(voteCustomId(VOTE_ACTION.JOIN, vote.vote_id))
                .setLabel('参与投票')
                .setEmoji('🗳️')
                .setStyle(ButtonStyle.Primary),
        ));
    }
    return { embeds: [embed], components };
}

function buildPersonalPanel(vote, userId, { confirmMode = false } = {}) {
    const threshold = thresholdFor(vote);
    const count = vote.approvedUsers.length;
    const approved = vote.approvedUsers.includes(userId);
    const active = vote.status === VOTE_STATUS.ACTIVE;

    const description = active
        ? [
            `**频道：** <#${vote.channel_id}>`,
            `**投票类型：** ${VOTE_ACTION_LABEL[vote.vote_type] || vote.vote_type}`,
            `**当前同意：** ${count}/${threshold}`,
            `**你的状态：** ${approved ? '✅ 已同意' : '未同意'}`,
            `**结束时间：** <t:${Math.floor(vote.expires_at / 1000)}:R>`,
            '',
            '同意达到门槛后立即通过；任何人点击「反对」并二次确认后立即否决。',
        ].join('\n')
        : [
            `**频道：** <#${vote.channel_id}>`,
            `**结果：** ${statusLabel(vote.status)}`,
            `**最终同意：** ${count}/${threshold}`,
            `**你的状态：** ${approved ? '✅ 曾同意' : '未同意'}`,
        ].join('\n');

    const embed = new EmbedBuilder()
        .setTitle(TYPE_TITLE[vote.vote_type] || '🗳️ 投票')
        .setColor(statusColor(vote.status))
        .setDescription(description)
        .setFooter({ text: `投票ID：${vote.vote_id}` });

    const components = [];
    if (active) {
        if (confirmMode) {
            components.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(voteCustomId(VOTE_ACTION.CONFIRM, vote.vote_id))
                    .setLabel('确认反对（立即否决）')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(voteCustomId(VOTE_ACTION.JOIN, vote.vote_id))
                    .setLabel('取消')
                    .setStyle(ButtonStyle.Secondary),
            ));
        } else {
            components.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(voteCustomId(VOTE_ACTION.AGREE, vote.vote_id))
                    .setLabel('同意')
                    .setEmoji('✅')
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(approved),
                new ButtonBuilder()
                    .setCustomId(voteCustomId(VOTE_ACTION.WITHDRAW, vote.vote_id))
                    .setLabel('撤回')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(!approved),
                new ButtonBuilder()
                    .setCustomId(voteCustomId(VOTE_ACTION.OPPOSE, vote.vote_id))
                    .setLabel('反对')
                    .setEmoji('⛔')
                    .setStyle(ButtonStyle.Danger),
            ));
        }
    }

    return { embeds: [embed], components };
}

module.exports = {
    buildPublicPanel,
    buildPersonalPanel,
    thresholdFor,
    statusLabel,
    statusColor,
};
