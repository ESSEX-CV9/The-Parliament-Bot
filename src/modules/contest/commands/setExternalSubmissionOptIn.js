// src/modules/contest/commands/setExternalSubmissionOptIn.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getContestSettings, saveContestSettings } = require('../utils/contestDatabase');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('赛事-设置外部投稿开关')
    .setDescription('设置是否允许新建赛事开启外部社区投稿')
    .addSubcommand(subcommand =>
        subcommand
            .setName('查看')
            .setDescription('查看当前外部投稿全局开关状态'))
    .addSubcommand(subcommand =>
        subcommand
            .setName('开启')
            .setDescription('开启外部投稿开关（仅影响后续新建的赛事频道）'))
    .addSubcommand(subcommand =>
        subcommand
            .setName('关闭')
            .setDescription('关闭外部投稿开关（仅影响后续新建的赛事频道）'));

async function execute(interaction) {
    try {
        // 仅限服务器中使用
        if (!interaction.guild) {
            return interaction.reply({
                content: '❌ 此指令只能在服务器中使用，不能在私信中使用。',
                flags: MessageFlags.Ephemeral
            });
        }

        // 管理员权限检查
        const hasPermission = checkAdminPermission(interaction.member);
        if (!hasPermission) {
            return interaction.reply({
                content: getPermissionDeniedMessage(),
                flags: MessageFlags.Ephemeral
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;

        // 读取当前设置，提供默认值
        const currentSettings = await getContestSettings(guildId) || {
            guildId,
            allowExternalSubmissionOptIn: false,
            allowedExternalServers: [],
            allowedForumIds: [],
        };

        if (typeof currentSettings.allowExternalSubmissionOptIn !== 'boolean') {
            currentSettings.allowExternalSubmissionOptIn = false;
        }

        if (Array.isArray(currentSettings.allowedExternalServers) === false) {
            currentSettings.allowedExternalServers = [];
        }

        if (Array.isArray(currentSettings.allowedForumIds) === false) {
            currentSettings.allowedForumIds = [];
        }

        switch (subcommand) {
            case '查看': {
                const statusText = currentSettings.allowExternalSubmissionOptIn ? '✅ 已开启' : '❌ 已关闭';
                const externalServers = currentSettings.allowedExternalServers;
                const serverCount = externalServers.length;
                const previewList = serverCount > 0
                    ? externalServers.slice(0, 10).map(id => `• \`${id}\``).join('\n')
                    : '（无外部服务器白名单）';

                await interaction.editReply({
                    content:
                        `📝 **外部投稿全局开关状态：** ${statusText}\n\n` +
                        `🌐 **外部服务器白名单数量：** ${serverCount}\n` +
                        `${serverCount > 0 ? `示例（最多显示10项）：\n${previewList}\n` : ''}` +
                        `\n说明：\n` +
                        `• 开关仅影响“审核通过后新建频道”的阶段是否允许主办人选择开启外部投稿。\n` +
                        `• 关闭后不影响此前已经开启外部投稿的赛事频道。\n` +
                        `• 外部投稿依然需要外部服务器在白名单中才允许。`
                });
                break;
            }
            case '开启': {
                const nextSettings = {
                    ...currentSettings,
                    allowExternalSubmissionOptIn: true,
                    updatedAt: new Date().toISOString()
                };
                await saveContestSettings(guildId, nextSettings);

                await interaction.editReply({
                    content:
                        `✅ **已开启外部投稿开关**\n\n` +
                        `后续新建的赛事频道在“确认建立频道”步骤将显示“是否允许外部服务器投稿”的选择。\n` +
                        `外部投稿仍需满足外部服务器白名单的约束。`
                });
                break;
            }
            case '关闭': {
                const nextSettings = {
                    ...currentSettings,
                    allowExternalSubmissionOptIn: false,
                    updatedAt: new Date().toISOString()
                };
                await saveContestSettings(guildId, nextSettings);

                await interaction.editReply({
                    content:
                        `✅ **已关闭外部投稿开关**\n\n` +
                        `后续新建的赛事频道在“确认建立频道”步骤将不再显示“是否允许外部服务器投稿”的选择，并默认不允许外部投稿。\n` +
                        `此前已开启外部投稿的赛事频道不受影响。`
                });
                break;
            }
            default: {
                await interaction.editReply({
                    content: '❌ 未知的子命令。'
                });
                break;
            }
        }

        console.log(`外部投稿开关指令执行完成 - 子命令: ${subcommand}, 操作者: ${interaction.user.tag}`);
    } catch (error) {
        console.error('设置外部投稿开关时出错:', error);
        try {
            await interaction.editReply({
                content: `❌ 处理命令时出现错误：${error.message}`
            });
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

module.exports = {
    data,
    execute,
};