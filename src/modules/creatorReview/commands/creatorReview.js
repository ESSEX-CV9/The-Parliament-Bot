// src/modules/creatorReview/commands/creatorReview.js
//
// 由原先 6 个独立指令合并而来（省下 5 个指令名额）：
//   /创作者审核-设置审核提交入口          → /创作者审核 入口 设置
//   /创作者审核-删除审核入口              → /创作者审核 入口 删除
//   /创作者审核-添加允许申请审核的服务器    → /创作者审核 服务器 添加
//   /创作者审核-移除允许申请审核的服务器    → /创作者审核 服务器 移除
//   /创作者审核-添加允许申请审核的论坛频道  → /创作者审核 论坛 添加
//   /创作者审核-移除允许申请审核的论坛频道  → /创作者审核 论坛 移除
//
// 6 个子指令受众一致（都只对管理员开放），因此可以共用同一套顶层权限设置。
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const {
    handleSetupEntry,
    handleDeleteEntry,
    handleAddServer,
    handleRemoveServer,
    handleAddForum,
    handleRemoveForum,
} = require('../services/reviewAdminService');

const data = new SlashCommandBuilder()
    .setName('创作者审核')
    .setDescription('帖子反应审核系统的配置（入口 / 允许的服务器 / 允许的论坛频道）')
    .setDefaultMemberPermissions(0)
    .addSubcommandGroup(group => group
        .setName('入口')
        .setDescription('管理审核提交入口消息')
        .addSubcommand(sub => sub
            .setName('设置')
            .setDescription('在当前频道创建审核提交入口')
            .addIntegerOption(opt => opt
                .setName('所需反应数')
                .setDescription('帖子需要达到的反应数量')
                .setRequired(true))
            .addRoleOption(opt => opt
                .setName('奖励身份组')
                .setDescription('达到反应数后获得的身份组')
                .setRequired(true)))
        .addSubcommand(sub => sub
            .setName('删除')
            .setDescription('删除审核入口消息')
            .addStringOption(opt => opt
                .setName('消息id')
                .setDescription('要删除的审核入口消息ID')
                .setRequired(true))))
    .addSubcommandGroup(group => group
        .setName('服务器')
        .setDescription('管理允许申请审核的服务器')
        .addSubcommand(sub => sub
            .setName('添加')
            .setDescription('添加允许审核的服务器')
            .addStringOption(opt => opt
                .setName('服务器id')
                .setDescription('要添加到允许列表的服务器ID')
                .setRequired(true)))
        .addSubcommand(sub => sub
            .setName('移除')
            .setDescription('移除允许审核的服务器')
            .addStringOption(opt => opt
                .setName('服务器id')
                .setDescription('要从允许列表移除的服务器ID')
                .setRequired(true))))
    .addSubcommandGroup(group => group
        .setName('论坛')
        .setDescription('管理允许申请审核的论坛频道')
        .addSubcommand(sub => sub
            .setName('添加')
            .setDescription('添加允许审核的论坛频道')
            .addStringOption(opt => opt
                .setName('服务器id')
                .setDescription('目标服务器ID')
                .setRequired(true))
            .addStringOption(opt => opt
                .setName('论坛频道id')
                .setDescription('要添加到白名单的论坛频道ID')
                .setRequired(true)))
        .addSubcommand(sub => sub
            .setName('移除')
            .setDescription('移除允许审核的论坛频道')
            .addStringOption(opt => opt
                .setName('服务器id')
                .setDescription('目标服务器ID')
                .setRequired(true))
            .addStringOption(opt => opt
                .setName('论坛频道id')
                .setDescription('要从白名单移除的论坛频道ID')
                .setRequired(true))));

const HANDLERS = {
    '入口:设置': handleSetupEntry,
    '入口:删除': handleDeleteEntry,
    '服务器:添加': handleAddServer,
    '服务器:移除': handleRemoveServer,
    '论坛:添加': handleAddForum,
    '论坛:移除': handleRemoveForum,
};

async function execute(interaction) {
    const group = interaction.options.getSubcommandGroup();
    const sub = interaction.options.getSubcommand();
    const key = `${group}:${sub}`;

    try {
        if (!interaction.guild) {
            return interaction.reply({
                content: '❌ 此指令只能在服务器中使用，不能在私信中使用。',
                flags: MessageFlags.Ephemeral,
            });
        }

        if (!checkAdminPermission(interaction.member)) {
            return interaction.reply({
                content: getPermissionDeniedMessage(),
                flags: MessageFlags.Ephemeral,
            });
        }

        const handler = HANDLERS[key];
        if (!handler) {
            return interaction.reply({
                content: '❌ 未知的子指令。',
                flags: MessageFlags.Ephemeral,
            });
        }

        // 统一在这里 defer，各处理函数一律用 editReply 回复
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await handler(interaction);
    } catch (error) {
        console.error(`[CreatorReview] /创作者审核 ${key} 执行出错:`, error);
        const content = `❌ 执行出错：${error.message}`;
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ content });
            } else {
                await interaction.reply({ content, flags: MessageFlags.Ephemeral });
            }
        } catch (replyError) {
            console.error('[CreatorReview] 回复错误信息失败:', replyError);
        }
    }
}

module.exports = {
    data,
    execute,
};
