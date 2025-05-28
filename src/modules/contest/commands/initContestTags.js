const { SlashCommandBuilder, MessageFlags, ChannelType } = require('discord.js');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const { ensureContestStatusTags, CONTEST_STATUS_TAGS } = require('../utils/forumTagManager');
const { getContestSettings, saveContestSettings } = require('../utils/contestDatabase');

const data = new SlashCommandBuilder()
    .setName('初始化赛事标签')
    .setDescription('初始化或更新赛事审批论坛的状态标签')
    .addChannelOption(option => 
        option.setName('论坛频道')
            .setDescription('要初始化标签的论坛频道（可选，默认使用当前设置的审批论坛）')
            .setRequired(false)
            .addChannelTypes(ChannelType.GuildForum));

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

        await interaction.deferReply({ ephemeral: true });

        // 获取目标论坛频道
        let forumChannel = interaction.options.getChannel('论坛频道');
        
        if (!forumChannel) {
            // 如果没有指定频道，使用当前设置的审批论坛
            const settings = await getContestSettings(interaction.guild.id);
            if (!settings || !settings.reviewForumId) {
                return interaction.editReply({
                    content: '❌ 没有指定论坛频道，且赛事系统尚未配置。请先使用 `/设置赛事申请入口` 配置系统，或在此命令中指定论坛频道。'
                });
            }
            
            forumChannel = await interaction.client.channels.fetch(settings.reviewForumId);
            if (!forumChannel) {
                return interaction.editReply({
                    content: '❌ 无法访问已配置的审批论坛，请检查频道是否存在或指定新的论坛频道。'
                });
            }
        }

        // 验证频道类型
        if (forumChannel.type !== ChannelType.GuildForum) {
            return interaction.editReply({
                content: '❌ 指定的频道不是论坛类型频道。'
            });
        }

        // 检查机器人权限
        const botMember = interaction.guild.members.me;
        const forumPermissions = forumChannel.permissionsFor(botMember);
        
        if (!forumPermissions || !forumPermissions.has('ManageThreads')) {
            return interaction.editReply({
                content: `❌ 机器人在论坛频道 ${forumChannel} 没有管理帖子的权限，无法创建或管理标签。`
            });
        }

        await interaction.editReply({
            content: '⏳ 正在初始化论坛标签...'
        });

        try {
            // 创建或确保论坛标签
            const tagMap = await ensureContestStatusTags(forumChannel);
            
            // 更新设置中的标签映射
            const currentSettings = await getContestSettings(interaction.guild.id);
            if (currentSettings) {
                await saveContestSettings({
                    ...currentSettings,
                    tagMap: tagMap,
                    updatedAt: new Date().toISOString()
                });
            }

            // 构建成功消息
            const tagCount = Object.keys(tagMap).length;
            const tagList = Object.entries(CONTEST_STATUS_TAGS)
                .map(([key, config]) => `• ${config.emoji} ${config.name}`)
                .join('\n');

            await interaction.editReply({
                content: `✅ **论坛标签初始化完成！**

**论坛频道：** ${forumChannel}
**已创建/确认的标签数量：** ${tagCount}

**审核状态标签：**
${tagList}

现在可以正常使用赛事申请系统了。这些标签将用于管理申请的审核状态，避免频繁修改帖子标题。`
            });

            console.log(`赛事论坛标签初始化完成 - 论坛: ${forumChannel.id}, 标签数: ${tagCount}, 操作者: ${interaction.user.tag}`);

        } catch (tagError) {
            console.error('初始化论坛标签时出错:', tagError);
            
            await interaction.editReply({
                content: `❌ 初始化论坛标签时出现错误：${tagError.message}\n\n请确保：
• 机器人有管理帖子的权限
• 论坛频道存在且可访问
• 论坛频道的可用标签数量未达到上限`
            });
        }
        
    } catch (error) {
        console.error('初始化赛事标签时出错:', error);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: `❌ 初始化标签时出错：${error.message}`,
                    flags: MessageFlags.Ephemeral
                });
            } else {
                await interaction.editReply({
                    content: `❌ 初始化标签时出错：${error.message}`
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