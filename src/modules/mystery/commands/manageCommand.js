const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const {
    checkAdminPermission,
    getPermissionDeniedMessage,
} = require('../../../core/utils/permissionManager');
const { openNamePoolManager } = require('../services/namePoolManager');
const { openChannelAccessManager } = require('../services/channelAccessManager');
const { executeCloseDoor } = require('../../safetySetup/commands/closeDoor');
const { executeOpenDoor } = require('../../safetySetup/commands/openDoor');
const {
    resetPressureUser,
    resetPressureGuild,
} = require('../utils/mysteryStatsDatabase');

const SUBCOMMAND_RESET_STATS = '重置游戏数据';
const RESET_CONFIRM_KEYWORD = '确认清空';

function buildData() {
    return new SlashCommandBuilder()
        .setName('管理')
        .setDescription('管理服务器与神秘指令设置')
        .addSubcommand(subcommand => subcommand
            .setName('神秘名字库')
            .setDescription('管理全 Bot 共用的神秘昵称名字库'))
        .addSubcommand(subcommand => subcommand
            .setName('神秘频道设置')
            .setDescription('管理神秘指令可使用的频道白名单和黑名单'))
        .addSubcommand(subcommand => subcommand
            .setName('关门')
            .setDescription('暂停服务器邀请并交由 Bot 自动续期托管')
            .addStringOption(option => option
                .setName('恢复时间')
                .setDescription('可选，北京时间 YYYY-MM-DD HH:mm；不填则仅 /管理 开门 才恢复')
                .setRequired(false)))
        .addSubcommand(subcommand => subcommand
            .setName('开门')
            .setDescription('停止邀请暂停托管并恢复服务器邀请'))
        .addSubcommand(subcommand => subcommand
            .setName(SUBCOMMAND_RESET_STATS)
            .setDescription('清空本服的加压轮盘游戏数据（不可撤销）')
            .addUserOption(option => option
                .setName('用户')
                .setDescription('只清空这个人的数据；留空则清空全服')
                .setRequired(false))
            .addStringOption(option => option
                .setName('确认')
                .setDescription(`清空全服数据时必填，输入「${RESET_CONFIRM_KEYWORD}」`)
                .setRequired(false)));
}

// 清空是不可撤销的，所以全服清空必须再打一次确认词；
// 只清单个人的数据影响面小，不额外拦。
async function executeResetStats(interaction) {
    const target = interaction.options.getUser('用户');
    const guildId = interaction.guild.id;

    if (target) {
        const removed = resetPressureUser(guildId, target.id);
        await interaction.reply({
            content: removed
                ? `🗑️ 已清空 <@${target.id}> 的加压轮盘游戏数据。`
                : `ℹ️ <@${target.id}> 本来就没有加压轮盘数据，无需清空。`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
        return;
    }

    if (interaction.options.getString('确认') !== RESET_CONFIRM_KEYWORD) {
        await interaction.reply({
            content: [
                '⚠️ **这会清空本服所有人的加压轮盘游戏数据，且无法撤销。**',
                '',
                `确认请重新执行本指令，并在「确认」选项里填入：\`${RESET_CONFIRM_KEYWORD}\``,
                '只想清空某一个人的话，填「用户」选项即可。',
            ].join('\n'),
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const removed = resetPressureGuild(guildId);
    console.warn(`[MysteryStats] 全服数据已被清空 (guild=${guildId}, operator=${interaction.user.id}, rows=${removed})`);
    await interaction.reply({
        content: `🗑️ 已清空本服 **${removed}** 名玩家的加压轮盘游戏数据。`,
        flags: MessageFlags.Ephemeral,
    });
}

function createManageCommand({
    openNamePoolManager: openNames = openNamePoolManager,
    openChannelAccessManager: openChannels = openChannelAccessManager,
    executeCloseDoor: closeDoor = executeCloseDoor,
    executeOpenDoor: openDoor = executeOpenDoor,
    executeResetStats: resetStats = executeResetStats,
    checkPermission = checkAdminPermission,
    permissionDeniedMessage = getPermissionDeniedMessage,
} = {}) {
    const data = buildData();

    async function execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({
                content: '❌ 此命令只能在服务器中使用。',
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

        const subcommand = interaction.options.getSubcommand(false);
        if (subcommand === '神秘名字库') {
            await openNames(interaction);
        } else if (subcommand === '神秘频道设置') {
            await openChannels(interaction);
        } else if (subcommand === '关门') {
            await closeDoor(interaction);
        } else if (subcommand === '开门') {
            await openDoor(interaction);
        } else if (subcommand === SUBCOMMAND_RESET_STATS) {
            await resetStats(interaction);
        } else {
            await interaction.reply({
                content: '❌ 未知的管理指令。',
                flags: MessageFlags.Ephemeral,
            });
        }
    }

    return { data, execute };
}

const command = createManageCommand();

module.exports = {
    ...command,
    createManageCommand,
};
