const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getContestSettings, saveContestSettings } = require('../utils/contestDatabase');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('赛事-管理外部服务器')
    .setDescription('管理允许投稿的外部服务器列表')
    .addSubcommand(subcommand =>
        subcommand
            .setName('查看')
            .setDescription('查看当前的外部服务器列表'))
    .addSubcommand(subcommand =>
        subcommand
            .setName('添加')
            .setDescription('添加外部服务器到允许列表')
            .addStringOption(option =>
                option.setName('服务器id')
                    .setDescription('要添加的服务器ID')
                    .setRequired(true)))
    .addSubcommand(subcommand =>
        subcommand
            .setName('移除')
            .setDescription('从允许列表中移除外部服务器')
            .addStringOption(option =>
                option.setName('服务器id')
                    .setDescription('要移除的服务器ID')
                    .setRequired(true)))
    .addSubcommand(subcommand =>
        subcommand
            .setName('清空')
            .setDescription('清空所有外部服务器（仅允许本服务器投稿）'));

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
                await handleViewExternalServers(interaction, settings);
                break;
            case '添加':
                await handleAddExternalServer(interaction, settings);
                break;
            case '移除':
                await handleRemoveExternalServer(interaction, settings);
                break;
            case '清空':
                await handleClearExternalServers(interaction, settings);
                break;
        }
        
    } catch (error) {
        console.error('管理外部服务器时出错:', error);
        
        try {
            await interaction.editReply({
                content: `❌ 处理命令时出现错误：${error.message}`
            });
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

async function handleViewExternalServers(interaction, settings) {
    const allowedExternalServers = settings.allowedExternalServers || [];
    
    if (allowedExternalServers.length === 0) {
        return interaction.editReply({
            content: '📝 **当前外部服务器设置：**\n\n🏠 **仅允许本服务器投稿**\n\n用户只能从本服务器的论坛投稿作品。'
        });
    }
    
    let serverList = '';
    for (const serverId of allowedExternalServers) {
        try {
            const guild = await interaction.client.guilds.fetch(serverId);
            if (guild) {
                serverList += `• ${guild.name} (ID: \`${serverId}\`)\n`;
            } else {
                serverList += `• ⚠️ 未知服务器 (ID: \`${serverId}\`)\n`;
            }
        } catch (error) {
            serverList += `• ❌ 无法访问 (ID: \`${serverId}\`)\n`;
        }
    }
    
    await interaction.editReply({
        content: `📝 **当前外部服务器设置：**\n\n🌐 **允许以下外部服务器投稿：**\n${serverList}\n共 ${allowedExternalServers.length} 个外部服务器。`
    });
}

async function handleAddExternalServer(interaction, settings) {
    const serverId = interaction.options.getString('服务器id').trim();
    
    // 验证服务器ID格式
    if (!/^\d{17,19}$/.test(serverId)) {
        return interaction.editReply({
            content: '❌ 无效的服务器ID格式。服务器ID应该是17-19位的数字。'
        });
    }
    
    // 检查是否是本服务器
    if (serverId === interaction.guild.id) {
        return interaction.editReply({
            content: '❌ 不能添加本服务器作为外部服务器。本服务器默认允许投稿。'
        });
    }
    
    const allowedExternalServers = settings.allowedExternalServers || [];
    
    if (allowedExternalServers.includes(serverId)) {
        return interaction.editReply({
            content: `❌ 服务器 \`${serverId}\` 已经在外部服务器列表中了。`
        });
    }
    
    // 尝试获取服务器信息
    let serverName = '未知服务器';
    try {
        const guild = await interaction.client.guilds.fetch(serverId);
        if (guild) {
            serverName = guild.name;
        }
    } catch (error) {
        console.log('无法获取外部服务器信息，可能机器人不在该服务器中');
    }
    
    const updatedServers = [...allowedExternalServers, serverId];
    
    await saveContestSettings(interaction.guild.id, {
        ...settings,
        allowedExternalServers: updatedServers,
        updatedAt: new Date().toISOString()
    });
    
    await interaction.editReply({
        content: `✅ 已将服务器 **${serverName}** (\`${serverId}\`) 添加到外部服务器列表中。\n\n当前外部服务器数量：${updatedServers.length} 个\n\n⚠️ **注意：** 机器人无法验证外部服务器的投稿内容，请谨慎管理。`
    });
}

async function handleRemoveExternalServer(interaction, settings) {
    const serverId = interaction.options.getString('服务器id').trim();
    const allowedExternalServers = settings.allowedExternalServers || [];
    
    if (!allowedExternalServers.includes(serverId)) {
        return interaction.editReply({
            content: `❌ 服务器 \`${serverId}\` 不在外部服务器列表中。`
        });
    }
    
    // 尝试获取服务器信息
    let serverName = '未知服务器';
    try {
        const guild = await interaction.client.guilds.fetch(serverId);
        if (guild) {
            serverName = guild.name;
        }
    } catch (error) {
        console.log('无法获取外部服务器信息');
    }
    
    const updatedServers = allowedExternalServers.filter(id => id !== serverId);
    
    await saveContestSettings(interaction.guild.id, {
        ...settings,
        allowedExternalServers: updatedServers,
        updatedAt: new Date().toISOString()
    });
    
    const statusText = updatedServers.length === 0 
        ? '现在仅允许本服务器投稿。' 
        : `当前外部服务器数量：${updatedServers.length} 个`;
    
    await interaction.editReply({
        content: `✅ 已将服务器 **${serverName}** (\`${serverId}\`) 从外部服务器列表中移除。\n\n${statusText}`
    });
}

async function handleClearExternalServers(interaction, settings) {
    await saveContestSettings(interaction.guild.id, {
        ...settings,
        allowedExternalServers: [],
        updatedAt: new Date().toISOString()
    });
    
    await interaction.editReply({
        content: `✅ 已清空所有外部服务器设置。\n\n🏠 现在仅允许用户从本服务器投稿作品。`
    });
}

module.exports = {
    data,
    execute
}; 