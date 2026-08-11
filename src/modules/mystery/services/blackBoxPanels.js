const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
} = require('discord.js');
const {
    MIN_PLAYERS,
    MAX_PLAYERS,
    INITIAL_CHIPS,
    MAX_CHIPS,
} = require('./blackBoxRules');

const GAME_NAME = '黑箱交易';
const NO_MENTIONS = Object.freeze({ parse: [] });

function baseEmbed(title, description, color = 0x2F3136) {
    return new EmbedBuilder()
        .setAuthor({ name: GAME_NAME })
        .setTitle(title)
        .setDescription(description)
        .setColor(color);
}

function customId(...parts) {
    return `mystery_blackbox:${parts.join(':')}`;
}

function joinRow(gameId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(customId('join', gameId))
            .setLabel('🖐️ 报名')
            .setStyle(ButtonStyle.Primary)
    );
}

function recruitmentPanel(view) {
    const lines = [
        '🕵️ **黑箱交易正在招募**',
        '',
        '**基础规则**',
        `- ${MIN_PLAYERS}–${MAX_PLAYERS} 人参加，每人初始 **${INITIAL_CHIPS} 个筹码**（最多 ${MAX_CHIPS} 个）`,
        '- 每轮会拿到一个只有自己看得见的安全箱或危险箱',
        '- 你可以公开声明“安全 / 危险”，可以撒谎，也可以保持沉默',
        '',
        '**行动与筹码**',
        '- 选择保留或交换箱子；对方单方面交换时，你可花 1 筹码锁住',
        '- **稳一手**：安全 ±0，危险 -2',
        '- **加码**：安全 +1，危险 -3',
        '- 筹码降到 0 即淘汰；第 1 / 2 / 后续批淘汰分别禁言 **3 / 4 / 5 分钟**',
        '',
        '**决赛**',
        '- 剩 2 人进入决赛；双方可花 1 筹码加码',
        '- 无人 / 一人 / 两人加码时，败者分别禁言 **5 / 8 / 10 分钟**',
        '',
        `**已报名：${view.count} / ${MAX_PLAYERS}**`,
        '',
        `满 **${MAX_PLAYERS} 人**立即开始；3 分钟到 **${MIN_PLAYERS} 人**则取消。`,
    ];
    return {
        embeds: [baseEmbed('🕵️ 黑箱交易', lines.join('\n'))],
        components: [joinRow(view.gameId)],
        allowedMentions: NO_MENTIONS,
    };
}

function declarationAnnouncement(view) {
    return {
        content: `📢 <@${view.userId}> 公开声明：**${view.choice === 'safe' ? '🛡️ 安全' : '💥 危险'}**`,
        allowedMentions: NO_MENTIONS,
    };
}

function phasePanel(view) {
    const lines = [
        `**第 ${view.roundNumber} 轮**`,
        '',
        `本轮有 **${view.dangerousCount}** 个危险箱。`,
        '',
        '点击下方按钮打开你的私人面板。',
    ];
    return {
        embeds: [baseEmbed(`📦 第 ${view.roundNumber} 轮`, lines.join('\n'))],
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(customId('panel', view.gameId, view.roundId, view.revision))
                    .setLabel('🔍 查看我的箱子')
                    .setStyle(ButtonStyle.Secondary)
            ),
        ],
        allowedMentions: NO_MENTIONS,
    };
}

function privateDeclarationPanel(view) {
    const lines = [
        `**你的箱子：${view.box === 'dangerous' ? '💥 危险' : '🛡️ 安全'}**`,
        '',
        '公开声明它是安全还是危险？可以撒谎，也可以保持沉默。',
    ];
    return {
        content: '📢 **公开声明**',
        embeds: [baseEmbed('📢 公开声明', lines.join('\n'))],
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(customId('declare', view.gameId, view.roundId, view.revision, 'safe'))
                    .setLabel('🛡️ 声明安全')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(customId('declare', view.gameId, view.roundId, view.revision, 'dangerous'))
                    .setLabel('💥 声明危险')
                    .setStyle(ButtonStyle.Danger)
            ),
        ],
    };
}

function privateActionPanel(view) {
    const lines = [
        '选择行动与押注方式。',
        '',
        view.bye
            ? '你是本轮轮空者：不能交换箱子，但可以押注。'
            : '对手可能是任意其他玩家；交换与否都保密。',
    ];
    const base = customId('action', view.gameId, view.roundId, view.revision);
    return {
        content: '🎬 **秘密行动**',
        embeds: [baseEmbed('🎬 秘密行动', lines.join('\n'))],
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`${base}:keep:stable`).setLabel('保留 · 稳一手').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`${base}:keep:wager`).setLabel('保留 · 加码').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`${base}:exchange:stable`).setLabel('交换 · 稳一手').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`${base}:exchange:wager`).setLabel('交换 · 加码').setStyle(ButtonStyle.Secondary)
            ),
        ],
    };
}

function counterPanel(view) {
    const lines = [
        `<@${view.keeperId}>，对方选择了交换。`,
        '',
        '你可以 **锁住**（不换，扣 1 筹码，需至少 2 筹码）或 **放行**（交换）。',
    ];
    const base = customId('counter', view.gameId, view.roundId, view.revision, view.exchangerId);
    return {
        content: '🔒 **交换裁定**',
        embeds: [baseEmbed('🔒 交换裁定', lines.join('\n'))],
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`${base}:lock`).setLabel('🔒 锁住（-1 筹码）').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`${base}:allow`).setLabel('✅ 放行').setStyle(ButtonStyle.Secondary)
            ),
        ],
    };
}

function revealPanel(view) {
    const lines = [
        '📦 **本轮结果**',
        '',
        ...view.rows,
        '',
        view.eliminated.length > 0
            ? `💀 **淘汰：${view.eliminated.map(id => `<@${id}>`).join('、')}**`
            : '无人被淘汰。',
    ];
    return {
        embeds: [baseEmbed('📦 本轮结果', lines.join('\n'), 0xE67E22)],
        allowedMentions: NO_MENTIONS,
    };
}

function finalWagerPanel(view) {
    const lines = [
        '👑 **决赛**',
        '',
        `<@${view.a}> 与 <@${view.b}> 进入最终对决。`,
        '',
        '是否 **加码 -1 筹码**？（没有筹码则只能不加码）',
        '',
        '双方选择同时揭晓，决定败者禁言时长。',
    ];
    const base = customId('finalwager', view.gameId, view.revision);
    return {
        content: '👑 **决赛押注**',
        embeds: [baseEmbed('👑 决赛押注', lines.join('\n'))],
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`${base}:none`).setLabel('不加码').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`${base}:wager`).setLabel('加码 -1 筹码').setStyle(ButtonStyle.Secondary)
            ),
        ],
    };
}

function finalResultPanel(view) {
    const lines = [
        `👑 **胜者：<@${view.winnerId}>**`,
        '',
        `<@${view.loserId}> 将被禁言 **${Math.round(view.timeoutMs / 60_000)} 分钟**。`,
    ];
    if (view.timeoutFailed) lines.push('', '🛡️ **但禁言被神秘力量阻挡，未能生效。**');
    return {
        embeds: [baseEmbed('👑 黑箱交易结束', lines.join('\n'), 0xE91E63)],
        allowedMentions: NO_MENTIONS,
    };
}

function championPanel(view) {
    return {
        embeds: [baseEmbed('🏆 黑箱交易结束', `**冠军：<@${view.winnerId}>**\n\n其他人已全部出局。`)],
        allowedMentions: NO_MENTIONS,
    };
}

function cancellationPanel(view) {
    return {
        embeds: [baseEmbed('❌ 黑箱交易取消', `报名人数不足 ${MIN_PLAYERS} 人，本局取消。`)],
        allowedMentions: NO_MENTIONS,
    };
}

function insufficientPlayersPanel(view) {
    return {
        embeds: [baseEmbed('💀 黑箱交易结束', '剩余人数不足，本局自动结束。')],
        allowedMentions: NO_MENTIONS,
    };
}

module.exports = {
    GAME_NAME,
    MIN_PLAYERS,
    MAX_PLAYERS,
    INITIAL_CHIPS,
    MAX_CHIPS,
    customId,
    recruitmentPanel,
    phasePanel,
    privateDeclarationPanel,
    declarationAnnouncement,
    privateActionPanel,
    counterPanel,
    revealPanel,
    finalWagerPanel,
    finalResultPanel,
    championPanel,
    cancellationPanel,
    insufficientPlayersPanel,
};
