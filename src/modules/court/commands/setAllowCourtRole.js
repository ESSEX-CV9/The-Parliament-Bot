// src/commands/setAllowCourtRole.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { saveCourtSettings, getCourtSettings } = require('../../../core/utils/database');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('setallowcourtrole')
    .setDescription('设置可以申请上庭的身份组')
    .addRoleOption(option => 
        option.setName('身份组')
            .setDescription('可以申请上庭的身份组')
            .setRequired(true))
    .addChannelOption(option => 
        option.setName('申请频道')
            .setDescription('法庭申请发送到的频道')
            .setRequired(true))
    .addChannelOption(option => 
        option.setName('论坛频道')
            .setDescription('创建辩诉帖的论坛频道')
            .setRequired(true))
    .addIntegerOption(option => 
        option.setName('所需支持数')
            .setDescription('创建辩诉帖所需的支持数量（默认20）')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(100));

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

        const courtRole = interaction.options.getRole('身份组');
        const applicationChannel = interaction.options.getChannel('申请频道');
        const forumChannel = interaction.options.getChannel('论坛频道');
        const requiredSupports = interaction.options.getInteger('所需支持数') || 20;
        
        // 验证频道类型
        if (applicationChannel.type !== 0) { // 0 = GUILD_TEXT
            return interaction.editReply({
                content: '❌ 申请频道必须是文字频道。'
            });
        }
        
        if (forumChannel.type !== 15) { // 15 = GUILD_FORUM
            return interaction.editReply({
                content: '❌ 论坛频道必须是论坛类型频道。'
            });
        }

        // 检查机器人权限
        const botMember = interaction.guild.members.me;
        
        // 检查申请频道权限
        const appChannelPermissions = applicationChannel.permissionsFor(botMember);
        if (!appChannelPermissions || !appChannelPermissions.has('SendMessages') || !appChannelPermissions.has('EmbedLinks')) {
            return interaction.editReply({
                content: `❌ 机器人在申请频道 ${applicationChannel} 没有足够的权限（需要发送消息和嵌入链接权限）。`
            });
        }

        // 检查论坛频道权限
        const forumChannelPermissions = forumChannel.permissionsFor(botMember);
        if (!forumChannelPermissions || !forumChannelPermissions.has('CreatePublicThreads')) {
            return interaction.editReply({
                content: `❌ 机器人在论坛频道 ${forumChannel} 没有创建公共帖子的权限。`
            });
        }
        
        console.log('设置法庭身份组...');
        console.log('Guild ID:', interaction.guild.id);
        console.log('Court Role:', courtRole.name, courtRole.id);
        console.log('Application Channel:', applicationChannel.name, applicationChannel.id);
        console.log('Forum Channel:', forumChannel.name, forumChannel.id);
        console.log('Required Supports:', requiredSupports);
        console.log('操作者:', interaction.user.tag, interaction.user.id);
        
        // 存储设置到数据库
        const courtSettings = {
            guildId: interaction.guild.id,
            courtRoleId: courtRole.id,
            applicationChannelId: applicationChannel.id,
            forumChannelId: forumChannel.id,
            requiredSupports: requiredSupports,
            setupBy: interaction.user.id,
            timestamp: new Date().toISOString()
        };
        
        await saveCourtSettings(interaction.guild.id, courtSettings);
        
        await interaction.editReply({ 
            content: `✅ **法庭身份组设置完成！**\n\n**配置信息：**\n• **法庭身份组：** ${courtRole}\n• **申请频道：** ${applicationChannel}\n• **论坛频道：** ${forumChannel}\n• **所需支持数：** ${requiredSupports}\n\n拥有 ${courtRole} 身份组的成员现在可以使用 \`/申请上庭\` 指令发起处罚申请。`
        });
        
        console.log(`法庭身份组设置完成 - 身份组: ${courtRole.name}, 操作者: ${interaction.user.tag}`);
        
    } catch (error) {
        console.error('设置法庭身份组时出错:', error);
        console.error('错误堆栈:', error.stack);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: `❌ 设置法庭身份组时出错：${error.message}\n请查看控制台获取详细信息。`,
                    flags: MessageFlags.Ephemeral
                });
            } else {
                await interaction.editReply({
                    content: `❌ 设置法庭身份组时出错：${error.message}\n请查看控制台获取详细信息。`
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