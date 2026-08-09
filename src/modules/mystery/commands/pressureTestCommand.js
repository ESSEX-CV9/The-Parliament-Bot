const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const {
    checkAdminPermission,
    getPermissionDeniedMessage,
} = require('../../../core/utils/permissionManager');
const gameManager = require('../services/mysteryGameManager');
const { startPressureRoulette, CHANNEL_LOCK_GROUP } = require('../services/pressureRouletteGame');

const DEFAULT_BOT_COUNT = 3;
const MIN_BOT_COUNT = 1;
const MAX_BOT_COUNT = 5;
const MIN_TURN_SECONDS = 5;
const MAX_TURN_SECONDS = 300;
const CHAMBER_COUNT = 6;

const NOT_IN_GUILD_MESSAGE = '❌ 此命令只能在服务器中使用。';
const UNEXPECTED_ERROR_MESSAGE = '❌ 开启测试局时出现错误，请查看日志。';

function buildData() {
    return new SlashCommandBuilder()
        .setName('加压轮盘测试')
        .setDescription('【测试用】用虚拟机器人凑人数，单人也能跑通整局加压俄罗斯轮盘')
        .addIntegerOption(option => option
            .setName('机器人数量')
            .setDescription(`补几个自动行动的测试机器人（${MIN_BOT_COUNT}-${MAX_BOT_COUNT}，默认 ${DEFAULT_BOT_COUNT}）`)
            .setMinValue(MIN_BOT_COUNT)
            .setMaxValue(MAX_BOT_COUNT)
            .setRequired(false))
        .addIntegerOption(option => option
            .setName('回合时限')
            .setDescription(`每回合多少秒（${MIN_TURN_SECONDS}-${MAX_TURN_SECONDS}，默认 60）`)
            .setMinValue(MIN_TURN_SECONDS)
            .setMaxValue(MAX_TURN_SECONDS)
            .setRequired(false))
        .addIntegerOption(option => option
            .setName('子弹巢位')
            .setDescription(`把第一发子弹钉在第几个弹巢（1-${CHAMBER_COUNT}，不填则随机）`)
            .setMinValue(1)
            .setMaxValue(CHAMBER_COUNT)
            .setRequired(false))
        .addBooleanOption(option => option
            .setName('等待招募')
            .setDescription('true = 照常等 3 分钟招募真人；默认 false，立即开打')
            .setRequired(false))
        .addBooleanOption(option => option
            .setName('保留消息')
            .setDescription('true = 不删除旧面板，保留整局所有消息（调试用）；默认 false，按 3 条滚动窗口清理')
            .setRequired(false));
}

function createPressureTestCommand({
    startGame = startPressureRoulette,
    checkPermission = checkAdminPermission,
    permissionDeniedMessage = getPermissionDeniedMessage,
    manager = gameManager,
} = {}) {
    const data = buildData();

    async function execute(interaction) {
        try {
            if (!interaction.inGuild()) {
                await interaction.reply({
                    content: NOT_IN_GUILD_MESSAGE,
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }
            if (!checkPermission(interaction.member)) {
                await interaction.reply({
                    content: permissionDeniedMessage(),
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            // 测试指令不走 30 分钟冷却，但仍然尊重玩家锁和加压轮盘自己的频道锁，
            // 避免把正在进行的那局踩掉。其他类型的游戏不受影响。
            const guildId = interaction.guild.id;
            const userId = interaction.user.id;
            const channelBusy = manager.getChannelGame(interaction.channelId, CHANNEL_LOCK_GROUP);
            if (manager.getPlayerGame(guildId, userId) || channelBusy) {
                await interaction.reply({
                    content: '🔫 **这个频道已经有一场加压轮盘了，或者你本人正在别的游戏里。**\n等它结束，或换个频道再开测试局。',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            const botCount = interaction.options.getInteger('机器人数量') ?? DEFAULT_BOT_COUNT;
            const turnSeconds = interaction.options.getInteger('回合时限');
            const bulletChamber = interaction.options.getInteger('子弹巢位') ?? 0;
            const waitForRecruitment = interaction.options.getBoolean('等待招募') === true;
            const keepMessages = interaction.options.getBoolean('保留消息') === true;

            await startGame(interaction, {
                test: {
                    botCount,
                    bulletChamber,
                    immediate: !waitForRecruitment,
                    keepMessages,
                },
                turnDurationMs: turnSeconds ? turnSeconds * 1000 : undefined,
            });
        } catch (error) {
            console.error(
                `[MysteryPressureTest] 开启测试局失败 (guild=${interaction.guild?.id || 'dm'}, user=${interaction.user?.id}):`,
                error
            );
            try {
                if (interaction.deferred && !interaction.replied) {
                    await interaction.editReply({ content: UNEXPECTED_ERROR_MESSAGE });
                } else if (!interaction.replied) {
                    await interaction.reply({
                        content: UNEXPECTED_ERROR_MESSAGE,
                        flags: MessageFlags.Ephemeral,
                    });
                }
            } catch (replyError) {
                console.error('[MysteryPressureTest] 回复异常提示失败:', replyError);
            }
        }
    }

    return { data, execute };
}

const command = createPressureTestCommand();

module.exports = {
    ...command,
    createPressureTestCommand,
};
