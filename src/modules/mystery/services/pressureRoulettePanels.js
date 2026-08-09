const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
} = require('discord.js');

const GAME_NAME = '🔫 加压俄罗斯轮盘';

// 弹巢显示：空 = 已开过且是空枪；砰 = 已开过且中弹；? = 未知；[?] = 当前对准的弹巢。
const CHAMBER_SYMBOLS = Object.freeze({
    spent: '空',
    hit: '砰',
    unknown: '?',
    next: '[?]',
});

// 每个阶段一个颜色，扫一眼就知道现在打到哪一步。
const COLORS = Object.freeze({
    recruiting: 0x5865F2, // 蓝紫 — 招募中
    turn: 0xE67E22,       // 橙 — 轮到某人行动
    miss: 0x2ECC71,       // 绿 — 空枪
    hit: 0xE74C3C,        // 红 — 中弹
    pass: 0x7F8C8D,       // 灰 — 传枪
    again: 0x9B59B6,      // 紫 — 再开一枪
    load: 0xD35400,       // 红橙 — 加压
    coward: 0xF39C12,     // 黄 — 胆小鬼
    champion: 0xF1C40F,   // 金 — 冠军
    draw: 0x95A5A6,       // 灰蓝 — 平局
    over: 0x4F545C,       // 深灰 — 取消 / 中止
});

const NO_MENTIONS = Object.freeze({ parse: [] });

const MISS_LINES = [
    name => `咔。\n${name} 还活着，他自己也挺意外。`,
    name => `空的。\n${name} 决定假装刚才很淡定。`,
    name => `没响。\n枪：下次一定。`,
    name => `咔。\n这声音好听得 ${name} 想再听一次。（他真的可以）`,
    name => `${name} 没事。\n目前。`,
    name => `什么都没发生。\n${name} 开始怀疑这把枪是不是坏了。`,
    name => `咔。\n${name} 面无表情地放下枪，然后偷偷擦了擦手。`,
    name => `${name} 的走马灯播到一半被迫暂停。`,
    name => `${name} 活下来了。\n全场松了一口气，除了那几个盼着他倒下的。`,
    name => `没中。\n${name} 的手抖得比枪还厉害。`,
    name => `咔。\n概率这次站在 ${name} 那边，虽然它随时可以叛变。`,
    name => `空的。\n${name}：我就知道。\n他的腿：你不知道。`,
];

const HIT_LINES = [
    (name, minutes) => `${name} 获得 **${minutes} 分钟**免打扰服务。`,
    (name, minutes) => `${name} 找到那颗子弹了。\n找得非常彻底。`,
    (name, minutes) => `${name} 的麦克风被强制回收 **${minutes} 分钟**。`,
    (name, minutes) => `${name}：等一下我还没准备好——\n枪：好了。`,
    (name, minutes) => `${name} 退出了本局，以及接下来 **${minutes} 分钟**的所有对话。`,
    (name, minutes) => `${name} 倒下了。\n遗言是「啊？」。`,
    (name, minutes) => `这一枪很准。\n主要是因为只有一个方向。`,
    (name, minutes) => `${name} 已被消音 **${minutes} 分钟**。\n原因：手气。`,
    (name, minutes) => `现场没有医生，只有一群在笑的人。\n${name} 安静 **${minutes} 分钟**。`,
    (name, minutes) => `${name} 用 **${minutes} 分钟**的安静，换来了大家 **${minutes} 分钟**的快乐。`,
    (name, minutes) => `${name} 光荣负伤。\n伤情：说不了话。恢复期 **${minutes} 分钟**。`,
];

const PASS_LINES = [
    name => `${name} 把枪推给了下一个人。`,
    name => `${name} 一秒都没多拿，直接转手。`,
    name => `${name} 选择了传统美德：击鼓传花。`,
    name => `${name} 把烫手的东西交了出去，动作很熟练。`,
];

const AGAIN_LINES = [
    name => `${name} 又给自己来了一枪。`,
    name => `${name} 觉得刚才那下不够刺激。`,
    name => `${name} 把枪口留给了自己。\n勇，但没必要。`,
    name => `${name} 表示还没过瘾。`,
];

const LOAD_LINES = [
    name => `${name} 往枪里又塞了一发。`,
    name => `${name} 觉得这局太温柔了。`,
    name => `${name} 决定加点料。`,
    name => `${name} 上膛的时候在笑。\n那笑容值得所有人警惕。`,
];

function pick(templates, ...args) {
    return templates[Math.floor(Math.random() * templates.length)](...args);
}

// 测试用的虚拟玩家没有真实 Discord 账号，<@id> 渲染不出来，
// 所以统一走 labels 查表，查不到才退回真实提及。
function nameOf(view, userId) {
    return view?.labels?.[userId] || `<@${userId}>`;
}

function signature(view) {
    return view?.testMode ? `${GAME_NAME} · 🧪 测试模式` : GAME_NAME;
}

// 所有游戏消息统一走这里：顶端一行加粗游戏名，标题走大字，左侧色条标阶段。
// 注意：Discord 只在 description / field.value 里解析 mention 和 markdown，
// title、author.name、footer.text 一律按纯文本渲染。所以 <@id>、**加粗**
// 只能放进 description，标题里放会原样露出来。
function baseEmbed(view, { title, description, color }) {
    const embed = new EmbedBuilder().setAuthor({ name: signature(view) });
    if (title) embed.setTitle(title);
    if (description) embed.setDescription(description);
    if (color !== undefined) embed.setColor(color);
    return embed;
}

function message(embed, components = []) {
    return { embeds: [embed], components, allowedMentions: NO_MENTIONS };
}

function formatChambers(chamberView) {
    return (chamberView || [])
        .map(state => CHAMBER_SYMBOLS[state] || CHAMBER_SYMBOLS.unknown)
        .join(' ');
}

function formatPercent(chance) {
    if (!Number.isFinite(chance) || chance < 0) return '—';
    return `${Math.round(chance * 100)}%`;
}

function formatOdds(bullets, unknownCount) {
    if (!Number.isFinite(unknownCount) || unknownCount <= 0) return '—';
    return `${bullets} / ${unknownCount}`;
}

function odds(view) {
    return `**${formatOdds(view.bullets, view.unknownCount)} ≈ ${formatPercent(view.hitChance)}**`;
}

function mentionList(view, userIds) {
    if (!userIds || userIds.length === 0) return '—';
    return userIds.map(userId => nameOf(view, userId)).join('、');
}

function eliminatedBlock(view) {
    const lines = [];
    for (const entry of view.eliminated || []) {
        let suffix = '';
        if (entry.virtual) suffix = '（测试玩家，不禁言）';
        else if (entry.timeoutFailed) suffix = '（禁言未生效）';
        lines.push(`- ${nameOf(view, entry.userId)}　💥 中弹 · 💀  ${entry.minutes} 分钟${suffix}`);
    }
    for (const entry of view.cowards || []) {
        lines.push(`- ${nameOf(view, entry.userId)}　🤡 胆小鬼，中途退出`);
    }
    if (lines.length === 0) return null;
    return ['**已出局**', ...lines].join('\n');
}

function gunLine(view) {
    return `弹巢 ${formatChambers(view.chambers)}　│　枪内 **${view.bullets} 发**　│　赌注 **💤 ${view.stakeMinutes} 分钟**`;
}

function rosterLines(view) {
    const lines = ['', `**存活**　${mentionList(view, view.aliveIds)}`];
    const block = eliminatedBlock(view);
    if (block) lines.push('', block);
    return lines;
}

function joinRow(gameId, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`mystery_pressure_join:${gameId}`)
            .setLabel('🔫 参加')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled)
    );
}

function fireRow(gameId, turnToken) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`mystery_pressure_fire:${gameId}:${turnToken}`)
            .setLabel('🔫 开枪')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`mystery_pressure_quit:${gameId}:${turnToken}`)
            .setLabel('🤡 胆小鬼')
            .setStyle(ButtonStyle.Secondary)
    );
}

function choiceRow(gameId, turnToken, canLoad) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`mystery_pressure_pass:${gameId}:${turnToken}`)
            .setLabel('🔫 传枪')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`mystery_pressure_again:${gameId}:${turnToken}`)
            .setLabel('🔁 再开一枪')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`mystery_pressure_load:${gameId}:${turnToken}`)
            .setLabel('💥 加压')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(!canLoad)
    );
}

// ---------- 需要操作的面板 ----------

function recruitmentPanel(view) {
    const description = [
        `${nameOf(view, view.initiatorId)} 掏出了一把左轮，并且已经报名。`,
        '现在他需要几个愿意陪他一起后悔的人。',
        ...(view.testMode
            ? ['', `🧪 已加入 **${view.botCount}** 个测试机器人，它们不怕死，也不会真的被禁言。`]
            : []),
        '',
        '**规则**',
        '- 6 个弹巢，开局 **1 发**子弹，位置随机',
        '- 轮到你，自己点按钮扣扳机。中弹就出局，然后闭嘴',
        '- 活下来后三选一：',
        '　🔫 **传枪** — 弹巢前进一格，交给下一个人',
        '　🔁 **再开一枪** — 继续对自己开',
        `　💥 **加压** — 加一发子弹并滚动弹巢，赌注 +${view.minutesPerPressure} 分钟`,
        '- 轮到你的时候可以按 **🤡 胆小鬼** 退出',
        '　不禁言，但名字会被挂上 **🤡胆小鬼**，直到游戏结束后 5 分钟',
        '　你改回去，我就改回来。**我不累。**',
        '- **枪里子弹打光 = 游戏立刻结束**',
        '　只剩 1 人 → 他是**冠军**，零禁言',
        '　还剩多人 → **平局**，谁也没赢',
        `- 基础赌注 **${view.baseMinutes} 分钟**，每加压一次 **+${view.minutesPerPressure} 分钟**`,
        '',
        '不加压的话，最多只会倒一个人，也就没有冠军。',
        '**想赢，得自己往枪里塞子弹。**',
        '',
        `**当前人数：${view.participantCount} / ${view.maxParticipants}**`,
        `⏳ **预计开始：<t:${view.startsAtSeconds}:R>**`,
    ].join('\n');

    return message(
        baseEmbed(view, {
            title: '🔫 有人开了一局，缺几个不怕死的',
            description,
            color: COLORS.recruiting,
        }),
        [joinRow(view.gameId, view.disabled === true)]
    );
}

function firePanel(view) {
    const tail = view.autoPlay
        ? '🤖 **它正在思考人生……**'
        : `⏳ ${Math.round(view.turnTimeoutMs / 1000)} 秒内不动手，枪会自己响。`;

    const description = [
        `**轮到 ${view.shooterName} 了。**`,
        '',
        gunLine(view),
        '',
        `**中弹概率　${formatOdds(view.bullets, view.unknownCount)}　≈ ${formatPercent(view.hitChance)}**`,
        '',
        tail,
        ...rosterLines(view),
    ].join('\n');

    return message(
        baseEmbed(view, {
            title: `🔫 第 ${view.shotNumber} 枪`,
            description,
            color: COLORS.turn,
        }),
        view.autoPlay ? [] : [fireRow(view.gameId, view.turnToken)]
    );
}

function choicePanel(view) {
    const sameOdds = `${formatOdds(view.bullets, view.passUnknownCount)} ≈ ${formatPercent(view.passChance)}`;
    const loadLine = view.canLoad
        ? `💥 **加压** — 加一发弹并滚动弹巢，下一个人面对 ${formatOdds(view.bullets + 1, view.chamberCount)} ≈ ${formatPercent(view.loadChance)}，赌注升到 **💤 ${view.loadStakeMinutes} 分钟**`
        : `💥 **加压** — 枪里已经塞满 ${view.chamberCount} 发，再塞就该炸膛了`;
    const tail = view.autoPlay
        ? '🤖 **它正在思考人生……**'
        : `⏳ ${Math.round(view.turnTimeoutMs / 1000)} 秒不选，默认传枪。`;

    const description = [
        `**${view.shooterName} 要怎么处理这把枪？**`,
        '',
        gunLine(view),
        '',
        `🔫 **传枪** — 下一个人面对 ${sameOdds}`,
        `🔁 **再开一枪** — 同样是 ${sameOdds}，但枪口对着**自己**。`,
        loadLine,
        '',
        tail,
    ].join('\n');

    return message(
        baseEmbed(view, {
            title: '🎯 活下来了，接下来呢？',
            description,
            color: COLORS.turn,
        }),
        view.autoPlay ? [] : [choiceRow(view.gameId, view.turnToken, view.canLoad)]
    );
}

// ---------- 播报：告诉全场刚刚发生了什么 ----------

function missAnnouncement(view) {
    return message(baseEmbed(view, {
        title: '😮‍💨 空枪',
        description: [pick(MISS_LINES, view.shooterName), '', gunLine(view)].join('\n'),
        color: COLORS.miss,
    }));
}

function hitAnnouncement(view) {
    const lines = [pick(HIT_LINES, view.victimName, view.victimMinutes)];
    if (view.victimVirtual) {
        lines.push('', '🤖 *测试机器人不会真的被禁言。*');
    } else if (view.timeoutFailed) {
        lines.push('', '🛡️ *禁言被挡了下来，他居然还能继续说话。*');
    }
    lines.push('', gunLine(view), ...rosterLines(view));

    return message(baseEmbed(view, {
        title: '💥 砰！',
        description: lines.join('\n'),
        color: COLORS.hit,
    }));
}

const ACTION_STYLES = Object.freeze({
    pass: {
        title: '🔫 传枪',
        lines: PASS_LINES,
        color: COLORS.pass,
        detail: view => `弹巢前进一格。下一个是 ${view.nextShooterName}，他面对 ${odds(view)}。`,
    },
    again: {
        title: '🔁 再开一枪',
        lines: AGAIN_LINES,
        color: COLORS.again,
        detail: view => `枪还在他自己手里，这一枪 ${odds(view)}。`,
    },
    load: {
        title: '💥 加压',
        lines: LOAD_LINES,
        color: COLORS.load,
        detail: view => [
            `枪里现在有 **${view.bullets} 发**子弹，弹巢重新滚动，之前记住的空巢全部作废。`,
            `赌注涨到 **💤 ${view.stakeMinutes} 分钟**。下一个是 ${view.nextShooterName}，他面对 ${odds(view)}。`,
        ].join('\n'),
    },
});

function actionAnnouncement(view) {
    const style = ACTION_STYLES[view.action];
    if (!style) return null;

    return message(baseEmbed(view, {
        title: style.title,
        description: [pick(style.lines, view.actorName), '', style.detail(view)].join('\n'),
        color: style.color,
    }));
}

function cowardAnnouncement(view) {
    const lines = [view.taunt];
    if (view.nicknameApplied) {
        lines.push('', '他的名字已经被挂上 **🤡胆小鬼**，直到游戏结束后 5 分钟。');
    }
    lines.push('', gunLine(view), ...rosterLines(view));

    return message(baseEmbed(view, {
        title: '🤡 有人退出了',
        description: lines.join('\n'),
        color: COLORS.coward,
    }));
}

// 改名对抗的播报。可能发生在游戏结束之后，所以单独提供。
function cowardRenameMessage(taunt) {
    return {
        embeds: [new EmbedBuilder()
            .setAuthor({ name: GAME_NAME })
            .setTitle('🤡 改名无效')
            .setDescription(taunt)
            .setColor(COLORS.coward)],
        allowedMentions: NO_MENTIONS,
    };
}

// ---------- 结算 ----------

function cancellationPanel(view, minParticipants) {
    const description = [
        `3 分钟过去了，报名人数没到 **${minParticipants} 个**，本局取消。`,
        '',
        '左轮被收了回去，一颗子弹都没送出去。',
        '',
        '*它看起来有点失落。*',
    ].join('\n');

    return message(baseEmbed(view, {
        title: '🕸️ 没人报名',
        description,
        color: COLORS.over,
    }));
}

function championPanel(view) {
    const lines = [
        `${nameOf(view, view.winnerId)} 是最后一个还站着的。`,
        '',
        `本局加压 **${view.pressure} 次**，赌注最高到过 **💤 ${view.stakeMinutes} 分钟**。`,
        '',
        '**奖品：你还能说话。**',
        '*……其实你本来也能。*',
    ];
    const block = eliminatedBlock(view);
    if (block) lines.push('', block);

    return message(baseEmbed(view, {
        title: view.bullets > 0 ? '🏆 人打光了' : '🏆 枪打空了',
        description: lines.join('\n'),
        color: COLORS.champion,
    }));
}

function drawPanel(view) {
    const lines = [
        `${view.aliveIds.length} 个人面面相觑，场面十分安静。`,
        '',
        '子弹用完了，本局结束，没有冠军。',
        '',
        `**存活**　${mentionList(view, view.aliveIds)}`,
    ];
    const block = eliminatedBlock(view);
    if (block) lines.push('', block);
    lines.push('', '*本局唯一的伤亡是气氛。*', '*想决出冠军，得有人往枪里加子弹。*');

    return message(baseEmbed(view, {
        title: '🕊️ 枪空了，人还挺齐',
        description: lines.join('\n'),
        color: COLORS.draw,
    }));
}

function abortPanel(view, reason) {
    const lines = [reason];
    const block = eliminatedBlock(view || {});
    if (block) lines.push('', block);

    return message(baseEmbed(view, {
        title: '🔫 本局中止',
        description: lines.join('\n'),
        color: COLORS.over,
    }));
}

module.exports = {
    GAME_NAME,
    COLORS,
    CHAMBER_SYMBOLS,
    MISS_LINES,
    HIT_LINES,
    baseEmbed,
    signature,
    nameOf,
    formatChambers,
    formatPercent,
    formatOdds,
    joinRow,
    fireRow,
    choiceRow,
    recruitmentPanel,
    firePanel,
    choicePanel,
    missAnnouncement,
    hitAnnouncement,
    actionAnnouncement,
    cowardAnnouncement,
    cowardRenameMessage,
    cancellationPanel,
    championPanel,
    drawPanel,
    abortPanel,
};
