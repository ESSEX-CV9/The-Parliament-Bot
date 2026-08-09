const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const {
    listPressureStats,
    getPressureGuildSummary,
} = require('../utils/mysteryStatsDatabase');
const {
    METRICS,
    DEFAULT_METRIC_KEY,
    getMetric,
    formatMinutes,
} = require('../services/pressureTitles');
const {
    profilePanel,
    leaderboardPanel,
    titleWallPanel,
} = require('../services/pressureStatsPanels');

const SUBCOMMAND_PROFILE = '我的数据';
const SUBCOMMAND_LEADERBOARD = '排行榜';
const SUBCOMMAND_TITLES = '称号墙';
const SUBCOMMAND_SERVER = '全服统计';

const GUILD_ONLY_MESSAGE = '❌ 此指令只能在服务器中使用。';
const UNKNOWN_SUBCOMMAND_MESSAGE = '❌ 未知的子指令。';
const FAILURE_MESSAGE = '❌ 读取游戏数据时出错了，请稍后再试。';
const BOT_TARGET_MESSAGE = '🤖 **机器人不玩这个。**';

function buildData() {
    return new SlashCommandBuilder()
        .setName('神秘指令游戏数据')
        .setDescription('查看加压俄罗斯轮盘的战绩、排行榜与称号')
        .addSubcommand(subcommand => subcommand
            .setName(SUBCOMMAND_PROFILE)
            .setDescription('查看自己或某个人的加压轮盘战绩与称号')
            .addUserOption(option => option
                .setName('用户')
                .setDescription('要查看的成员（留空则看自己）')
                .setRequired(false)))
        .addSubcommand(subcommand => subcommand
            .setName(SUBCOMMAND_LEADERBOARD)
            .setDescription('查看加压轮盘各项数据的排行榜')
            .addStringOption(option => option
                .setName('榜单')
                .setDescription('要看哪个榜（默认冠军次数）')
                .setRequired(false)
                .addChoices(...METRICS.map(metric => ({ name: metric.label, value: metric.key })))))
        .addSubcommand(subcommand => subcommand
            .setName(SUBCOMMAND_TITLES)
            .setDescription('查看所有称号的获得条件与当前持有者'))
        .addSubcommand(subcommand => subcommand
            .setName(SUBCOMMAND_SERVER)
            .setDescription('查看本服加压轮盘的总体数据'));
}

function serverSummaryPanel(summary) {
    return {
        content: [
            '🔫 **本服加压俄罗斯轮盘 · 总体数据**',
            '',
            `👥 有数据的玩家：**${summary.players}** 人`,
            `🎮 累计上桌人次：**${summary.game_entries}** 次`,
            `🔫 累计开枪：**${summary.shots_fired}** 次　│　🎯 累计中弹：**${summary.hits_taken}** 次`,
            `💣 累计塞入子弹：**${summary.bullets_loaded}** 发　│　🤡 累计逃跑：**${summary.quits}** 次`,
            `⛓️ 这个游戏一共制造了 **${formatMinutes(summary.timeout_minutes)}** 的安静。`,
        ].join('\n'),
        allowedMentions: { parse: [] },
    };
}

// 数据面板一律私密：查战绩、翻榜单是随手就会点的操作，
// 公开发出来会把正在进行的游戏面板顶走，也免得有人被迫在频道里公开自己的糗数据。
// 标记加在回复处而不是面板里，面板本身保持可复用。
function privately(payload) {
    return { ...payload, flags: MessageFlags.Ephemeral };
}

function createGameStatsCommand({
    listStats = listPressureStats,
    getSummary = getPressureGuildSummary,
} = {}) {
    const data = buildData();

    async function execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: GUILD_ONLY_MESSAGE, flags: MessageFlags.Ephemeral });
            return;
        }

        const subcommand = interaction.options.getSubcommand(false);
        const guildId = interaction.guild.id;
        const viewerId = interaction.user.id;

        try {
            if (subcommand === SUBCOMMAND_PROFILE) {
                const target = interaction.options.getUser('用户') || interaction.user;
                if (target.bot) {
                    await interaction.reply({ content: BOT_TARGET_MESSAGE, flags: MessageFlags.Ephemeral });
                    return;
                }
                const rows = listStats(guildId);
                await interaction.reply(privately(profilePanel({
                    row: rows.find(row => row.user_id === target.id) || null,
                    rows,
                    userId: target.id,
                    totalPlayers: rows.length,
                })));
                return;
            }

            if (subcommand === SUBCOMMAND_LEADERBOARD) {
                const metric = getMetric(interaction.options.getString('榜单') || DEFAULT_METRIC_KEY);
                await interaction.reply(privately(leaderboardPanel({
                    metric,
                    rows: listStats(guildId),
                    viewerId,
                })));
                return;
            }

            if (subcommand === SUBCOMMAND_TITLES) {
                await interaction.reply(privately(titleWallPanel({ rows: listStats(guildId), viewerId })));
                return;
            }

            if (subcommand === SUBCOMMAND_SERVER) {
                await interaction.reply(privately(serverSummaryPanel(getSummary(guildId))));
                return;
            }

            await interaction.reply({ content: UNKNOWN_SUBCOMMAND_MESSAGE, flags: MessageFlags.Ephemeral });
        } catch (error) {
            console.error(
                `[MysteryStats] 查询游戏数据失败 (guild=${guildId}, user=${viewerId}, subcommand=${subcommand || 'unknown'}):`,
                error
            );
            try {
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({ content: FAILURE_MESSAGE, flags: MessageFlags.Ephemeral });
                } else {
                    await interaction.reply({ content: FAILURE_MESSAGE, flags: MessageFlags.Ephemeral });
                }
            } catch (replyError) {
                console.error('[MysteryStats] 回复失败提示时再次出错:', replyError);
            }
        }
    }

    return { data, execute };
}

const command = createGameStatsCommand();

module.exports = {
    ...command,
    createGameStatsCommand,
};
