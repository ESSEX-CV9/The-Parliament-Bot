// src/modules/creatorReview/services/reviewAdminService.js
//
// 原先 6 个独立指令（创作者审核-*）的处理逻辑，合并 /创作者审核 后集中到这里。
// 统一约定：调用前 interaction 已 deferReply（ephemeral），处理函数一律用 editReply 回复。
const { ChannelType } = require('discord.js');
const {
    saveReviewSettings,
    addAllowedServer,
    removeAllowedServer,
    getAllowedServers,
    addAllowedForum,
    removeAllowedForum,
    getAllowedForums,
    isServerAllowed,
} = require('../../../core/utils/database');

const ID_PATTERN = /^\d{17,19}$/;

// ==================== 入口 ====================

/**
 * /创作者审核 入口 设置
 */
async function handleSetupEntry(interaction) {
    if (!interaction.channel) {
        return interaction.editReply({
            content: '❌ 无法访问当前频道，请确保机器人有适当的频道权限。',
        });
    }

    const botMember = interaction.guild.members.me;
    const channelPermissions = interaction.channel.permissionsFor(botMember);

    if (!channelPermissions || !channelPermissions.has('SendMessages')) {
        return interaction.editReply({
            content: '❌ 机器人在当前频道没有发送消息的权限，请检查频道权限设置。',
        });
    }

    if (!channelPermissions.has('EmbedLinks')) {
        return interaction.editReply({
            content: '❌ 机器人在当前频道没有嵌入链接的权限，请检查频道权限设置。',
        });
    }

    const requiredReactions = interaction.options.getInteger('所需反应数');
    const rewardRole = interaction.options.getRole('奖励身份组');

    if (requiredReactions < 1) {
        return interaction.editReply({ content: '❌ 所需反应数必须大于0。' });
    }

    if (!botMember.permissions.has('ManageRoles')) {
        return interaction.editReply({
            content: '❌ 机器人没有管理身份组的权限，无法为用户添加身份组。',
        });
    }

    if (rewardRole.position >= botMember.roles.highest.position) {
        return interaction.editReply({
            content: `❌ 机器人的身份组位置不够高，无法分配 ${rewardRole} 身份组。请将机器人的身份组移动到目标身份组之上。`,
        });
    }

    console.log('开始设置审核入口...');
    console.log('Guild ID:', interaction.guild.id);
    console.log('Current Channel:', interaction.channel.name, interaction.channel.id);
    console.log('Required Reactions:', requiredReactions);
    console.log('Reward Role:', rewardRole.name, rewardRole.id);
    console.log('操作者:', interaction.user.tag, interaction.user.id);

    await saveReviewSettings(interaction.guild.id, {
        guildId: interaction.guild.id,
        requiredReactions,
        rewardRoleId: rewardRole.id,
        setupBy: interaction.user.id,
        timestamp: new Date().toISOString(),
    });

    let message;
    try {
        message = await interaction.channel.send({
            content: `🔍 **作品审核提交入口**\n请点击下方按钮提交您的作品链接进行审核。\n\n**审核要求：**\n• 提交作品链接\n• 作品需要达到 **${requiredReactions}** 个反应\n• 审核通过后将获得 ${rewardRole} 身份组\n\n**注意事项：**\n• 请确保作品帖子链接正确且可访问\n• 只有达到反应数要求的作品才能通过审核\n• 每个用户每次只能提交一个作品`,
            components: [
                {
                    type: 1, // ACTION_ROW
                    components: [
                        {
                            type: 2, // BUTTON
                            style: 1, // PRIMARY
                            label: '🔍 提交审核',
                            custom_id: 'open_review_form',
                        },
                    ],
                },
            ],
        });
    } catch (sendError) {
        console.error('发送审核入口消息失败:', sendError);
        return interaction.editReply({
            content: `❌ 发送审核入口消息失败，请检查机器人权限。错误信息：${sendError.message}`,
        });
    }

    await interaction.editReply({
        content: `✅ **审核入口设置完成！**\n\n**配置信息：**\n• **当前频道：** ${interaction.channel}\n• **所需反应数：** ${requiredReactions}\n• **奖励身份组：** ${rewardRole}\n• **入口消息ID：** \`${message.id}\`\n\n用户现在可以点击按钮提交作品的帖子链接进行审核。`,
    });

    console.log(`审核入口设置完成 - 消息ID: ${message.id}, 操作者: ${interaction.user.tag}`);
}

/**
 * /创作者审核 入口 删除
 */
async function handleDeleteEntry(interaction) {
    const messageId = interaction.options.getString('消息id');

    console.log(`用户 ${interaction.user.tag} 尝试删除审核入口消息: ${messageId}`);

    const message = await interaction.channel.messages.fetch(messageId).catch(() => null);

    if (!message) {
        return interaction.editReply({ content: '❌ 找不到指定的消息，请检查消息ID是否正确。' });
    }

    if (message.author.id !== interaction.client.user.id) {
        return interaction.editReply({ content: '❌ 只能删除机器人发送的审核入口消息。' });
    }

    const hasReviewButton = message.components.some(row =>
        row.components.some(component => component.customId === 'open_review_form'),
    );

    if (!hasReviewButton) {
        return interaction.editReply({ content: '❌ 指定的消息不是审核入口消息。' });
    }

    await message.delete();

    console.log(`审核入口消息已被删除: ${messageId}, 操作者: ${interaction.user.tag}`);
    await interaction.editReply({ content: '✅ 审核入口已成功删除。' });
}

// ==================== 允许的服务器 ====================

/**
 * /创作者审核 服务器 添加
 */
async function handleAddServer(interaction) {
    const targetGuildId = interaction.options.getString('服务器id').trim();

    if (!ID_PATTERN.test(targetGuildId)) {
        return interaction.editReply({
            content: '❌ 无效的服务器ID格式。服务器ID应该是17-19位的数字。',
        });
    }

    console.log(`用户 ${interaction.user.tag} 尝试添加允许服务器: ${targetGuildId}`);

    let targetGuild = null;
    try {
        targetGuild = await interaction.client.guilds.fetch(targetGuildId);
    } catch (error) {
        console.log('无法获取目标服务器信息，可能机器人不在该服务器中');
    }

    const added = await addAllowedServer(interaction.guild.id, targetGuildId);

    if (!added) {
        return interaction.editReply({
            content: `❌ 服务器 \`${targetGuildId}\` 已经在允许列表中了。`,
        });
    }

    const allowedServers = await getAllowedServers(interaction.guild.id);

    let responseContent = `✅ **成功添加允许服务器！**\n\n**添加的服务器：**\n• ID: \`${targetGuildId}\``;

    if (targetGuild) {
        responseContent += `\n• 名称: ${targetGuild.name}`;
        responseContent += `\n• 成员数: ${targetGuild.memberCount}`;
    } else {
        responseContent += `\n• ⚠️ 注意：机器人不在该服务器中，无法获取服务器详细信息`;
    }

    responseContent += `\n\n**当前允许的服务器总数：** ${allowedServers.length}`;

    await interaction.editReply({ content: responseContent });
    console.log(`成功添加允许服务器: ${targetGuildId}, 操作者: ${interaction.user.tag}`);
}

/**
 * /创作者审核 服务器 移除
 */
async function handleRemoveServer(interaction) {
    const targetGuildId = interaction.options.getString('服务器id').trim();

    if (!ID_PATTERN.test(targetGuildId)) {
        return interaction.editReply({
            content: '❌ 无效的服务器ID格式。服务器ID应该是17-19位的数字。',
        });
    }

    console.log(`用户 ${interaction.user.tag} 尝试移除允许服务器: ${targetGuildId}`);

    const removed = await removeAllowedServer(interaction.guild.id, targetGuildId);

    if (!removed) {
        return interaction.editReply({ content: `❌ 服务器 \`${targetGuildId}\` 不在允许列表中。` });
    }

    const allowedServers = await getAllowedServers(interaction.guild.id);

    await interaction.editReply({
        content: `✅ **成功移除允许服务器！**\n\n**移除的服务器ID：** \`${targetGuildId}\`\n**当前允许的服务器总数：** ${allowedServers.length}`,
    });

    console.log(`成功移除允许服务器: ${targetGuildId}, 操作者: ${interaction.user.tag}`);
}

// ==================== 允许的论坛频道 ====================

/**
 * /创作者审核 论坛 添加
 */
async function handleAddForum(interaction) {
    const targetServerId = interaction.options.getString('服务器id').trim();
    const forumChannelId = interaction.options.getString('论坛频道id').trim();

    if (!ID_PATTERN.test(targetServerId)) {
        return interaction.editReply({
            content: '❌ 无效的服务器ID格式。服务器ID应该是17-19位的数字。',
        });
    }

    if (!ID_PATTERN.test(forumChannelId)) {
        return interaction.editReply({
            content: '❌ 无效的频道ID格式。频道ID应该是17-19位的数字。',
        });
    }

    console.log(`用户 ${interaction.user.tag} 尝试添加允许论坛: 服务器=${targetServerId}, 论坛=${forumChannelId}`);

    const serverAllowed = await isServerAllowed(interaction.guild.id, targetServerId);
    if (!serverAllowed) {
        return interaction.editReply({
            content: `❌ 服务器 \`${targetServerId}\` 不在允许的服务器列表中。请先使用 \`/创作者审核 服务器 添加\` 添加该服务器。`,
        });
    }

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

            if (forumChannel.type !== ChannelType.GuildForum) {
                return interaction.editReply({
                    content: '❌ 指定的频道不是论坛频道。只能添加论坛类型的频道。',
                });
            }

            if (forumChannel.guildId !== targetServerId) {
                return interaction.editReply({
                    content: '❌ 指定的论坛频道不属于目标服务器。',
                });
            }
        } catch (error) {
            console.log('无法获取论坛频道信息，可能频道不存在或机器人无权限访问');
        }
    }

    const added = await addAllowedForum(interaction.guild.id, targetServerId, forumChannelId);

    if (!added) {
        return interaction.editReply({
            content: `❌ 论坛频道 \`${forumChannelId}\` 已经在服务器 \`${targetServerId}\` 的允许列表中了。`,
        });
    }

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

    await interaction.editReply({ content: responseContent });
    console.log(`成功添加允许论坛: 服务器=${targetServerId}, 论坛=${forumChannelId}, 操作者=${interaction.user.tag}`);
}

/**
 * /创作者审核 论坛 移除
 */
async function handleRemoveForum(interaction) {
    const targetServerId = interaction.options.getString('服务器id').trim();
    const forumChannelId = interaction.options.getString('论坛频道id').trim();

    if (!ID_PATTERN.test(targetServerId)) {
        return interaction.editReply({
            content: '❌ 无效的服务器ID格式。服务器ID应该是17-19位的数字。',
        });
    }

    if (!ID_PATTERN.test(forumChannelId)) {
        return interaction.editReply({
            content: '❌ 无效的频道ID格式。频道ID应该是17-19位的数字。',
        });
    }

    console.log(`用户 ${interaction.user.tag} 尝试移除允许论坛: 服务器=${targetServerId}, 论坛=${forumChannelId}`);

    const removed = await removeAllowedForum(interaction.guild.id, targetServerId, forumChannelId);

    if (!removed) {
        return interaction.editReply({
            content: `❌ 论坛频道 \`${forumChannelId}\` 不在服务器 \`${targetServerId}\` 的允许列表中。`,
        });
    }

    const allowedForums = await getAllowedForums(interaction.guild.id, targetServerId);

    await interaction.editReply({
        content: `✅ **成功移除允许论坛频道！**\n\n**移除的论坛：**\n• 服务器ID: \`${targetServerId}\`\n• 频道ID: \`${forumChannelId}\`\n\n**该服务器剩余允许的论坛总数：** ${allowedForums.length}`,
    });

    console.log(`成功移除允许论坛: 服务器=${targetServerId}, 论坛=${forumChannelId}, 操作者=${interaction.user.tag}`);
}

module.exports = {
    handleSetupEntry,
    handleDeleteEntry,
    handleAddServer,
    handleRemoveServer,
    handleAddForum,
    handleRemoveForum,
};
