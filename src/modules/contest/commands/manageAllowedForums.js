const { SlashCommandBuilder, MessageFlags, ChannelType } = require('discord.js');
const { getContestSettings, saveContestSettings } = require('../utils/contestDatabase');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('管理许可论坛')
    .setDescription('管理允许投稿的论坛列表')
    .addSubcommand(subcommand =>
        subcommand
            .setName('查看')
            .setDescription('查看当前的许可论坛列表'))
    .addSubcommand(subcommand =>
        subcommand
            .setName('添加')
            .setDescription('添加论坛到许可列表')
            .addChannelOption(option =>
                option.setName('论坛')
                    .setDescription('要添加的论坛频道')
                    .setRequired(true)
                    .addChannelTypes(ChannelType.GuildForum)))
    .addSubcommand(subcommand =>
        subcommand
            .setName('移除')
            .setDescription('从许可列表中移除论坛')
            .addChannelOption(option =>
                option.setName('论坛')
                    .setDescription('要移除的论坛频道')
                    .setRequired(true)
                    .addChannelTypes(ChannelType.GuildForum)))
    .addSubcommand(subcommand =>
        subcommand
            .setName('清空')
            .setDescription('清空所有许可论坛（允许所有论坛投稿）'));

async function execute(interaction) {
    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        
        // 检查管理员权限
        const hasPermission = checkAdminPermission(interaction.member);
        if (!hasPermission) {
            return interaction.editReply({
                content: getPermissionDeniedMessage()
            });
        }
        
        const subcommand = interaction.options.getSubcommand();
        const settings = await getContestSettings(interaction.guild.id);
        
        if (!settings) {
            return interaction.editReply({
                content: '❌ 请先使用 `/设置赛事申请入口` 命令初始化赛事系统。'
            });
        }
        
        switch (subcommand) {
            case '查看':
                await handleViewForums(interaction, settings);
                break;
            case '添加':
                await handleAddForum(interaction, settings);
                break;
            case '移除':
                await handleRemoveForum(interaction, settings);
                break;
            case '清空':
                await handleClearForums(interaction, settings);
                break;
        }
        
    } catch (error) {
        console.error('管理许可论坛时出错:', error);
        
        try {
            await interaction.editReply({
                content: `❌ 处理命令时出现错误：${error.message}`
            });
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

async function handleViewForums(interaction, settings) {
    const allowedForumIds = settings.allowedForumIds || [];
    
    if (allowedForumIds.length === 0) {
        return interaction.editReply({
            content: '📝 **当前许可论坛设置：**\n\n🌐 **允许所有论坛投稿**\n\n用户可以从任何论坛投稿作品。'
        });
    }
    
    let forumList = '';
    for (const forumId of allowedForumIds) {
        try {
            const forum = await interaction.client.channels.fetch(forumId);
            if (forum) {
                forumList += `• ${forum.name} (ID: \`${forumId}\`)\n`;
            } else {
                forumList += `• ⚠️ 未知论坛 (ID: \`${forumId}\`)\n`;
            }
        } catch (error) {
            forumList += `• ❌ 无法访问 (ID: \`${forumId}\`)\n`;
        }
    }
    
    await interaction.editReply({
        content: `📝 **当前许可论坛设置：**\n\n🔒 **仅允许以下论坛投稿：**\n${forumList}\n共 ${allowedForumIds.length} 个论坛。`
    });
}

async function handleAddForum(interaction, settings) {
    const forum = interaction.options.getChannel('论坛');
    const allowedForumIds = settings.allowedForumIds || [];
    
    if (allowedForumIds.includes(forum.id)) {
        return interaction.editReply({
            content: `❌ 论坛 **${forum.name}** 已经在许可列表中了。`
        });
    }
    
    const updatedForumIds = [...allowedForumIds, forum.id];
    
    await saveContestSettings(interaction.guild.id, {
        ...settings,
        allowedForumIds: updatedForumIds,
        updatedAt: new Date().toISOString()
    });
    
    await interaction.editReply({
        content: `✅ 已将论坛 **${forum.name}** 添加到许可列表中。\n\n当前许可论坛数量：${updatedForumIds.length} 个`
    });
}

async function handleRemoveForum(interaction, settings) {
    const forum = interaction.options.getChannel('论坛');
    const allowedForumIds = settings.allowedForumIds || [];
    
    if (!allowedForumIds.includes(forum.id)) {
        return interaction.editReply({
            content: `❌ 论坛 **${forum.name}** 不在许可列表中。`
        });
    }
    
    const updatedForumIds = allowedForumIds.filter(id => id !== forum.id);
    
    await saveContestSettings(interaction.guild.id, {
        ...settings,
        allowedForumIds: updatedForumIds,
        updatedAt: new Date().toISOString()
    });
    
    const statusText = updatedForumIds.length === 0 
        ? '现在允许所有论坛投稿。' 
        : `当前许可论坛数量：${updatedForumIds.length} 个`;
    
    await interaction.editReply({
        content: `✅ 已将论坛 **${forum.name}** 从许可列表中移除。\n\n${statusText}`
    });
}

async function handleClearForums(interaction, settings) {
    await saveContestSettings(interaction.guild.id, {
        ...settings,
        allowedForumIds: [],
        updatedAt: new Date().toISOString()
    });
    
    await interaction.editReply({
        content: `✅ 已清空所有许可论坛设置。\n\n🌐 现在允许用户从任何论坛投稿作品。`
    });
}

module.exports = {
    data,
    execute
}; 