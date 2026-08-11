const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const {
    checkAdminPermission,
    getPermissionDeniedMessage,
} = require('../../../core/utils/permissionManager');
const { startPressureRoulette } = require('../services/pressureRouletteGame');
const gameManager = require('../services/mysteryGameManager');
const { isChannelBlocked } = require('../utils/mysteryChannelBlocklist');

const data = new SlashCommandBuilder()
    .setName('加压轮盘测试')
    .setDescription('⚙️ 用虚拟机器人开一局加压轮盘（仅管理员）')
    .addIntegerOption(option => option
        .setName('机器人人数')
        .setDescription('虚拟机器人玩家数（1–5）')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(5));

async function execute(interaction) {
    if (!interaction.inGuild()) {
        await interaction.reply({ content: '❌ 此命令只能在服务器中使用。', flags: MessageFlags.Ephemeral });
        return;
    }
    if (!checkAdminPermission(interaction.member)) {
        await interaction.reply({ content: getPermissionDeniedMessage(), flags: MessageFlags.Ephemeral });
        return;
    }

    // 检查频道禁用
    if (isChannelBlocked(interaction.guild.id, interaction.channel?.id || interaction.channelId)) {
        await interaction.reply({ content: '🚫 **神秘指令在本频道/子区已被禁用。**', flags: MessageFlags.Ephemeral });
        return;
    }

    const existing = gameManager.getChannelGame(interaction.channel.id);
    if (existing) {
        await interaction.reply({ content: '❌ 本频道已有游戏正在进行。', flags: MessageFlags.Ephemeral });
        return;
    }

    const botCount = interaction.options.getInteger('机器人人数') ?? 2;
    await startPressureRoulette(interaction, { testBotCount: botCount });
}

module.exports = { data, execute };
