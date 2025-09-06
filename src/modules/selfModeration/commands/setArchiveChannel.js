// src\modules\selfModeration\commands\setArchiveChannel.js
const { SlashCommandBuilder, MessageFlags, ChannelType } = require('discord.js');
const { saveArchiveChannelSettings, getArchiveChannelSettings } = require('../../../core/utils/database');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('搬石公投-设置归档频道')
    .setDescription('设置被删除消息的归档频道')
    .addSubcommand(subcommand =>
        subcommand
            .setName('设置')
            .setDescription('设置归档频道')
            .addChannelOption(option =>
                option.setName('频道')
                    .setDescription('用于归档被删除消息的频道')
                    .setRequired(true)
                    .addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(subcommand =>
        subcommand
            .setName('查看')
            .setDescription('查看当前的归档频道设置'))
    .addSubcommand(subcommand =>
        subcommand
            .setName('清除')
            .setDescription('清除归档频道设置（禁用归档功能）'));

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

        const subcommand = interaction.options.getSubcommand();

        switch (subcommand) {
            case '设置':
                await handleSetArchiveChannel(interaction);
                break;
            case '查看':
                await handleViewArchiveChannel(interaction);
                break;
            case '清除':
                await handleClearArchiveChannel(interaction);
                break;
        }

    } catch (error) {
        console.error('执行设置归档频道指令时出错:', error);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ 处理指令时出现错误，请稍后重试。',
                    flags: MessageFlags.Ephemeral
                });
            } else {
                await interaction.editReply({
                    content: '❌ 处理指令时出现错误，请稍后重试。'
                });
            }
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

async function handleSetArchiveChannel(interaction) {
    try {
        const channel = interaction.options.getChannel('频道');
        
        // 验证频道类型
        if (channel.type !== ChannelType.GuildText) {
            return interaction.editReply({
                content: '❌ 归档频道必须是文字频道。'
            });
        }
        
        // 检查机器人是否有必要的权限
        const botMember = interaction.guild.members.me;
        const permissions = channel.permissionsFor(botMember);
        
        if (!permissions.has('ViewChannel')) {
            return interaction.editReply({
                content: '❌ 机器人无法查看该频道，请检查频道权限。'
            });
        }
        
        if (!permissions.has('SendMessages')) {
            return interaction.editReply({
                content: '❌ 机器人无法在该频道发送消息，请检查频道权限。'
            });
        }
        
        if (!permissions.has('EmbedLinks')) {
            return interaction.editReply({
                content: '❌ 机器人无法在该频道发送嵌入消息，请检查频道权限。'
            });
        }
        
        // 保存归档频道设置
        await saveArchiveChannelSettings(interaction.guild.id, {
            channelId: channel.id,
            enabled: true,
            setBy: interaction.user.id,
            setAt: new Date().toISOString()
        });
        
        console.log(`${interaction.user.tag} 设置了服务器 ${interaction.guild.name} 的归档频道为 ${channel.name}`);
        
        await interaction.editReply({
            content: `✅ 已设置归档频道为 ${channel}。\n\n现在当消息通过自助管理被删除时，会先在归档频道记录消息内容。`
        });
        
    } catch (error) {
        console.error('设置归档频道时出错:', error);
        await interaction.editReply({
            content: '❌ 设置归档频道时出现错误。'
        });
    }
}

async function handleViewArchiveChannel(interaction) {
    try {
        const settings = await getArchiveChannelSettings(interaction.guild.id);
        
        let response = '**📁 归档频道设置**\n\n';
        
        if (!settings || !settings.enabled) {
            response += '❌ 未设置归档频道，被删除的消息不会被归档。\n\n';
            response += '💡 **提示：** 使用 `/设置归档频道 设置` 来启用消息归档功能。';
        } else {
            try {
                const archiveChannel = await interaction.guild.channels.fetch(settings.channelId);
                if (archiveChannel) {
                    const setByUser = settings.setBy ? `<@${settings.setBy}>` : '未知用户';
                    const setTime = settings.setAt ? `<t:${Math.floor(new Date(settings.setAt).getTime() / 1000)}:f>` : '未知时间';
                    
                    response += `✅ **状态：** 已启用\n`;
                    response += `📁 **归档频道：** ${archiveChannel}\n`;
                    response += `👤 **设置人：** ${setByUser}\n`;
                    response += `📅 **设置时间：** ${setTime}\n\n`;
                    response += `💡 **说明：** 通过自助管理被删除的消息会先在此频道进行归档记录。`;
                } else {
                    response += `❌ **状态：** 频道不存在\n`;
                    response += `🚨 **错误：** 设置的归档频道 (ID: ${settings.channelId}) 已被删除或机器人无权访问。\n\n`;
                    response += `💡 **建议：** 请重新设置归档频道或清除当前设置。`;
                }
            } catch (error) {
                response += `❌ **状态：** 无法访问\n`;
                response += `🚨 **错误：** 无法访问归档频道 (ID: ${settings.channelId})。\n\n`;
                response += `💡 **建议：** 请检查频道权限或重新设置归档频道。`;
            }
        }
        
        await interaction.editReply({ content: response });
        
    } catch (error) {
        console.error('查看归档频道设置时出错:', error);
        await interaction.editReply({
            content: '❌ 查看归档频道设置时出现错误。'
        });
    }
}

async function handleClearArchiveChannel(interaction) {
    try {
        await saveArchiveChannelSettings(interaction.guild.id, {
            enabled: false,
            clearedBy: interaction.user.id,
            clearedAt: new Date().toISOString()
        });
        
        console.log(`${interaction.user.tag} 清除了服务器 ${interaction.guild.name} 的归档频道设置`);
        
        await interaction.editReply({
            content: '✅ 已清除归档频道设置。现在被删除的消息不会被归档。'
        });
        
    } catch (error) {
        console.error('清除归档频道设置时出错:', error);
        await interaction.editReply({
            content: '❌ 清除归档频道设置时出现错误。'
        });
    }
}

module.exports = {
    data,
    execute,
};