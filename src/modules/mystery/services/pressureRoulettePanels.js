const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
} = require('discord.js');

const GAME_NAME = '🔫 加压俄罗斯轮盘';

// 弹巢显示：空 = 已开过且是空枪；砰 = 已开过且中弹；哑 = 已开过且是哑弹；
// ? = 未知；[?] = 当前对准的弹巢。
const CHAMBER_SYMBOLS = Object.freeze({
    spent: '空',
    hit: '砰',
    dud: '哑',
    unknown: '?',
    next: '[?]',
});

// 每个阶段一个颜色，扫一眼就知道现在打到哪一步。
const COLORS = Object.freeze({
    recruiting: 0x5865F2, // 蓝紫 — 招募中
    turn: 0xE67E22,       // 橙 — 轮到某人行动
    miss: 0x2ECC71,       // 绿 — 空枪
    hit: 0xE74C3C,        // 红 — 中弹
    dud: 0x95A5A6,        // 灰 — 哑弹
    reload: 0x3498DB,     // 蓝 — 系统自动补弹
    wave: 0x8E44AD,       // 深紫 — 新的一轮
    vote: 0x16A085,       // 墨绿 — 和局判定
    pass: 0x7F8C8D,       // 灰 — 传枪
    again: 0x9B59B6,      // 紫 — 再开一枪
    load: 0xD35400,       // 红橙 — 加压
    unload: 0x1ABC9C,     // 青绿 — 抽弹
    riposte: 0xC0392B,    // 深红 — 反手
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
    name => `${name} 从箱子里摸了几发，塞进了枪里。`,
    name => `${name} 觉得这局太温柔了。`,
    name => `${name} 决定加点料。`,
    name => `${name} 上膛的时候在笑。\n那笑容值得所有人警惕。`,
];

// 哑弹：击针砸下去了，子弹没响。这一发废了，但它谁也带不走。
const DUD_LINES = [
    name => `咔。\n${name} 的走马灯刚播到片头曲。`,
    name => `一声闷响，然后什么都没有。\n${name} 手里这发是坏的。`,
    name => `${name} 中奖了 —— 只不过奖品是一发不会响的子弹。`,
    name => `子弹确实在那儿。\n只是它今天不想上班。`,
    name => `${name} 已经闭上眼了。\n然后又睁开了。`,
    name => `哑火。\n${name} 用一发子弹换了一条命，这买卖不亏。`,
    name => `${name} 摸到了这箱里的次品。\n全场都替他松了口气，除了那几个不太诚恳的。`,
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

// 戴罪上桌的人在名单里挂 🤡，全场才知道他跑过一次、而且这局跑不掉。
function rosterName(view, userId) {
    const name = nameOf(view, userId);
    return (view?.redeemerIds || []).includes(userId) ? `🤡${name}` : name;
}

function mentionList(view, userIds) {
    if (!userIds || userIds.length === 0) return '—';
    return userIds.map(userId => rosterName(view, userId)).join('、');
}

function eliminatedBlock(view) {
    const lines = [];
    for (const entry of view.eliminated || []) {
        let suffix = '';
        if (entry.virtual) suffix = '（测试玩家，不禁言）';
        else if (entry.timeoutFailed) suffix = '（禁言未生效）';
        lines.push(`- ${rosterName(view, entry.userId)}　💥 中弹 · 💀  ${entry.minutes} 分钟${suffix}`);
    }
    for (const entry of view.cowards || []) {
        const suffix = entry.penaltyMinutes ? ` · 🤡 ${entry.penaltyMinutes} 分钟` : '';
        lines.push(`- ${nameOf(view, entry.userId)}　🤡 胆小鬼，中途退出${suffix}`);
    }
    if (lines.length === 0) return null;
    return ['**已出局**', ...lines].join('\n');
}

// 枪的当前状态 + 一行待发池小字。
// 池子公开的只有「还剩几发」和「本轮一共几发哑弹」—— 已经打出去几发不给数，
// 玩家自己记。每一发哑弹都有公开播报，想推构成往上翻频道就是了。
function gunLine(view) {
    const gun = `弹巢 ${formatChambers(view.chambers)}　│　枪内 **${view.bullets} 发**`
        + `　│　赌注 **💤 ${view.stakeMinutes} 分钟**`;
    const pool = `-# 待发 ${view.poolRemaining || 0} 发　│　本轮哑弹 ${view.poolDudTotal || 0} 发`;
    return `${gun}\n${pool}`;
}

// 蓄力是这局最容易被忽略的信息，攒着的时候每张面板都提一句。
function chargeLine(view) {
    if (!view.charge) return null;
    return `🔁 **连开蓄力 ×${view.charge}**　│　下次加压能塞 **${view.charge + 1} 发**`;
}

function rosterLines(view) {
    // 名单已经按行动顺序排好，标题里点明一句，免得看的人以为是随机排的。
    const lines = ['', `**存活（按行动顺序）**　${mentionList(view, view.aliveIds)}`];
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

// canQuit 为 false 时整个逃生按钮不渲染，而不是置灰：戴罪上桌的人
// 不该看到一个自己永远点不了的出口。
// canUnload 为 true 时中间插一个「🔧 抽弹开枪」。
function fireRow(gameId, turnToken, { canQuit = true, canUnload = false } = {}) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`mystery_pressure_fire:${gameId}:${turnToken}`)
            .setLabel('🔫 开枪')
            .setStyle(ButtonStyle.Danger)
    );
    if (canUnload) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_pressure_unload:${gameId}:${turnToken}`)
                .setLabel('🔧 抽弹开枪')
                .setStyle(ButtonStyle.Success)
        );
    }
    if (canQuit) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_pressure_quit:${gameId}:${turnToken}`)
                .setLabel('🤡 胆小鬼')
                .setStyle(ButtonStyle.Secondary)
        );
    }
    return row;
}

function choiceRow(gameId, turnToken, canLoad, canRiposte = false) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`mystery_pressure_pass:${gameId}:${turnToken}`)
            .setLabel('🔫 传枪')
            .setStyle(ButtonStyle.Secondary)
    );
    // 反手是「传枪」的替代品：不往下传，往回扔。只在持有反手权时出现。
    if (canRiposte) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_pressure_riposte:${gameId}:${turnToken}`)
                .setLabel('🔙 反手还击')
                .setStyle(ButtonStyle.Danger)
        );
    }
    row.addComponents(
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
    return row;
}

// 和局判定：所有还活着的人都能点，不看枪在谁手里。
function voteRow(gameId, turnToken) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`mystery_pressure_agree:${gameId}:${turnToken}`)
            .setLabel('🤝 同意收场')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`mystery_pressure_object:${gameId}:${turnToken}`)
            .setLabel('🔫 再来一轮')
            .setStyle(ButtonStyle.Danger)
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
        `- 桌上一箱 **${view.poolSize} 发**待发子弹，其中 **${view.poolDudMin}~${view.poolDudMax} 发是哑弹**`,
        '　哑弹和实弹长得一模一样。**打响了才知道是哪种，谁也没法提前分辨**',
        '　哑弹被击发照样从枪里扣掉一发，只是它带不走人',
        '- 6 个弹巢，开局从箱子里抽 **1 发**装进去，位置随机',
        '- 轮到你，自己点按钮扣扳机。吃到实弹就出局，然后闭嘴',
        '- 活下来后三选一：',
        '　🔫 **传枪** — 弹巢前进一格，交给下一个人',
        '　🔁 **再开一枪** — 继续对自己开，每撑过一次攒 **1 层连开蓄力**',
        '　💥 **加压** — 从箱子里抓 **1 + 蓄力层数** 发塞进枪并滚动弹巢，'
            + `每发让赌注 +${view.minutesPerPressure} 分钟`,
        '　　**抓到的是实弹还是哑弹，加压的人自己也不知道**',
        '- **连开蓄力**只在连着对自己开枪时累积',
        '　一旦传枪 / 加压 / 中弹就清零，攒了就得当场兑现',
        '　连开三次再加压 = 一口气抓 4 发，但你得先自己撑过那三枪',
        '- 🔧 **抽弹开枪**（每人每局 **1 次**，什么时候都能用）：',
        '　从枪里随手抓一发扔掉、重转弹巢、立刻扣扳机',
        '　**扔掉的是实弹还是哑弹没人知道**，而且不回箱子',
        '　**赌注一分不降**；活下来直接传枪，这轮不能再开 / 加压 / 反手',
        '- 🔙 **反手还击**：有人加压后，接到高压枪的人拿到「反手权」',
        '　活过自己那一枪就能把枪**扔回给加压者**，逼他开一枪',
        '　然后枪回到你手上再补一枪。加压者压得越狠，越容易被拉下水',
        '- 轮到你的时候可以按 **🤡 胆小鬼** 退出',
        '　不禁言，但名字会被挂上 **🤡胆小鬼**，游戏结束后至少还要再挂 **5 分钟**',
        '　你退出那一刻的赌注比 5 分钟长的话，就按赌注算',
        '　你改回去，我就改回来。**我不累。**',
        '- 挂着 🤡 也能上桌，但是**戴罪**的：',
        '　这一局你**没有逃生按钮**，机会你已经用掉一次了',
        '　中弹的话，🤡 还没挂完的分钟会**折进禁言**一起还上',
        '　只要打完这一局，🤡 当场摘掉 —— 倒下了也算',
        '- **枪打空了不代表结束：**',
        '　箱子里还有货 → 系统**自动补 1 发**接着打（这发白送，不抬赌注）',
        '　箱子也空了 → 所有活着的人**投票**：同意收场就平局，',
        '　**只要一个人不同意，就再开一盒子，接着打**',
        '　只剩 1 人 → 他是**冠军**，零禁言，游戏立刻结束',
        `- 基础赌注 **${view.baseMinutes} 分钟**，每加压一发 **+${view.minutesPerPressure} 分钟**`,
        '　换箱子不清赌注，之前加的压一分都不会退',
        '',
        `一盒子 ${view.poolSize} 发里有 ${view.poolDudMin}~${view.poolDudMax} 发是废的。`,
        '**你可以赌它是哑弹，但你只有一条命去验证。**',
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

    // 反手序列中的强制开枪：不能逃、不能加压、不能抽弹。要把原因说清楚。
    let forcedLine = null;
    if (view.riposte) {
        forcedLine = view.riposte.stage === 'return'
            ? '🔙 **这一枪是反手换回来的补枪。**不能逃、不能加压、不能抽弹。'
            : `🔙 **${view.riposte.targetName} 被反手逼到了枪口上。**这一枪不能逃、不能加压、不能抽弹。`;
    } else if (view.canQuit === false) {
        // 戴罪上桌的人没有逃生按钮，得当众说清楚，不然全场只会觉得面板少了个按钮。
        forcedLine = '🤡 **他是戴罪上桌的，这局没有退路。**逃生的机会他上一局已经用掉了。';
    }

    const unloadLine = view.canUnload
        ? `🔧 **抽弹开枪** — 随手抓一发扔掉并重转弹巢，然后立刻扣扳机。打到子弹的概率降到 **${formatPercent(view.unloadChance)}**，但**赌注一分不降**；抓到的是实弹还是哑弹没人知道，活下来直接传枪，这一轮不能再开 / 加压 / 反手。`
        : null;

    const description = [
        `**轮到 ${view.shooterName} 了。**`,
        ...(forcedLine ? ['', forcedLine] : []),
        '',
        gunLine(view),
        ...(chargeLine(view) ? [chargeLine(view)] : []),
        '',
        `**打到子弹　${formatOdds(view.bullets, view.unknownCount)}　≈ ${formatPercent(view.hitChance)}**`,
        ...(unloadLine ? ['', unloadLine] : []),
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
        view.autoPlay ? [] : [fireRow(view.gameId, view.turnToken, {
            canQuit: view.canQuit !== false,
            canUnload: view.canUnload === true,
        })]
    );
}

function choicePanel(view) {
    const sameOdds = `${formatOdds(view.bullets, view.passUnknownCount)} ≈ ${formatPercent(view.passChance)}`;
    const charge = view.charge || 0;

    const passLine = charge > 0
        ? `🔫 **传枪** — 下一个人面对 ${sameOdds}。**攒的 ${charge} 层蓄力作废。**`
        : `🔫 **传枪** — 下一个人面对 ${sameOdds}`;
    const againLine = `🔁 **再开一枪** — 同样是 ${sameOdds}，但枪口对着**自己**。`
        + `撑过去，蓄力涨到 **${charge + 1} 层**`;
    const loadLine = view.canLoad
        ? `💥 **加压** — 一口气装 **${view.loadBullets} 发**`
            + (charge > 0 ? `（基础 1 + 蓄力 ${charge}）` : '')
            + `并滚动弹巢，下一个人面对 ${formatOdds(view.bullets + view.loadBullets, view.chamberCount)}`
            + ` ≈ ${formatPercent(view.loadChance)}，赌注升到 **💤 ${view.loadStakeMinutes} 分钟**`
        // 加压不了有两种原因，得说对是哪一种：弹巢满了，还是箱子空了。
        : (view.bullets >= view.chamberCount
            ? `💥 **加压** — 枪里已经塞满 ${view.chamberCount} 发，再塞就该炸膛了`
            : '💥 **加压** — 箱子已经空了，没有子弹可以往里塞');
    const tail = view.autoPlay
        ? '🤖 **它正在思考人生……**'
        : `⏳ ${Math.round(view.turnTimeoutMs / 1000)} 秒不选，默认传枪。`;

    const riposteLine = view.canRiposte
        ? `🔙 **反手还击** — 把枪扔回给 ${view.riposteTargetName}。他必须开一枪（**${formatOdds(view.bullets, view.unknownCount)} ≈ ${formatPercent(view.riposteTargetChance)}**），无论他中没中，枪都会回到你手上，你再补一枪。`
        : null;

    const description = [
        `**${view.shooterName} 要怎么处理这把枪？**`,
        '',
        gunLine(view),
        ...(chargeLine(view) ? [chargeLine(view)] : []),
        '',
        passLine,
        ...(riposteLine ? [riposteLine] : []),
        againLine,
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
        view.autoPlay ? [] : [choiceRow(view.gameId, view.turnToken, view.canLoad, view.canRiposte === true)]
    );
}

// 池子也空了：还活着的人投票决定就此收场，还是再开一箱接着打。
function drawVotePanel(view) {
    const description = [
        '**枪空了，箱子也空了。**',
        '',
        `还站着的 **${view.aliveIds.length} 个人**现在得决定：就这么算了，还是再来一箱。`,
        '',
        '🤝 **同意收场** — 本局平局，没有冠军，但谁也不用再挨枪',
        `🔫 **再来一轮** — 桌上再摆 **${view.poolSize} 发**，`
            + `其中 **${view.poolDudMin}~${view.poolDudMax} 发**是哑弹，具体几发重新掷`,
        '',
        '**只要有一个人点「再来一轮」，就立刻重开，不等其他人。**',
        `⏳ ${view.voteSeconds} 秒内不点，算你同意收场。`,
        '',
        `**还站着的**　${mentionList(view, view.aliveIds)}`,
        ...(eliminatedBlock(view) ? ['', eliminatedBlock(view)] : []),
    ].join('\n');

    return message(
        baseEmbed(view, {
            title: '🗳️ 到此为止？',
            description,
            color: COLORS.vote,
        }),
        [voteRow(view.gameId, view.turnToken)]
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

// 哑弹必须当众播报：否则枪里凭空少一发，全场只会以为有人中弹了。
function dudAnnouncement(view) {
    return message(baseEmbed(view, {
        title: '😶 哑弹',
        description: [
            pick(DUD_LINES, view.shooterName),
            '',
            '**这一发废了，从枪里扣掉 —— 但它带不走任何人。**',
            '',
            gunLine(view),
        ].join('\n'),
        color: COLORS.dud,
    }));
}

// 枪打空但箱子里还有货：系统自动补 1 发接着打。补的这发不算加压，不抬赌注。
function reloadAnnouncement(view) {
    return message(baseEmbed(view, {
        title: '🔄 自动上膛',
        description: [
            '枪空了，可桌上那箱子还没见底。',
            '**系统往弹巢里补了 1 发，转轮重新滚了一圈。**',
            '',
            '*这一发没人付钱，赌注一分没涨。*',
            '*当然，它也可能是发哑弹 —— 谁知道呢。*',
            '',
            gunLine(view),
            ...rosterLines(view),
        ].join('\n'),
        color: COLORS.reload,
    }));
}

// 有人在和局判定里投了反对：重开一箱，继续。
function newWaveAnnouncement(view) {
    return message(baseEmbed(view, {
        title: '📦 新的一轮',
        description: [
            `**${view.objectorName} 不同意收场。**`,
            '',
            `桌上又摞上了一盒子 **${view.poolSize} 发**待发子弹，`
                + `其中 **${view.poolDudTotal} 发**是哑弹。枪里已经补上 1 发。`,
            '',
            `*这是第 ${view.wave} 轮。换箱子不换赌注，之前加的压一分都不会退。*`,
            '',
            gunLine(view),
            ...rosterLines(view),
        ].join('\n'),
        color: COLORS.wave,
    }));
}

function hitAnnouncement(view) {
    const lines = [pick(HIT_LINES, view.victimName, view.victimMinutes)];
    // 戴罪的人倒下时，禁言里有一段是上局逃跑欠的，得说明白它是怎么算出来的。
    if (view.victimFoldedMinutes > 0) {
        lines.push(
            '',
            `🤡 他是戴罪上桌的。**赌注 ${view.victimStakeMinutes} 分钟 `
                + `+ 上局逃跑还欠的 ${view.victimFoldedMinutes} 分钟 = ${view.victimMinutes} 分钟。**`,
            '*账清了。名字上的 🤡 这局结束就摘。*'
        );
    }
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

function unloadAnnouncement(view) {
    const lines = [
        `${view.actorName} 从弹巢里抓了 **${view.unloadedBullets} 发**出来扔掉，然后转了一下弹巢。`,
        '',
        '**扔掉的那发是实弹还是哑弹，连他自己都不知道。** 反正是不回箱子了。',
        '枪里少了一发，但**赌注一分不降** —— 他只买命，不省钱。',
        '这一枪要是活下来，枪会直接传走，不能再开、不能加压、也没法反手。',
        '',
        gunLine(view),
        ...rosterLines(view),
    ];

    return message(baseEmbed(view, {
        title: '🔧 抽弹',
        description: lines.join('\n'),
        color: COLORS.unload,
    }));
}

function riposteAnnouncement(view) {
    const lines = [
        `${view.actorName} 没有把枪传下去，而是朝着 ${view.targetName} 扔了回去。`,
        '',
        `**${view.targetName} 必须开这一枪** —— 不能逃、不能加压、不能抽弹。`,
        '无论他中没中，枪都会回到发起人手上补第二枪。',
        '',
        gunLine(view),
        ...rosterLines(view),
    ];

    return message(baseEmbed(view, {
        title: '🔙 反手还击',
        description: lines.join('\n'),
        color: COLORS.riposte,
    }));
}

const ACTION_STYLES = Object.freeze({
    pass: {
        title: '🔫 传枪',
        lines: PASS_LINES,
        color: COLORS.pass,
        detail: view => {
            const lines = [`弹巢前进一格。下一个是 ${view.nextShooterName}，他面对 ${odds(view)}。`];
            if (view.clearedCharge > 0) {
                lines.push(`攒了半天的 **${view.clearedCharge} 层蓄力**就这么没了。那几枪白挨了。`);
            }
            return lines.join('\n');
        },
    },
    again: {
        title: '🔁 再开一枪',
        lines: AGAIN_LINES,
        color: COLORS.again,
        detail: view => {
            const lines = [`枪还在他自己手里，这一枪 ${odds(view)}。`];
            if (view.charge > 0) {
                lines.push(
                    `🔁 **连开蓄力 ×${view.charge}** — 他要是撑到加压，一次能塞 **${view.charge + 1} 发**。`
                );
            }
            return lines.join('\n');
        },
    },
    load: {
        title: '💥 加压',
        lines: LOAD_LINES,
        color: COLORS.load,
        detail: view => {
            const lines = [];
            if (view.loadedBullets > 1) {
                lines.push(
                    `蓄力兑现，一口气塞进去 **${view.loadedBullets} 发**（基础 1 + 连开 ${view.loadedBullets - 1}）。`
                );
            }
            lines.push(`枪里现在有 **${view.bullets} 发**子弹，弹巢重新滚动，之前记住的空巢全部作废。`);
            lines.push(
                `赌注涨到 **💤 ${view.stakeMinutes} 分钟**。下一个是 ${view.nextShooterName}，他面对 ${odds(view)}。`
            );
            return lines.join('\n');
        },
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
        lines.push(
            '',
            `他的名字已经被挂上 **🤡胆小鬼**，游戏结束后还要再挂 **${view.penaltyMinutes} 分钟**。`,
            '想提前摘掉？**顶着这个名字回桌上打完一局。**',
            '但那一局他不会再有逃生按钮，中弹时还没挂完的分钟会折进禁言。'
        );
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
        `本局打了 **${view.wave} 轮**，加压 **${view.pressure} 次**，`
            + `一共往枪里塞了 **${view.pressureBullets} 发**，`
            + `赌注最高到过 **💤 ${view.stakeMinutes} 分钟**。`,
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
        `打完了 **${view.wave} 轮**，子弹和箱子一起见了底。`,
        '',
        '**还站着的人一致同意收场**，本局平局，没有冠军。',
        '',
        `**存活**　${mentionList(view, view.aliveIds)}`,
    ];
    const block = eliminatedBlock(view);
    if (block) lines.push('', block);
    lines.push('', '*谁都可以再要一箱的，但谁都没有。*', '*这大概就是所谓的成熟。*');

    return message(baseEmbed(view, {
        title: '🕊️ 全票通过，到此为止',
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
    voteRow,
    recruitmentPanel,
    firePanel,
    choicePanel,
    drawVotePanel,
    missAnnouncement,
    dudAnnouncement,
    reloadAnnouncement,
    newWaveAnnouncement,
    hitAnnouncement,
    unloadAnnouncement,
    riposteAnnouncement,
    actionAnnouncement,
    cowardAnnouncement,
    cowardRenameMessage,
    cancellationPanel,
    championPanel,
    drawPanel,
    abortPanel,
};
