// src\modules\selfModeration\commands\setSelfModerationChannels.js
const { SlashCommandBuilder, MessageFlags, ChannelType } = require('discord.js');
const { getSelfModerationSettings, saveSelfModerationSettings } = require('../../../core/utils/database');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const { getChannelTypeDescription } = require('../utils/channelValidator');

const data = new SlashCommandBuilder()
    .setName('设置自助管理频道')
    .setDescription('设置哪些频道可以使用自助管理功能')
    .addSubcommand(subcommand =>
        subcommand
            .setName('添加')
            .setDescription('添加允许使用自助管理的频道')
            .addChannelOption(option =>
                option.setName('频道')
                    .setDescription('要添加的频道（文字频道或论坛频道）')
                    .setRequired(true)
                    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum)))
    .addSubcommand(subcommand =>
        subcommand
            .setName('移除')
            .setDescription('移除允许使用自助管理的频道')
            .addChannelOption(option =>
                option.setName('频道')
                    .setDescription('要移除的频道')
                    .setRequired(true)))
    .addSubcommand(subcommand =>
        subcommand
            .setName('查看')
            .setDescription('查看当前允许使用自助管理的频道列表'))
    .addSubcommand(subcommand =>
        subcommand
            .setName('清空')
            .setDescription('清空所有设置（允许所有频道使用）'));

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
            case '添加':
                await handleAddChannel(interaction);
                break;
            case '移除':
                await handleRemoveChannel(interaction);
                break;
            case '查看':
                await handleViewChannels(interaction);
                break;
            case '清空':
                await handleClearChannels(interaction);
                break;
        }

    } catch (error) {
        console.error('执行设置自助管理频道指令时出错:', error);
        
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

async function handleAddChannel(interaction) {
    try {
        const channel = interaction.options.getChannel('频道');
        
        // 验证频道类型
        if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildForum) {
            return interaction.editReply({
                content: '❌ 只能添加文字频道或论坛频道。'
            });
        }
        
        // 获取当前设置
        let settings = await getSelfModerationSettings(interaction.guild.id);
        if (!settings) {
            settings = {
                guildId: interaction.guild.id,
                deleteRoles: [],
                muteRoles: [],
                allowedChannels: [],
                channelsRestricted: false  // 新增标志位
            };
        }
        
        // 确保相关属性存在
        if (!settings.allowedChannels) {
            settings.allowedChannels = [];
        }
        
        // 检查频道是否已经在列表中
        if (settings.allowedChannels.includes(channel.id)) {
            return interaction.editReply({
                content: `❌ 频道 ${channel} 已经在允许列表中。`
            });
        }
        
        // 添加频道并启用频道限制
        settings.allowedChannels.push(channel.id);
        settings.channelsRestricted = true;  // 启用频道限制
        await saveSelfModerationSettings(interaction.guild.id, settings);
        
        const channelTypeDesc = getChannelTypeDescription(channel);
        console.log(`${interaction.user.tag} 添加了频道 ${channel.name} (${channelTypeDesc}) 到自助管理允许列表`);
        
        await interaction.editReply({
            content: `✅ 已添加 ${channelTypeDesc} ${channel} 到自助管理允许列表。`
        });
        
    } catch (error) {
        console.error('添加频道时出错:', error);
        await interaction.editReply({
            content: '❌ 添加频道时出现错误。'
        });
    }
}

async function handleRemoveChannel(interaction) {
    try {
        const channel = interaction.options.getChannel('频道');
        
        // 获取当前设置
        const settings = await getSelfModerationSettings(interaction.guild.id);
        if (!settings || !settings.channelsRestricted || !settings.allowedChannels) {
            return interaction.editReply({
                content: '❌ 当前没有启用频道限制或设置允许的频道列表。'
            });
        }
        
        // 检查频道是否在列表中
        const index = settings.allowedChannels.indexOf(channel.id);
        if (index === -1) {
            return interaction.editReply({
                content: `❌ 频道 ${channel} 不在允许列表中。`
            });
        }
        
        // 移除频道
        settings.allowedChannels.splice(index, 1);
        await saveSelfModerationSettings(interaction.guild.id, settings);
        
        const channelTypeDesc = getChannelTypeDescription(channel);
        console.log(`${interaction.user.tag} 从自助管理允许列表移除了频道 ${channel.name} (${channelTypeDesc})`);
        
        await interaction.editReply({
            content: `✅ 已从自助管理允许列表移除 ${channelTypeDesc} ${channel}。`
        });
        
    } catch (error) {
        console.error('移除频道时出错:', error);
        await interaction.editReply({
            content: '❌ 移除频道时出现错误。'
        });
    }
}

async function handleViewChannels(interaction) {
    try {
        const settings = await getSelfModerationSettings(interaction.guild.id);
        
        let response = '**📋 自助管理允许频道列表**\n\n';
        
        if (!settings || !settings.channelsRestricted) {
            response += '❌ 未启用频道限制，**所有频道**都可以使用自助管理功能。\n\n';
            response += '💡 **提示：** 使用 `/设置自助管理频道 添加` 来限制只有特定频道可以使用此功能。';
        } else if (!settings.allowedChannels || settings.allowedChannels.length === 0) {
            response += '🔒 **已启用频道限制，但允许列表为空**\n\n';
            response += '❌ 当前**所有频道都不能**使用自助管理功能。\n\n';
            response += '💡 **提示：** 使用 `/设置自助管理频道 添加` 来添加允许使用的频道，或使用 `/设置自助管理频道 重置` 来允许所有频道使用。';
        } else {
            response += '🔒 **已启用频道限制**，以下频道允许使用自助管理功能：\n\n';
            
            for (const channelId of settings.allowedChannels) {
                try {
                    const channel = await interaction.guild.channels.fetch(channelId);
                    if (channel) {
                        const channelTypeDesc = getChannelTypeDescription(channel);
                        response += `• ${channel} (${channelTypeDesc})\n`;
                    } else {
                        response += `• ⚠️ 未知频道 (ID: ${channelId})\n`;
                    }
                } catch (error) {
                    response += `• ❌ 已删除的频道 (ID: ${channelId})\n`;
                }
            }
            
            response += '\n💡 **提示：** 如果频道是论坛，则该论坛下的所有帖子都可以使用自助管理功能。';
        }
        
        await interaction.editReply({ content: response });
        
    } catch (error) {
        console.error('查看频道列表时出错:', error);
        await interaction.editReply({
            content: '❌ 查看频道列表时出现错误。'
        });
    }
}

async function handleClearChannels(interaction) {
    try {
        // 获取当前设置
        let settings = await getSelfModerationSettings(interaction.guild.id);
        if (!settings) {
            settings = {
                guildId: interaction.guild.id,
                deleteRoles: [],
                muteRoles: [],
                allowedChannels: [],
                channelsRestricted: false
            };
        }
        
        // 清空允许的频道列表并启用频道限制
        settings.allowedChannels = [];
        settings.channelsRestricted = true;  // 启用频道限制，但列表为空
        await saveSelfModerationSettings(interaction.guild.id, settings);
        
        console.log(`${interaction.user.tag} 清空了自助管理允许频道列表（禁止所有频道）`);
        
        await interaction.editReply({
            content: '✅ 已清空自助管理允许频道列表。现在**所有频道都不能**使用自助管理功能。\n\n💡 使用 `/设置自助管理频道 添加` 来添加允许使用的频道，或使用 `/设置自助管理频道 重置` 来重新允许所有频道使用。'
        });
        
    } catch (error) {
        console.error('清空频道列表时出错:', error);
        await interaction.editReply({
            content: '❌ 清空频道列表时出现错误。'
        });
    }
}

module.exports = {
    data,
    execute,
};