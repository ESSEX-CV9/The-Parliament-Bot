// src\modules\proposal\commands\setupForm.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { saveSettings } = require('../../../core/utils/database');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('setupform')
    .setDescription('设置一个表单入口')
    .addChannelOption(option => 
        option.setName('目标频道')
            .setDescription('表单提交后发送到的频道')
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
        
        const targetChannel = interaction.options.getChannel('目标频道');
        const requiredVotes = interaction.options.getInteger('所需支持数');
        const forumChannel = interaction.options.getChannel('论坛频道');
        
        // 验证频道类型
        if (targetChannel.type !== 0) { // 0 = GUILD_TEXT
            return interaction.editReply({
                content: '❌ 目标频道必须是文字频道。'
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

        // 检查机器人在目标频道的权限
        const targetChannelPermissions = targetChannel.permissionsFor(botMember);
        if (!targetChannelPermissions || !targetChannelPermissions.has('SendMessages')) {
            return interaction.editReply({
                content: `❌ 机器人在目标频道 ${targetChannel} 没有发送消息的权限。`
            });
        }

        // 检查机器人在论坛频道的权限
        const forumChannelPermissions = forumChannel.permissionsFor(botMember);
        if (!forumChannelPermissions || !forumChannelPermissions.has('CreatePublicThreads')) {
            return interaction.editReply({
                content: `❌ 机器人在论坛频道 ${forumChannel} 没有创建公共帖子的权限。`
            });
        }
        
        console.log('开始设置表单...');
        console.log('Guild ID:', interaction.guild.id);
        console.log('Current Channel:', interaction.channel.name, interaction.channel.id);
        console.log('Target Channel:', targetChannel.name, targetChannel.id);
        console.log('Required Votes:', requiredVotes);
        console.log('Forum Channel:', forumChannel.name, forumChannel.id);
        console.log('操作者:', interaction.user.tag, interaction.user.id);
        
        // 存储设置到数据库
        const settings = {
            guildId: interaction.guild.id,
            targetChannelId: targetChannel.id,
            requiredVotes: requiredVotes,
            forumChannelId: forumChannel.id,
            setupBy: interaction.user.id,
            timestamp: new Date().toISOString()
        };
        
        await saveSettings(interaction.guild.id, settings);
        
        // 检查设置是否成功保存
        const savedSettings = await require('../../../core/utils/database').getSettings(interaction.guild.id);
        console.log('验证保存的设置:', savedSettings);
        
        // 创建表单入口按钮
        let message;
        try {
            message = await interaction.channel.send({
                content: `📝 **议案预审核提交入口**\n请点击下方的按钮，并按照议案表格的格式填写内容。\n\n**表单包含以下字段：**\n• **议案标题**：简洁明了，不超过30字\n• **提案原因**：说明提出此动议的原因\n• **议案动议**：详细说明您的议案内容\n• **执行方案**：说明如何落实此动议\n• **议案执行人**：指定负责执行此议案的人员或部门\n\n提交后，议案需要获得 **${requiredVotes}** 个支持才能进入讨论阶段。`,
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
            content: `✅ **表单设置完成！**\n\n**配置信息：**\n• **当前频道：** ${interaction.channel}\n• **提交目标频道：** ${targetChannel}\n• **所需支持数：** ${requiredVotes}\n• **论坛频道：** ${forumChannel}\n• **入口消息ID：** \`${message.id}\`\n\n用户现在可以点击按钮填写表单。`
        });
        
        console.log(`表单设置完成 - 消息ID: ${message.id}, 操作者: ${interaction.user.tag}`);
        
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