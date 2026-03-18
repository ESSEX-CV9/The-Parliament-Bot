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
                    .setRequired(true))
            .addBooleanOption(option =>
                option.setName('是否是分服务器')
                    .setDescription('true=分服务器（bot已加入，内容可验证，始终可投稿），false=外部服务器（仅接受链接）')
                    .setRequired(false)))
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
    const subServers = settings.subServers || [];

    if (allowedExternalServers.length === 0 && subServers.length === 0) {
        return interaction.editReply({
            content: '📝 **当前外部服务器设置：**\n\n🏠 **仅允许本服务器投稿**\n\n用户只能从本服务器的论坛投稿作品。'
        });
    }

    async function buildServerLine(serverId) {
        try {
            const guild = await interaction.client.guilds.fetch(serverId);
            return guild ? `• ${guild.name} (ID: \`${serverId}\`)\n` : `• ⚠️ 未知服务器 (ID: \`${serverId}\`)\n`;
        } catch {
            return `• ❌ 无法访问 (ID: \`${serverId}\`)\n`;
        }
    }

    let subServerList = '';
    for (const id of subServers) subServerList += await buildServerLine(id);

    let externalList = '';
    for (const id of allowedExternalServers) externalList += await buildServerLine(id);

    let content = '📝 **当前外部服务器设置：**\n\n';
    if (subServers.length > 0) {
        content += `🔗 **分服务器（内容验证，始终可投稿）：**\n${subServerList}\n`;
    }
    if (allowedExternalServers.length > 0) {
        content += `🌐 **外部服务器（链接模式）：**\n${externalList}\n`;
    }
    content += `共 ${subServers.length} 个分服务器，${allowedExternalServers.length} 个外部服务器。`;

    await interaction.editReply({ content });
}

async function handleAddExternalServer(interaction, settings) {
    const serverId = interaction.options.getString('服务器id').trim();
    const isSubServer = interaction.options.getBoolean('是否是分服务器') ?? false;

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
    const subServers = settings.subServers || [];

    // 检查是否已在任一列表中
    if (subServers.includes(serverId)) {
        return interaction.editReply({
            content: `❌ 服务器 \`${serverId}\` 已经在**分服务器**列表中了。`
        });
    }
    if (allowedExternalServers.includes(serverId)) {
        return interaction.editReply({
            content: `❌ 服务器 \`${serverId}\` 已经在**外部服务器**列表中了。`
        });
    }

    // 尝试获取服务器信息
    let serverName = '未知服务器';
    try {
        const guild = await interaction.client.guilds.fetch(serverId);
        if (guild) serverName = guild.name;
    } catch {
        console.log('无法获取服务器信息，可能机器人不在该服务器中');
    }

    let updatedSettings;
    if (isSubServer) {
        updatedSettings = { ...settings, subServers: [...subServers, serverId], updatedAt: new Date().toISOString() };
        await saveContestSettings(interaction.guild.id, updatedSettings);
        await interaction.editReply({
            content: `✅ 已将服务器 **${serverName}** (\`${serverId}\`) 添加为**分服务器**。\n\n🔗 分服务器可绕过"允许外部投稿"开关，始终向本服务器赛事投稿，且内容会被自动验证。\n\n当前分服务器数量：${updatedSettings.subServers.length} 个`
        });
    } else {
        updatedSettings = { ...settings, allowedExternalServers: [...allowedExternalServers, serverId], updatedAt: new Date().toISOString() };
        await saveContestSettings(interaction.guild.id, updatedSettings);
        await interaction.editReply({
            content: `✅ 已将服务器 **${serverName}** (\`${serverId}\`) 添加到**外部服务器**列表中。\n\n⚠️ **注意：** 机器人无法验证外部服务器的投稿内容，请谨慎管理。\n\n当前外部服务器数量：${updatedSettings.allowedExternalServers.length} 个`
        });
    }
}

async function handleRemoveExternalServer(interaction, settings) {
    const serverId = interaction.options.getString('服务器id').trim();
    const allowedExternalServers = settings.allowedExternalServers || [];
    const subServers = settings.subServers || [];

    const inSubServers = subServers.includes(serverId);
    const inExternal = allowedExternalServers.includes(serverId);

    if (!inSubServers && !inExternal) {
        return interaction.editReply({
            content: `❌ 服务器 \`${serverId}\` 不在分服务器或外部服务器列表中。`
        });
    }

    // 尝试获取服务器信息
    let serverName = '未知服务器';
    try {
        const guild = await interaction.client.guilds.fetch(serverId);
        if (guild) serverName = guild.name;
    } catch {
        console.log('无法获取服务器信息');
    }

    const typeLabel = inSubServers ? '分服务器' : '外部服务器';
    const updatedSettings = {
        ...settings,
        allowedExternalServers: allowedExternalServers.filter(id => id !== serverId),
        subServers: subServers.filter(id => id !== serverId),
        updatedAt: new Date().toISOString()
    };

    await saveContestSettings(interaction.guild.id, updatedSettings);

    await interaction.editReply({
        content: `✅ 已将服务器 **${serverName}** (\`${serverId}\`) 从**${typeLabel}**列表中移除。`
    });
}

async function handleClearExternalServers(interaction, settings) {
    await saveContestSettings(interaction.guild.id, {
        ...settings,
        allowedExternalServers: [],
        subServers: [],
        updatedAt: new Date().toISOString()
    });

    await interaction.editReply({
        content: `✅ 已清空所有分服务器和外部服务器设置。\n\n🏠 现在仅允许用户从本服务器投稿作品。`
    });
}

module.exports = {
    data,
    execute
}; 