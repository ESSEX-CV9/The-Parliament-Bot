const { EmbedBuilder } = require('discord.js');
const {
    METRICS,
    THRONES,
    ACHIEVEMENTS,
    MIN_LUCK_SHOTS,
    luckOf,
    formatMinutes,
    formatLuck,
    rankBy,
    computeThroneHolders,
    titlesForUser,
} = require('./pressureTitles');

const PANEL_NAME = '🔫 加压俄罗斯轮盘 · 数据';

const COLORS = Object.freeze({
    profile: 0xE67E22,
    board: 0x5865F2,
    titles: 0xF1C40F,
    empty: 0x4F545C,
});

const NO_MENTIONS = Object.freeze({ parse: [] });
const MEDALS = ['🥇', '🥈', '🥉'];
const LEADERBOARD_SIZE = 10;

// 注意：Discord 只在 description / field.value 里解析 mention，
// title / footer 是纯文本，<@id> 放进去会原样露出来。
function baseEmbed({ title, description, color }) {
    const embed = new EmbedBuilder().setAuthor({ name: PANEL_NAME });
    if (title) embed.setTitle(title);
    if (description) embed.setDescription(description);
    if (color !== undefined) embed.setColor(color);
    return embed;
}

function message(embed) {
    return { embeds: [embed], allowedMentions: NO_MENTIONS };
}

function mention(userId) {
    return `<@${userId}>`;
}

function medal(rank) {
    return MEDALS[rank - 1] || `\`#${String(rank).padStart(2, ' ')}\``;
}

function percent(numerator, denominator) {
    if (!denominator) return '—';
    return `${Math.round((numerator / denominator) * 100)}%`;
}

function emptyPanel(text) {
    return message(baseEmbed({
        title: '还没有任何数据',
        description: text,
        color: COLORS.empty,
    }));
}

/** 个人战绩面板。 */
function profilePanel({ row, rows, userId, totalPlayers }) {
    if (!row) {
        return emptyPanel([
            `${mention(userId)} 还没有打过一场加压俄罗斯轮盘。`,
            '',
            '用 `/神秘指令 加压轮盘` 开一局吧——数据从第一场打完开始记。',
        ].join('\n'));
    }

    const { thrones, achievements } = titlesForUser(rows, userId);
    const luck = luckOf(row);

    const lines = [
        `${mention(userId)} 的加压轮盘战绩`,
        '',
        `🎮 参与 **${row.games_played}** 场　│　👑 冠军 **${row.wins}** 次　│　🛡️ 存活收场 **${row.survived}** 次`,
        `🔫 开枪 **${row.shots_fired}** 次　│　💨 空枪 **${row.blanks}** 次　│　🎯 中弹 **${row.hits_taken}** 次（${percent(row.hits_taken, row.shots_fired)}）`,
        `💣 加压 **${row.loads}** 次 / 塞入 **${row.bullets_loaded}** 发　│　🤝 传枪 **${row.pass_count}** 次　│　🤡 逃跑 **${row.quits}** 次`,
        `🔁 累计连开 **${row.again_count}** 次　│　🔥 单局最多连开 **${row.max_charge}** 连　│　😤 最高直面 **${row.max_bullets_faced}** 发`,
        `🔧 抽弹 **${row.unloads}** 次　│　🔙 反手 **${row.ripostes}** 次 / 送走 **${row.riposte_kills}** 人`,
        `⛓️ 中弹禁言累计 **${formatMinutes(row.timeout_minutes)}**${row.coward_minutes > 0 ? `　│　🤡 逃跑惩罚累计 **${formatMinutes(row.coward_minutes)}**` : ''}`,
        '',
        row.shots_fired >= MIN_LUCK_SHOTS
            ? `🍀 **运气值 ${formatLuck(luck)}**　（按当时概率算他该中 ${row.expected_hits.toFixed(2)} 枪，实际中了 ${row.hits_taken} 枪）`
            : `🍀 运气值　还需要再开 **${MIN_LUCK_SHOTS - row.shots_fired}** 枪才够样本量`,
    ];

    if (thrones.length > 0) {
        lines.push('', '**👑 当前持有的王座称号**');
        for (const throne of thrones) {
            lines.push(`${throne.emoji} **${throne.name}**　\`${throne.holder.display}\`　— ${throne.blurb}`);
        }
    }

    if (achievements.length > 0) {
        lines.push(
            '',
            `**🎖️ 已解锁成就（${achievements.length}/${ACHIEVEMENTS.length}）**`,
            achievements.map(item => `${item.emoji} ${item.name}`).join('　'),
        );
    }

    if (thrones.length === 0 && achievements.length === 0) {
        lines.push('', '_目前还没拿到任何称号。多打几场，或者打得再离谱一点。_');
    }

    const embed = baseEmbed({ description: lines.join('\n'), color: COLORS.profile });
    embed.setFooter({ text: `本服共有 ${totalPlayers} 名玩家的数据 · 测试局不计入` });
    return message(embed);
}

/** 排行榜面板。 */
function leaderboardPanel({ metric, rows, viewerId }) {
    const ranked = rankBy(rows, metric, { higherIsBetter: true });
    if (ranked.length === 0) {
        return emptyPanel(`还没有玩家满足 **${metric.label}** 这个榜单的上榜条件。`);
    }

    const lines = [];
    if (metric.hint) lines.push(`_${metric.hint}_`, '');

    for (const entry of ranked.slice(0, LEADERBOARD_SIZE)) {
        lines.push(`${medal(entry.rank)}　${mention(entry.row.user_id)}　**${metric.format(entry.value)}**`);
    }

    // 榜外的人也想知道自己在哪，单独补一行，省得他去数。
    const own = ranked.find(entry => entry.row.user_id === viewerId);
    if (own && own.rank > LEADERBOARD_SIZE) {
        lines.push('', `⋯⋯`, `${medal(own.rank)}　${mention(viewerId)}　**${metric.format(own.value)}**　← 你在这`);
    } else if (!own) {
        lines.push('', '_你还没有上这个榜。_');
    }

    const embed = baseEmbed({
        title: `${metric.label} 排行榜`,
        description: lines.join('\n'),
        color: COLORS.board,
    });
    embed.setFooter({ text: `共 ${ranked.length} 人上榜 · 测试局不计入` });
    return message(embed);
}

/** 称号墙：王座称号的当前持有者 + 全部成就的解锁条件。 */
function titleWallPanel({ rows, viewerId }) {
    const holders = computeThroneHolders(rows);
    const own = (rows || []).find(row => row.user_id === viewerId) || null;

    const throneLines = THRONES.map(throne => {
        const holder = holders.get(throne.id);
        const who = holder
            ? `${mention(holder.userId)}　\`${holder.display}\``
            : '_虚位以待_';
        const mine = holder?.userId === viewerId ? '　← 你' : '';
        return `${throne.emoji} **${throne.name}**　${who}${mine}\n　　_${throne.rule}_`;
    });

    const achievementLines = ACHIEVEMENTS.map(item => {
        const unlocked = own ? item.test(own) : false;
        return `${unlocked ? '✅' : '⬜'} ${item.emoji} **${item.name}** — ${item.rule}`;
    });

    const embed = baseEmbed({
        title: '称号墙',
        description: [
            '**👑 王座称号**　_全服独占，数据第一的人拿走，随时会被抢。_',
            '',
            throneLines.join('\n'),
            '',
            '**🎖️ 成就称号**　_达标即得，不会失去。_',
            '',
            achievementLines.join('\n'),
        ].join('\n'),
        color: COLORS.titles,
    });
    embed.setFooter({
        text: own
            ? '✅ 表示你已解锁 · 称号只在这里展示，不发身份组也不改昵称'
            : '你还没有数据，先去打一局 · 称号只在这里展示，不发身份组也不改昵称',
    });
    return message(embed);
}

module.exports = {
    LEADERBOARD_SIZE,
    METRICS,
    profilePanel,
    leaderboardPanel,
    titleWallPanel,
};
