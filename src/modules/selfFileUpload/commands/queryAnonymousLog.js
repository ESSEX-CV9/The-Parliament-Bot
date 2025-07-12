const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getAnonymousUploadByMessageId } = require('../../../core/utils/database');
// 1. 引入核心权限管理器
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('查询匿名补档成员')
        .setDescription('查询匿名上传消息的发送者 (仅管理员)。')
        .addStringOption(option =>
            option.setName('消息链接')
                .setDescription('机器人发布的匿名消息的链接。')
                .setRequired(true)),

    async execute(interaction) {
        // 2. 使用 permissionManager 进行统一的权限检查
        if (!checkAdminPermission(interaction.member)) {
            return interaction.reply({
                content: getPermissionDeniedMessage(), // 3. 使用统一的权限不足提示消息
                ephemeral: true,
            });
        }

        await interaction.deferReply({ ephemeral: true });

        const messageLink = interaction.options.getString('消息链接');

        // 解析链接获取消息ID
        const match = messageLink.match(/\/channels\/\d+\/\d+\/(\d+)/);
        if (!match || !match[1]) {
            return interaction.editReply({
                content: '❌ 无效的消息链接格式。请提供一个指向消息的有效链接。',
            });
        }
        const messageId = match[1];

        try {
            // 从数据库查询日志
            const log = await getAnonymousUploadByMessageId(messageId);

            if (!log) {
                return interaction.editReply({
                    content: 'ℹ️ 未找到该消息的匿名上传记录，或该消息是署名上传的。',
                });
            }

            // 构建并发送结果
            const embed = new EmbedBuilder()
                .setTitle('🕵️ 匿名上传者查询结果')
                .setColor('#2ecc71')
                .setDescription(`查询消息: [点击跳转](${messageLink})`)
                .addFields(
                    { name: '匿名上传者是', value: `<@${log.uploaderId}> (${log.uploaderTag})` }
                )

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('查询匿名上传者时出错:', error);
            await interaction.editReply({
                content: '❌ 查询时发生内部错误。',
            });
        }
    },
};