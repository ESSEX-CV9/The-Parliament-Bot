// src\modules\selfModeration\commands\manageSelfModerationBlacklist.js
const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { 
    getSelfModerationBlacklist, 
    addUserToSelfModerationBlacklist, 
    removeUserFromSelfModerationBlacklist,
    cleanupExpiredBlacklist
} = require('../../../core/utils/database');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('搬石公投-管理自助管理黑名单')
    .setDescription('管理自助管理功能的用户黑名单')
    .addSubcommand(subcommand =>
        subcommand
            .setName('添加')
            .setDescription('将用户添加到自助管理黑名单')
            .addUserOption(option =>
                option.setName('用户')
                    .setDescription('要禁止的用户')
                    .setRequired(true))
            .addIntegerOption(option =>
                option.setName('时长')
                    .setDescription('封禁时长（天数，0或不填表示永久）')
                    .setRequired(false)
                    .setMinValue(0)
                    .setMaxValue(365))
            .addStringOption(option =>
                option.setName('原因')
                    .setDescription('封禁原因（可选）')
                    .setRequired(false)
                    .setMaxLength(200)))
    .addSubcommand(subcommand =>
        subcommand
            .setName('移除')
            .setDescription('将用户从自助管理黑名单移除')
            .addUserOption(option =>
                option.setName('用户')
                    .setDescription('要解除封禁的用户')
                    .setRequired(true)))
    .addSubcommand(subcommand =>
        subcommand
            .setName('查看')
            .setDescription('查看当前服务器的自助管理黑名单'))
    .addSubcommand(subcommand =>
        subcommand
            .setName('清理过期')
            .setDescription('清理所有已过期的黑名单条目'));

async function execute(interaction) {
    try {
        // 检查是否在服务器中使用
        if (!interaction.guild) {
            return interaction.reply({
                content: '❌ 此指令只能在服务器中使用。',
                flags: MessageFlags.Ephemeral
            });
        }

        // 检查管理员权限
        const hasPermission = checkAdminPermission(interaction.member);
        if (!hasPermission) {
            return interaction.reply({
                content: getPermissionDeniedMessage(),
                flags: MessageFlags.Ephemeral
            });
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === '添加') {
            await handleAdd(interaction);
        } else if (subcommand === '移除') {
            await handleRemove(interaction);
        } else if (subcommand === '查看') {
            await handleView(interaction);
        } else if (subcommand === '清理过期') {
            await handleCleanup(interaction);
        }

    } catch (error) {
        console.error('执行管理自助管理黑名单指令时出错:', error);
        
        const errorMessage = '❌ 处理指令时出现错误，请稍后重试。';
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: errorMessage,
                    flags: MessageFlags.Ephemeral
                });
            } else {
                await interaction.editReply({
                    content: errorMessage
                });
            }
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

/**
 * 处理添加用户到黑名单
 */
async function handleAdd(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('用户');
    const durationDays = interaction.options.getInteger('时长') || 0;
    const reason = interaction.options.getString('原因');

    // 不能封禁机器人
    if (targetUser.bot) {
        return interaction.editReply({
            content: '❌ 不能将机器人添加到黑名单。'
        });
    }

    // 不能封禁自己
    if (targetUser.id === interaction.user.id) {
        return interaction.editReply({
            content: '❌ 不能将自己添加到黑名单。'
        });
    }

    try {
        const entry = await addUserToSelfModerationBlacklist(
            interaction.guild.id,
            targetUser.id,
            interaction.user.id,
            reason,
            durationDays
        );

        let message = `✅ **已将用户添加到自助管理黑名单**\n\n`;
        message += `**用户：** ${targetUser.tag} (${targetUser.id})\n`;
        message += `**执行人：** ${interaction.user.tag}\n`;
        
        if (durationDays > 0) {
            const expiryTimestamp = Math.floor(new Date(entry.expiresAt).getTime() / 1000);
            message += `**时长：** ${durationDays} 天\n`;
            message += `**解除时间：** <t:${expiryTimestamp}:F> (<t:${expiryTimestamp}:R>)\n`;
        } else {
            message += `**时长：** 永久\n`;
        }
        
        if (reason) {
            message += `**原因：** ${reason}\n`;
        }

        message += `\n该用户将无法使用以下指令：\n`;
        message += `• \`/禁言搬屎用户\`\n`;
        message += `• \`/禁言极端不适发言用户\`\n`;
        message += `• \`/删除搬屎消息\`\n`;
        message += `\n该用户的投票（表情反应）也将不被计入统计。`;

        await interaction.editReply({ content: message });

    } catch (error) {
        console.error('添加用户到黑名单时出错:', error);
        await interaction.editReply({
            content: '❌ 添加用户到黑名单时出错，请稍后重试。'
        });
    }
}

/**
 * 处理从黑名单移除用户
 */
async function handleRemove(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('用户');

    try {
        const success = await removeUserFromSelfModerationBlacklist(
            interaction.guild.id,
            targetUser.id
        );

        if (success) {
            let message = `✅ **已将用户从自助管理黑名单移除**\n\n`;
            message += `**用户：** ${targetUser.tag} (${targetUser.id})\n`;
            message += `**执行人：** ${interaction.user.tag}\n\n`;
            message += `该用户现在可以正常使用自助管理功能。`;

            await interaction.editReply({ content: message });
        } else {
            await interaction.editReply({
                content: `❌ 用户 ${targetUser.tag} 不在黑名单中。`
            });
        }

    } catch (error) {
        console.error('从黑名单移除用户时出错:', error);
        await interaction.editReply({
            content: '❌ 从黑名单移除用户时出错，请稍后重试。'
        });
    }
}

/**
 * 处理查看黑名单
 */
async function handleView(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
        const blacklist = await getSelfModerationBlacklist(interaction.guild.id);
        const entries = Object.entries(blacklist);

        if (entries.length === 0) {
            return interaction.editReply({
                content: '✅ 当前服务器的自助管理黑名单为空。'
            });
        }

        let message = `📋 **自助管理黑名单** (共 ${entries.length} 人)\n\n`;

        const now = new Date();
        let activeCount = 0;
        let expiredCount = 0;

        for (const [userId, entry] of entries) {
            // 检查是否过期
            let isExpired = false;
            if (entry.expiresAt) {
                const expiryDate = new Date(entry.expiresAt);
                isExpired = now >= expiryDate;
            }

            if (isExpired) {
                expiredCount++;
                continue; // 跳过已过期的条目
            }

            activeCount++;

            try {
                const user = await interaction.client.users.fetch(userId);
                message += `**${user.tag}** (${userId})\n`;
            } catch {
                message += `**未知用户** (${userId})\n`;
            }

            const bannedTimestamp = Math.floor(new Date(entry.bannedAt).getTime() / 1000);
            message += `  • 封禁时间: <t:${bannedTimestamp}:R>\n`;

            if (entry.expiresAt) {
                const expiryTimestamp = Math.floor(new Date(entry.expiresAt).getTime() / 1000);
                message += `  • 解除时间: <t:${expiryTimestamp}:R>\n`;
            } else {
                message += `  • 解除时间: 永久\n`;
            }

            if (entry.reason) {
                message += `  • 原因: ${entry.reason}\n`;
            }

            message += `\n`;
        }

        if (expiredCount > 0) {
            message += `\n💡 提示：有 ${expiredCount} 个已过期的条目，使用 \`/管理自助管理黑名单 清理过期\` 清理。`;
        }

        // Discord 消息长度限制为 2000 字符
        if (message.length > 1900) {
            message = message.substring(0, 1900) + '\n\n... (列表过长，已截断)';
        }

        await interaction.editReply({ content: message });

    } catch (error) {
        console.error('查看黑名单时出错:', error);
        await interaction.editReply({
            content: '❌ 查看黑名单时出错，请稍后重试。'
        });
    }
}

/**
 * 处理清理过期条目
 */
async function handleCleanup(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
        const cleanedCount = await cleanupExpiredBlacklist(interaction.guild.id);

        if (cleanedCount > 0) {
            await interaction.editReply({
                content: `✅ 已清理 ${cleanedCount} 个过期的黑名单条目。`
            });
        } else {
            await interaction.editReply({
                content: '✅ 没有需要清理的过期条目。'
            });
        }

    } catch (error) {
        console.error('清理过期黑名单条目时出错:', error);
        await interaction.editReply({
            content: '❌ 清理过期条目时出错，请稍后重试。'
        });
    }
}

module.exports = {
    data,
    execute,
};