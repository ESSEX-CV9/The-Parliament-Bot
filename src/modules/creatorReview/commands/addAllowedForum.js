// src/commands/addAllowedForum.js
const { SlashCommandBuilder, MessageFlags, ChannelType } = require('discord.js');
const { addAllowedForum, isServerAllowed, getAllowedForums } = require('../../../core/utils/database');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('addallowedforum')
    .setDescription('添加允许审核的论坛频道')
    .addStringOption(option => 
        option.setName('服务器id')
            .setDescription('目标服务器ID')
            .setRequired(true))
    .addStringOption(option => 
        option.setName('论坛频道id')
            .setDescription('要添加到白名单的论坛频道ID')
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

        const targetServerId = interaction.options.getString('服务器id').trim();
        const forumChannelId = interaction.options.getString('论坛频道id').trim();
        
        // 验证服务器ID和频道ID格式
        if (!/^\d{17,19}$/.test(targetServerId)) {
            return interaction.reply({
                content: '❌ 无效的服务器ID格式。服务器ID应该是17-19位的数字。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        if (!/^\d{17,19}$/.test(forumChannelId)) {
            return interaction.reply({
                content: '❌ 无效的频道ID格式。频道ID应该是17-19位的数字。',
                flags: MessageFlags.Ephemeral
            });
        }
        
        console.log(`用户 ${interaction.user.tag} 尝试添加允许论坛: 服务器=${targetServerId}, 论坛=${forumChannelId}`);
        
        // 检查目标服务器是否在允许列表中
        const serverAllowed = await isServerAllowed(interaction.guild.id, targetServerId);
        if (!serverAllowed) {
            return interaction.reply({
                content: `❌ 服务器 \`${targetServerId}\` 不在允许的服务器列表中。请先使用 \`/addallowpreviewserver\` 添加该服务器。`,
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 尝试获取目标服务器和论坛频道信息
        let targetGuild = null;
        let forumChannel = null;
        
        try {
            targetGuild = await interaction.client.guilds.fetch(targetServerId);
        } catch (error) {
            console.log('无法获取目标服务器信息，可能机器人不在该服务器中');
        }
        
        if (targetGuild) {
            try {
                forumChannel = await interaction.client.channels.fetch(forumChannelId);
                
                // 验证频道是否为论坛类型
                if (forumChannel.type !== ChannelType.GuildForum) {
                    return interaction.reply({
                        content: '❌ 指定的频道不是论坛频道。只能添加论坛类型的频道。',
                        flags: MessageFlags.Ephemeral
                    });
                }
                
                // 验证频道是否属于目标服务器
                if (forumChannel.guildId !== targetServerId) {
                    return interaction.reply({
                        content: '❌ 指定的论坛频道不属于目标服务器。',
                        flags: MessageFlags.Ephemeral
                    });
                }
                
            } catch (error) {
                console.log('无法获取论坛频道信息，可能频道不存在或机器人无权限访问');
            }
        }
        
        // 添加到允许列表
        const added = await addAllowedForum(interaction.guild.id, targetServerId, forumChannelId);
        
        if (!added) {
            return interaction.reply({
                content: `❌ 论坛频道 \`${forumChannelId}\` 已经在服务器 \`${targetServerId}\` 的允许列表中了。`,
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 获取更新后的允许论坛列表
        const allowedForums = await getAllowedForums(interaction.guild.id, targetServerId);
        
        let responseContent = `✅ **成功添加允许论坛频道！**\n\n**添加的论坛：**\n• 频道ID: \`${forumChannelId}\``;
        
        if (targetGuild && forumChannel) {
            responseContent += `\n• 服务器: ${targetGuild.name}`;
            responseContent += `\n• 论坛名称: ${forumChannel.name}`;
            responseContent += `\n• 论坛描述: ${forumChannel.topic || '无描述'}`;
        } else {
            responseContent += `\n• ⚠️ 注意：无法获取论坛详细信息，可能机器人不在目标服务器中`;
        }
        
        responseContent += `\n\n**该服务器允许的论坛总数：** ${allowedForums.length}`;
        
        await interaction.reply({
            content: responseContent,
            flags: MessageFlags.Ephemeral
        });
        
        console.log(`成功添加允许论坛: 服务器=${targetServerId}, 论坛=${forumChannelId}, 操作者=${interaction.user.tag}`);
        
    } catch (error) {
        console.error('添加允许论坛时出错:', error);
        await interaction.reply({
            content: `❌ 添加允许论坛时出错：${error.message}`,
            flags: MessageFlags.Ephemeral
        });
    }
}

module.exports = {
    data,
    execute,
};