// src\modules\proposal\commands\setupForm.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { saveSettings } = require('../../../core/utils/database');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const { saveProposalSettings } = require('../utils/proposalDatabase');

const data = new SlashCommandBuilder()
    .setName('提案-设置表单入口')
    .setDescription('设置一个表单入口')
    .addChannelOption(option => 
        option.setName('预审核论坛')
            .setDescription('议案提交后先发送到的审核论坛')
            .setRequired(true))
    .addChannelOption(option => 
        option.setName('投票频道')
            .setDescription('审核通过后发送投票的频道')
            .setRequired(true))
    .addIntegerOption(option => 
        option.setName('所需支持数')
            .setDescription('发布到论坛所需的支持数量')
            .setRequired(true))
    .addChannelOption(option => 
        option.setName('论坛频道')
            .setDescription('达到支持数后发布到的论坛频道')
            .setRequired(true));

async function execute(interaction) {
    try {
        // 检查是否在服务器中使用
        if (!interaction.guild) {
            return interaction.reply({
                content: '❌ 此指令只能在服务器中使用，不能在私信中使用。',
                flags: MessageFlags.Ephemeral
            });
        }

        // 检查用户权限
        const hasPermission = checkAdminPermission(interaction.member);
        
        if (!hasPermission) {
            return interaction.reply({
                content: getPermissionDeniedMessage(),
                flags: MessageFlags.Ephemeral
            });
        }

        // 立即defer以防止超时
        await interaction.deferReply({ ephemeral: true });

        // 检查当前频道是否存在且机器人有权限
        if (!interaction.channel) {
            return interaction.editReply({
                content: '❌ 无法访问当前频道，请确保机器人有适当的频道权限。'
            });
        }

        // 检查机器人在当前频道的权限
        const botMember = interaction.guild.members.me;
        const channelPermissions = interaction.channel.permissionsFor(botMember);
        
        if (!channelPermissions || !channelPermissions.has('SendMessages')) {
            return interaction.editReply({
                content: '❌ 机器人在当前频道没有发送消息的权限，请检查频道权限设置。'
            });
        }

        if (!channelPermissions.has('EmbedLinks')) {
            return interaction.editReply({
                content: '❌ 机器人在当前频道没有嵌入链接的权限，请检查频道权限设置。'
            });
        }
        
        const reviewForum = interaction.options.getChannel('预审核论坛');
        const targetChannel = interaction.options.getChannel('投票频道');
        const requiredVotes = interaction.options.getInteger('所需支持数');
        const forumChannel = interaction.options.getChannel('论坛频道');
        
        // 验证频道类型
        if (reviewForum.type !== 15) { // 15 = GUILD_FORUM
            return interaction.editReply({
                content: '❌ 预审核论坛必须是论坛类型频道。'
            });
        }
        
        if (targetChannel.type !== 0) { // 0 = GUILD_TEXT
            return interaction.editReply({
                content: '❌ 投票频道必须是文字频道。'
            });
        }
        
        if (forumChannel.type !== 15) { // 15 = GUILD_FORUM
            return interaction.editReply({
                content: '❌ 论坛频道必须是论坛类型频道。'
            });
        }
        
        if (requiredVotes < 1) {
            return interaction.editReply({
                content: '❌ 所需支持数必须大于0。'
            });
        }

        // 检查机器人在各个频道的权限
        // 检查预审核论坛权限
        const reviewForumPermissions = reviewForum.permissionsFor(botMember);
        if (!reviewForumPermissions || !reviewForumPermissions.has('CreatePublicThreads')) {
            return interaction.editReply({
                content: `❌ 机器人在预审核论坛 ${reviewForum} 没有创建公共帖子的权限。`
            });
        }

        // 检查投票频道权限
        const targetChannelPermissions = targetChannel.permissionsFor(botMember);
        if (!targetChannelPermissions || !targetChannelPermissions.has('SendMessages')) {
            return interaction.editReply({
                content: `❌ 机器人在投票频道 ${targetChannel} 没有发送消息的权限。`
            });
        }

        // 检查论坛频道权限
        const forumChannelPermissions = forumChannel.permissionsFor(botMember);
        if (!forumChannelPermissions || !forumChannelPermissions.has('CreatePublicThreads')) {
            return interaction.editReply({
                content: `❌ 机器人在论坛频道 ${forumChannel} 没有创建公共帖子的权限。`
            });
        }
        
        console.log('开始设置议案表单...');
        console.log('Guild ID:', interaction.guild.id);
        console.log('Current Channel:', interaction.channel.name, interaction.channel.id);
        console.log('Review Forum:', reviewForum.name, reviewForum.id);
        console.log('Target Channel:', targetChannel.name, targetChannel.id);
        console.log('Required Votes:', requiredVotes);
        console.log('Forum Channel:', forumChannel.name, forumChannel.id);
        console.log('操作者:', interaction.user.tag, interaction.user.id);
        
        // 保存议案设置到新的数据库结构
        const proposalSettings = {
            guildId: interaction.guild.id,
            reviewForumId: reviewForum.id,
            targetChannelId: targetChannel.id,
            requiredVotes: requiredVotes,
            forumChannelId: forumChannel.id,
            setupBy: interaction.user.id,
            timestamp: new Date().toISOString()
        };
        
        await saveProposalSettings(interaction.guild.id, proposalSettings);
        
        // 同时保存到旧的数据库结构以保持兼容性
        const legacySettings = {
            guildId: interaction.guild.id,
            targetChannelId: targetChannel.id,
            requiredVotes: requiredVotes,
            forumChannelId: forumChannel.id,
            setupBy: interaction.user.id,
            timestamp: new Date().toISOString()
        };
        
        await saveSettings(interaction.guild.id, legacySettings);
        
        // 创建表单入口按钮
        let message;
        try {
            message = await interaction.channel.send({
                content: `📝 **议案预审核提交入口**\n请点击下方的按钮，并按照议案表格的格式填写内容。\n\n**表单包含以下字段：**\n• **议案标题**：简洁明了，不超过30字\n• **提案原因**：说明提出此动议的原因\n• **议案动议**：详细说明您的议案内容\n• **执行方案**：说明如何落实此动议\n• **议案执行人**：指定负责执行此议案的人员或部门\n\n**审核流程：**\n1. 提交后议案将在预审核论坛创建审核帖子\n2. 管理员审核通过后发送到投票频道\n3. 需要获得 **${requiredVotes}** 个支持才能进入讨论阶段`,
                components: [
                    {
                        type: 1, // ACTION_ROW
                        components: [
                            {
                                type: 2, // BUTTON
                                style: 1, // PRIMARY
                                label: '📝 填写表单',
                                custom_id: 'open_form'
                            }
                        ]
                    }
                ]
            });
        } catch (sendError) {
            console.error('发送表单入口消息失败:', sendError);
            return interaction.editReply({
                content: `❌ 发送表单入口消息失败，请检查机器人权限。错误信息：${sendError.message}`
            });
        }
        
        await interaction.editReply({ 
            content: `✅ **议案表单设置完成！**\n\n**配置信息：**\n• **当前频道：** ${interaction.channel}\n• **预审核论坛：** ${reviewForum}\n• **投票频道：** ${targetChannel}\n• **所需支持数：** ${requiredVotes}\n• **论坛频道：** ${forumChannel}\n• **入口消息ID：** \`${message.id}\`\n\n用户现在可以点击按钮填写表单，议案将先进入预审核流程。`
        });
        
        console.log(`议案表单设置完成 - 消息ID: ${message.id}, 操作者: ${interaction.user.tag}`);
        
    } catch (error) {
        console.error('设置表单时出错:', error);
        console.error('错误堆栈:', error.stack);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: `❌ 设置表单时出错：${error.message}\n请查看控制台获取详细信息。`,
                    flags: MessageFlags.Ephemeral
                });
            } else {
                await interaction.editReply({
                    content: `❌ 设置表单时出错：${error.message}\n请查看控制台获取详细信息。`
                });
            }
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

module.exports = {
    data,
    execute,
};