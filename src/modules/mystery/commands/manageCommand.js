const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const {
    checkAdminPermission,
    getPermissionDeniedMessage,
} = require('../../../core/utils/permissionManager');
const { openNamePoolManager } = require('../services/namePoolManager');
const { executeCloseDoor } = require('../../safetySetup/commands/closeDoor');
const { executeOpenDoor } = require('../../safetySetup/commands/openDoor');

function buildData() {
    return new SlashCommandBuilder()
        .setName('管理')
        .setDescription('管理服务器与神秘指令设置')
        .addSubcommand(subcommand => subcommand
            .setName('神秘名字库')
            .setDescription('管理全 Bot 共用的神秘昵称名字库'))
        .addSubcommand(subcommand => subcommand
            .setName('关门')
            .setDescription('暂停服务器邀请并交由 Bot 自动续期托管')
            .addStringOption(option => option
                .setName('恢复时间')
                .setDescription('可选，北京时间 YYYY-MM-DD HH:mm；不填则仅 /管理 开门 才恢复')
                .setRequired(false)))
        .addSubcommand(subcommand => subcommand
            .setName('开门')
            .setDescription('停止邀请暂停托管并恢复服务器邀请'));
}

function createManageCommand({
    openNamePoolManager: openNames = openNamePoolManager,
    executeCloseDoor: closeDoor = executeCloseDoor,
    executeOpenDoor: openDoor = executeOpenDoor,
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
        } else if (subcommand === '关门') {
            await closeDoor(interaction);
        } else if (subcommand === '开门') {
            await openDoor(interaction);
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
