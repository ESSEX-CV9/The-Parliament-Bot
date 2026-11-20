// src/modules/channelArchive/commands/archiveConfig.js
const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, ChannelType } = require('discord.js');
const { getStore } = require('../store/instance');
const { getConfig, describeConfig, resolveConfigChannels } = require('../services/configService');
const { isAdministrator } = require('../services/permissionService');

const data = new SlashCommandBuilder()
    .setName('归档配置')
    .setDescription('配置频道归档系统（仅管理员）')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(subcommand =>
        subcommand
            .setName('查看')
            .setDescription('查看当前归档配置'))
    .addSubcommand(subcommand =>
        subcommand
            .setName('设置')
            .setDescription('设置归档系统配置')
            .addRoleOption(option =>
                option
                    .setName('赛事组')
                    .setDescription('允许发起归档投票与参与归档投票的身份组')
                    .setRequired(true))
            .addRoleOption(option =>
                option
                    .setName('管理组')
                    .setDescription('允许发起删除投票与参与删除投票的身份组')
                    .setRequired(true))
            .addStringOption(option =>
                option
                    .setName('允许类别')
                    .setDescription('允许归档的类别 ID，可填多个（空格/逗号分隔，也支持类别链接）')
                    .setRequired(true))
            .addChannelOption(option =>
                option
                    .setName('目标论坛')
                    .setDescription('归档备份帖发布到的论坛频道')
                    .addChannelTypes(ChannelType.GuildForum)
                    .setRequired(true)));

async function execute(interaction) {
    try {
        if (!interaction.guild) {
            await interaction.reply({
                content: '❌ 该命令只能在服务器中使用。',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
        if (!isAdministrator(interaction.member, interaction.memberPermissions)) {
            await interaction.reply({
                content: '❌ 只有服务器管理员可以使用该命令。',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const store = getStore();
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === '查看') {
            const config = getConfig(store, interaction.guild.id);
            await interaction.editReply({
                content: `📋 **频道归档配置**\n\n${describeConfig(config)}`,
            });
            return;
        }

        const eventRole = interaction.options.getRole('赛事组', true);
        const modRole = interaction.options.getRole('管理组', true);
        const categoryInput = interaction.options.getString('允许类别', true);
        const forum = interaction.options.getChannel('目标论坛', true);

        const resolved = await resolveConfigChannels(interaction, categoryInput, forum.id);
        if (resolved.error) {
            await interaction.editReply({ content: resolved.error });
            return;
        }

        const config = store.saveConfig({
            guildId: interaction.guild.id,
            eventRoleId: eventRole.id,
            modRoleId: modRole.id,
            allowedCategoryId: resolved.categories.map(category => category.id).join(','),
            targetForumId: forum.id,
        });

        await interaction.editReply({
            content: `✅ **归档配置已保存**\n\n${describeConfig(config)}`,
        });
    } catch (error) {
        console.error('[ChannelArchive] 配置命令失败:', error);
        const content = `❌ 配置失败：${error.message}`;
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
        } else {
            await interaction.editReply({ content }).catch(() => {});
        }
    }
}

module.exports = {
    data,
    execute,
};
