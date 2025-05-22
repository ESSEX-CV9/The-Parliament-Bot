// src/commands/setupReview.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { saveReviewSettings } = require('../utils/database');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('setupreview')
    .setDescription('设置审核提交入口')
    .addIntegerOption(option => 
        option.setName('所需反应数')
            .setDescription('帖子需要达到的反应数量')
            .setRequired(true))
    .addRoleOption(option => 
        option.setName('奖励身份组')
            .setDescription('达到反应数后获得的身份组')
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
        
        const requiredReactions = interaction.options.getInteger('所需反应数');
        const rewardRole = interaction.options.getRole('奖励身份组');
        
        if (requiredReactions < 1) {
            return interaction.editReply({
                content: '❌ 所需反应数必须大于0。'
            });
        }

        // 检查机器人是否有管理身份组权限
        if (!botMember.permissions.has('ManageRoles')) {
            return interaction.editReply({
                content: '❌ 机器人没有管理身份组的权限，无法为用户添加身份组。'
            });
        }

        // 检查机器人的身份组是否高于奖励身份组
        if (rewardRole.position >= botMember.roles.highest.position) {
            return interaction.editReply({
                content: `❌ 机器人的身份组位置不够高，无法分配 ${rewardRole} 身份组。请将机器人的身份组移动到目标身份组之上。`
            });
        }
        
        console.log('开始设置审核入口...');
        console.log('Guild ID:', interaction.guild.id);
        console.log('Current Channel:', interaction.channel.name, interaction.channel.id);
        console.log('Required Reactions:', requiredReactions);
        console.log('Reward Role:', rewardRole.name, rewardRole.id);
        console.log('操作者:', interaction.user.tag, interaction.user.id);
        
        // 存储设置到数据库
        const reviewSettings = {
            guildId: interaction.guild.id,
            requiredReactions: requiredReactions,
            rewardRoleId: rewardRole.id,
            setupBy: interaction.user.id,
            timestamp: new Date().toISOString()
        };
        
        await saveReviewSettings(interaction.guild.id, reviewSettings);
        
        // 创建审核提交入口按钮
        let message;
        try {
            message = await interaction.channel.send({
                content: `🔍 **作品审核提交入口**\n请点击下方按钮提交您的作品链接进行审核。\n\n**审核要求：**\n• 提交作品链接\n• 作品需要达到 **${requiredReactions}** 个反应\n• 审核通过后将获得 ${rewardRole} 身份组\n\n**注意事项：**\n• 请确保作品帖子链接正确且可访问\n• 只有达到反应数要求的作品才能通过审核\n• 每个用户每次只能提交一个作品`,
                components: [
                    {
                        type: 1, // ACTION_ROW
                        components: [
                            {
                                type: 2, // BUTTON
                                style: 1, // PRIMARY
                                label: '🔍 提交审核',
                                custom_id: 'open_review_form'
                            }
                        ]
                    }
                ]
            });
        } catch (sendError) {
            console.error('发送审核入口消息失败:', sendError);
            return interaction.editReply({
                content: `❌ 发送审核入口消息失败，请检查机器人权限。错误信息：${sendError.message}`
            });
        }
        
        await interaction.editReply({ 
            content: `✅ **审核入口设置完成！**\n\n**配置信息：**\n• **当前频道：** ${interaction.channel}\n• **所需反应数：** ${requiredReactions}\n• **奖励身份组：** ${rewardRole}\n• **入口消息ID：** \`${message.id}\`\n\n用户现在可以点击按钮提交作品的帖子链接进行审核。`
        });
        
        console.log(`审核入口设置完成 - 消息ID: ${message.id}, 操作者: ${interaction.user.tag}`);
        
    } catch (error) {
        console.error('设置审核入口时出错:', error);
        console.error('错误堆栈:', error.stack);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: `❌ 设置审核入口时出错：${error.message}\n请查看控制台获取详细信息。`,
                    flags: MessageFlags.Ephemeral
                });
            } else {
                await interaction.editReply({
                    content: `❌ 设置审核入口时出错：${error.message}\n请查看控制台获取详细信息。`
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