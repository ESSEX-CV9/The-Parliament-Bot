const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getArchiveViewRoleSettings, getSelfModerationSettings, getArchiveChannelSettings } = require('../../../core/utils/database');
const { checkSelfModerationPermission } = require('../../../core/utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('获取归档查看权限')
    .setDescription('自助获取或移除查看归档频道的权限')
    .addStringOption(option =>
        option.setName('操作')
            .setDescription('获取或移除归档查看权限')
            .setRequired(true)
            .addChoices(
                { name: '获取权限', value: 'add' },
                { name: '移除权限', value: 'remove' }
            ));

async function execute(interaction) {
    try {
        // 检查是否在服务器中使用
        if (!interaction.guild) {
            return interaction.reply({
                content: '❌ 此指令只能在服务器中使用，不能在私信中使用。',
                flags: MessageFlags.Ephemeral
            });
        }

        // 立即defer以防止超时
        await interaction.deferReply({ ephemeral: true });

        // 检查是否设置了归档查看身份组
        const archiveRoleId = await getArchiveViewRoleSettings(interaction.guild.id);
        if (!archiveRoleId) {
            await interaction.editReply({
                content: '❌ **未设置归档查看身份组**\n\n服务器管理员尚未设置归档查看身份组，请联系管理员进行设置。'
            });
            return;
        }

        // 检查身份组是否存在
        let archiveRole;
        try {
            archiveRole = await interaction.guild.roles.fetch(archiveRoleId);
            if (!archiveRole) {
                await interaction.editReply({
                    content: '❌ **归档查看身份组不存在**\n\n设置的归档查看身份组已被删除，请联系管理员重新设置。'
                });
                return;
            }
        } catch (error) {
            await interaction.editReply({
                content: '❌ **归档查看身份组不存在**\n\n设置的归档查看身份组已被删除，请联系管理员重新设置。'
            });
            return;
        }

        // 检查用户是否有权限使用自助管理功能
        const selfModerationSettings = await getSelfModerationSettings(interaction.guild.id);
        const hasDeletePermission = checkSelfModerationPermission(interaction.member, 'delete', selfModerationSettings);
        const hasMutePermission = checkSelfModerationPermission(interaction.member, 'mute', selfModerationSettings);
        
        if (!hasDeletePermission && !hasMutePermission) {
            await interaction.editReply({
                content: '❌ **权限不足**\n\n您没有权限使用此指令。只有拥有自助管理权限的用户才能使用此功能。\n\n请联系服务器管理员获取相应权限。'
            });
            return;
        }

        const operation = interaction.options.getString('操作');
        
        if (operation === 'add') {
            await handleAddRole(interaction, archiveRole);
        } else {
            await handleRemoveRole(interaction, archiveRole);
        }

    } catch (error) {
        console.error('执行获取归档查看权限指令时出错:', error);
        
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

/**
 * 获取归档频道名称
 */
async function getArchiveChannelName(interaction) {
    try {
        const archiveSettings = await getArchiveChannelSettings(interaction.guild.id);
        if (!archiveSettings || !archiveSettings.enabled || !archiveSettings.channelId) {
            return null;
        }
        
        const archiveChannel = await interaction.guild.channels.fetch(archiveSettings.channelId);
        return archiveChannel ? archiveChannel.name : null;
    } catch (error) {
        console.error('获取归档频道名称时出错:', error);
        return null;
    }
}

async function handleAddRole(interaction, archiveRole) {
    try {
        // 检查用户是否已经拥有该身份组
        if (interaction.member.roles.cache.has(archiveRole.id)) {
            // 获取归档频道名称
            const archiveChannelName = await getArchiveChannelName(interaction);
            
            let responseMessage = `❌ **您已经拥有归档查看权限**\n\n您已经拥有 ${archiveRole} 身份组，`;
            
            if (archiveChannelName) {
                responseMessage += `可以查看 **#${archiveChannelName}** 频道。`;
            } else {
                responseMessage += `可以查看归档频道。`;
            }
            
            await interaction.editReply({
                content: responseMessage
            });
            return;
        }

        // 给用户添加身份组
        await interaction.member.roles.add(archiveRole);
        
        console.log(`${interaction.user.tag} 自助获取了归档查看权限 (${archiveRole.name})`);
        
        // 获取归档频道名称
        const archiveChannelName = await getArchiveChannelName(interaction);
        
        let responseMessage = `✅ **归档查看权限获取成功**\n\n🎉 您已获得 ${archiveRole} 身份组！\n`;
        
        if (archiveChannelName) {
            responseMessage += `📁 现在您可以查看 **#${archiveChannelName}** 频道了。\n\n💡 **提示：** 如果不再需要此权限，可以使用 \`/获取归档查看权限 移除权限\` 来移除。`;
        } else {
            responseMessage += `📁 现在您可以查看归档频道了。\n\n💡 **提示：** 如果不再需要此权限，可以使用 \`/获取归档查看权限 移除权限\` 来移除。\n\n⚠️ **注意：** 当前未设置归档频道，请联系管理员设置。`;
        }
        
        await interaction.editReply({
            content: responseMessage
        });
        
    } catch (error) {
        console.error('添加归档查看身份组时出错:', error);
        
        // 检查是否是权限问题
        if (error.code === 50013) {
            await interaction.editReply({
                content: '❌ **机器人权限不足**\n\n机器人无法给您添加身份组，请联系管理员检查机器人权限设置。'
            });
        } else {
            await interaction.editReply({
                content: '❌ 添加归档查看权限时出现错误，请稍后重试。'
            });
        }
    }
}

async function handleRemoveRole(interaction, archiveRole) {
    try {
        // 检查用户是否拥有该身份组
        if (!interaction.member.roles.cache.has(archiveRole.id)) {
            await interaction.editReply({
                content: `❌ **您没有归档查看权限**\n\n您没有 ${archiveRole} 身份组，无需移除。`
            });
            return;
        }

        // 从用户移除身份组
        await interaction.member.roles.remove(archiveRole);
        
        console.log(`${interaction.user.tag} 自助移除了归档查看权限 (${archiveRole.name})`);
        
        // 获取归档频道名称
        const archiveChannelName = await getArchiveChannelName(interaction);
        
        let responseMessage = `✅ **归档查看权限移除成功**\n\n🗑️ 您已移除 ${archiveRole} 身份组。\n`;
        
        if (archiveChannelName) {
            responseMessage += `📁 您将无法再查看 **#${archiveChannelName}** 频道。\n\n💡 **提示：** 如果需要重新获取权限，可以使用 \`/获取归档查看权限 获取权限\` 来重新获取。`;
        } else {
            responseMessage += `📁 您将无法再查看归档频道。\n\n💡 **提示：** 如果需要重新获取权限，可以使用 \`/获取归档查看权限 获取权限\` 来重新获取。`;
        }
        
        await interaction.editReply({
            content: responseMessage
        });
        
    } catch (error) {
        console.error('移除归档查看身份组时出错:', error);
        
        // 检查是否是权限问题
        if (error.code === 50013) {
            await interaction.editReply({
                content: '❌ **机器人权限不足**\n\n机器人无法移除您的身份组，请联系管理员检查机器人权限设置。'
            });
        } else {
            await interaction.editReply({
                content: '❌ 移除归档查看权限时出现错误，请稍后重试。'
            });
        }
    }
}

module.exports = {
    data,
    execute,
}; 