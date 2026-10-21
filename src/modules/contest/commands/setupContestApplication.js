// src/modules/contest/commands/setupContestApplication.js
const { SlashCommandBuilder, MessageFlags, ChannelType } = require('discord.js');
const { saveContestSettings, getContestSettings, createTrack, updateTrack } = require('../utils/contestDatabase');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const { ensureContestStatusTags } = require('../utils/forumTagManager');

const data = new SlashCommandBuilder()
    .setName('赛事-设置赛事申请入口')
    .setDescription('设置赛事申请系统的基础配置')
    .addChannelOption(option =>
        option.setName('审批论坛')
            .setDescription('用于审核赛事申请的论坛频道')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildForum))
    .addChannelOption(option =>
        option.setName('赛事分类')
            .setDescription('创建赛事频道的分类')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildCategory))
    .addStringOption(option =>
        option.setName('许可论坛')
            .setDescription('允许投稿的论坛ID列表，用逗号分隔（例如：123456789,987654321）')
            .setRequired(false))
    .addIntegerOption(option =>
        option.setName('每页作品数')
            .setDescription('作品展示每页显示的数量（5-8，默认6）')
            .setRequired(false)
            .setMinValue(5)
            .setMaxValue(8))
    .addStringOption(option =>
        option.setName('轨道id')
            .setDescription('轨道标识符（不填则操作默认轨道，填新ID则创建新轨道）')
            .setRequired(false))
    .addStringOption(option =>
        option.setName('轨道名称')
            .setDescription('自定义轨道显示名称')
            .setRequired(false))
    .addRoleOption(option =>
        option.setName('前置身份组')
            .setDescription('申请赛事所需身份组（全服生效；不填则保留现有配置）')
            .setRequired(false));

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

        const reviewForum = interaction.options.getChannel('审批论坛');
        const contestCategory = interaction.options.getChannel('赛事分类');
        const allowedForums = interaction.options.getString('许可论坛') || '';
        const itemsPerPage = interaction.options.getInteger('每页作品数') || 6;
        const trackId = interaction.options.getString('轨道id');
        const trackName = interaction.options.getString('轨道名称');
        const prerequisiteRole = interaction.options.getRole('前置身份组');
        
        // 验证频道类型
        if (reviewForum.type !== ChannelType.GuildForum) {
            return interaction.editReply({
                content: '❌ 审批论坛必须是论坛类型频道。'
            });
        }
        
        if (contestCategory.type !== ChannelType.GuildCategory) {
            return interaction.editReply({
                content: '❌ 赛事分类必须是分类频道。'
            });
        }

        // 检查机器人权限
        const botMember = interaction.guild.members.me;
        
        // 检查论坛权限
        const forumPermissions = reviewForum.permissionsFor(botMember);
        if (!forumPermissions || !forumPermissions.has(['ViewChannel', 'CreatePublicThreads', 'SendMessages'])) {
            return interaction.editReply({
                content: `❌ 机器人在审批论坛 ${reviewForum} 没有足够的权限。需要：查看频道、创建公共帖子、发送消息权限。`
            });
        }
        
        // 检查分类权限
        const categoryPermissions = contestCategory.permissionsFor(botMember);
        if (!categoryPermissions || !categoryPermissions.has(['ViewChannel', 'ManageChannels'])) {
            return interaction.editReply({
                content: `❌ 机器人在赛事分类 ${contestCategory} 没有足够的权限。需要：查看频道、管理频道权限。`
            });
        }

        console.log('权限检查通过，开始设置赛事系统...');
        
        // 验证和处理许可论坛列表
        let allowedForumIds = [];
        if (allowedForums.trim()) {
            const forumIds = allowedForums.split(',').map(id => id.trim()).filter(id => id);
            
            // 验证每个论坛ID是否有效
            for (const forumId of forumIds) {
                try {
                    const forum = await interaction.client.channels.fetch(forumId);
                    if (forum && forum.type === ChannelType.GuildForum && forum.guild.id === interaction.guild.id) {
                        allowedForumIds.push(forumId);
                    } else {
                        await interaction.editReply({
                            content: `❌ 论坛ID ${forumId} 无效或不是本服务器的论坛频道。`
                        });
                        return;
                    }
                } catch (error) {
                    await interaction.editReply({
                        content: `❌ 无法访问论坛ID ${forumId}，请检查ID是否正确。`
                    });
                    return;
                }
            }
        }
        
        try {
            // 确保论坛有所需的审核状态标签
            await interaction.editReply({
                content: '⏳ 正在设置论坛审核标签...'
            });
            
            const tagMap = await ensureContestStatusTags(reviewForum);
            console.log('论坛标签设置完成:', Object.keys(tagMap));
            
            // 保存设置
            await interaction.editReply({
                content: '⏳ 正在保存配置...'
            });

            // ========== 多轨道系统逻辑 ==========
            let settings = await getContestSettings(interaction.guild.id);
            const firstTrack = !settings || Object.keys(settings.tracks || {}).length === 0;
            const finalTrackId = trackId || (firstTrack ? 'default' : settings.defaultTrackId);

            // createTrack requires an initialized settings record, including on
            // the first default-track setup. The first explicit track is default.
            if (!settings) {
                settings = {
                    guildId: interaction.guild.id,
                    defaultTrackId: finalTrackId,
                    tracks: {},
                    itemsPerPage,
                    reviewerRoles: [],
                    applicationPermissionRoles: []
                };
                await saveContestSettings(settings);
            }

            const existingTrack = settings.tracks[finalTrackId];
            const isNewTrack = !existingTrack;
            await interaction.editReply({ content: `⏳ ${isNewTrack ? '创建' : '更新'}轨道: ${finalTrackId}...` });
            const trackData = {
                name: trackName || existingTrack?.name || (finalTrackId === 'default' ? '默认轨道' : `轨道 ${finalTrackId}`),
                reviewForumId: reviewForum.id,
                contestCategoryId: contestCategory.id,
                allowedForumIds,
                tagMap
            };
            const savedTrack = isNewTrack
                ? await createTrack(interaction.guild.id, finalTrackId, trackData)
                : await updateTrack(interaction.guild.id, finalTrackId, trackData);
            const trackDisplayName = savedTrack.name;

            // Track helpers save independently. Always re-read before saving
            // global options, otherwise a stale snapshot restores old tracks.
            settings = await getContestSettings(interaction.guild.id);
            if (firstTrack) settings.defaultTrackId = finalTrackId;
            settings.itemsPerPage = itemsPerPage;
            if (prerequisiteRole) settings.applicationPermissionRoles = [prerequisiteRole.id];
            await saveContestSettings(settings);
            
            console.log(`轨道配置完成 - ID: ${finalTrackId}, 名称: ${trackDisplayName}`);

            // 创建申请入口按钮
            let entryMessage;
            try {
                const buttonCustomId = `contest_application_${finalTrackId}`;
                const trackInfo = trackDisplayName !== '默认轨道' ? `\n\n**轨道：** ${trackDisplayName}` : '';
                
                entryMessage = await interaction.channel.send({
                    content: `🏆 **赛事申请入口**${trackInfo}\n\n欢迎申请举办比赛！\n\n**申请流程：**\n1️⃣ 点击下方按钮填写申请表单\n2️⃣ 等待管理员在审批论坛中审核\n3️⃣ 审核通过后确认建立赛事频道\n4️⃣ 开始管理您的比赛\n\n**表单内容包括：**\n• 比赛标题\n• 主题和参赛要求\n• 比赛持续时间\n• 奖项设置和评价标准\n• 注意事项和其他补充`,
                    components: [
                        {
                            type: 1, // ACTION_ROW
                            components: [
                                {
                                    type: 2, // BUTTON
                                    style: 1, // PRIMARY
                                    label: '🏆 申请办赛事',
                                    custom_id: buttonCustomId
                                }
                            ]
                        }
                    ]
                });
            } catch (sendError) {
                console.error('发送申请入口消息失败:', sendError);
                return interaction.editReply({
                    content: `❌ 发送申请入口消息失败，请检查机器人权限。错误信息：${sendError.message}`
                });
            }
            
            const operationType = isNewTrack ? '创建' : '更新';
            const prerequisiteRoles = settings.applicationPermissionRoles;
            let prerequisiteDescription;
            if (prerequisiteRoles !== undefined && (!Array.isArray(prerequisiteRoles) ||
                !prerequisiteRoles.every(id => typeof id === 'string' && id.length > 0))) {
                prerequisiteDescription = '配置无效，请使用 `/赛事-设置申请权限` 重新设置或清除';
            } else {
                prerequisiteDescription = prerequisiteRoles?.length
                    ? prerequisiteRoles.map(id => `<@&${id}>（ID：\`${id}\`）`).join('、') + '（持有任一身份组；管理员也需满足）'
                    : '不限制，所有成员均可申请';
            }
            await interaction.editReply({
                content: `✅ **赛事申请系统设置完成！**\n\n**操作类型：** ${operationType}轨道\n**轨道信息：**\n• **轨道ID：** \`${finalTrackId}\`\n• **轨道名称：** ${trackDisplayName}\n• **是否为默认轨道：** ${settings.defaultTrackId === finalTrackId ? '是' : '否'}\n\n**配置信息：**\n• **申请入口频道：** ${interaction.channel}\n• **审批论坛：** ${reviewForum}\n• **赛事分类：** ${contestCategory}\n• **全服申请前置身份组：** ${prerequisiteDescription}\n• **每页作品数：** ${itemsPerPage}\n• **许可论坛数量：** ${allowedForumIds.length} 个\n• **入口消息ID：** \`${entryMessage.id}\`\n• **按钮ID：** \`contest_application_${finalTrackId}\`\n\n用户现在可以点击按钮申请举办赛事。\n\n**下一步：**\n• 使用 \`/赛事-管理轨道\` 管理多个轨道\n• 使用 \`/赛事-设置赛事审核员身份组\` 设置审核权限\n• 使用 \`/赛事-设置申请权限\` 设置申请权限（可选）`
            });
            
            console.log(`赛事申请系统设置完成 - 消息ID: ${entryMessage.id}, 操作者: ${interaction.user.tag}`);
            
        } catch (error) {
            console.error('设置赛事申请入口时出错:', error);
            console.error('错误堆栈:', error.stack);
            
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: `❌ 设置时出错：${error.message}\n请查看控制台获取详细信息。`,
                        flags: MessageFlags.Ephemeral
                    });
                } else {
                    await interaction.editReply({
                        content: `❌ 设置时出错：${error.message}\n请查看控制台获取详细信息。`
                    });
                }
            } catch (replyError) {
                console.error('回复错误信息失败:', replyError);
            }
        }
    } catch (error) {
        console.error('设置赛事申请入口时出错:', error);
        console.error('错误堆栈:', error.stack);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: `❌ 设置时出错：${error.message}\n请查看控制台获取详细信息。`,
                    flags: MessageFlags.Ephemeral
                });
            } else {
                await interaction.editReply({
                    content: `❌ 设置时出错：${error.message}\n请查看控制台获取详细信息。`
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
