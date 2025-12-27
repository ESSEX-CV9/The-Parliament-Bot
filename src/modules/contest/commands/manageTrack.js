// src/modules/contest/commands/manageTrack.js
const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { getContestSettings, getAllTracks, deleteTrack, setDefaultTrack, updateTrack } = require('../utils/contestDatabase');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('赛事-管理轨道')
    .setDescription('管理赛事轨道系统')
    .addSubcommand(subcommand =>
        subcommand
            .setName('列出轨道')
            .setDescription('显示所有赛事轨道'))
    .addSubcommand(subcommand =>
        subcommand
            .setName('删除轨道')
            .setDescription('删除指定的赛事轨道')
            .addStringOption(option =>
                option.setName('轨道id')
                    .setDescription('要删除的轨道ID')
                    .setRequired(true)))
    .addSubcommand(subcommand =>
        subcommand
            .setName('设为默认')
            .setDescription('将指定轨道设为默认轨道')
            .addStringOption(option =>
                option.setName('轨道id')
                    .setDescription('要设为默认的轨道ID')
                    .setRequired(true)))
    .addSubcommand(subcommand =>
        subcommand
            .setName('重命名')
            .setDescription('修改轨道的显示名称')
            .addStringOption(option =>
                option.setName('轨道id')
                    .setDescription('要重命名的轨道ID')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('新名称')
                    .setDescription('轨道的新名称')
                    .setRequired(true)));

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

        const subcommand = interaction.options.getSubcommand();

        switch (subcommand) {
            case '列出轨道':
                await handleListTracks(interaction);
                break;
            case '删除轨道':
                await handleDeleteTrack(interaction);
                break;
            case '设为默认':
                await handleSetDefault(interaction);
                break;
            case '重命名':
                await handleRename(interaction);
                break;
            default:
                await interaction.editReply({
                    content: '❌ 未知的子命令。'
                });
        }
    } catch (error) {
        console.error('管理轨道时出错:', error);
        console.error('错误堆栈:', error.stack);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: `❌ 操作时出错：${error.message}`,
                    flags: MessageFlags.Ephemeral
                });
            } else {
                await interaction.editReply({
                    content: `❌ 操作时出错：${error.message}`
                });
            }
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

/**
 * 列出所有轨道
 */
async function handleListTracks(interaction) {
    const settings = await getContestSettings(interaction.guild.id);
    
    if (!settings || !settings.tracks || Object.keys(settings.tracks).length === 0) {
        return interaction.editReply({
            content: '❌ 当前服务器没有配置任何赛事轨道。\n\n请先使用 `/赛事-设置赛事申请入口` 创建轨道。'
        });
    }

    const tracks = settings.tracks;
    const defaultTrackId = settings.defaultTrackId;

    const embed = new EmbedBuilder()
        .setTitle('🏆 赛事轨道列表')
        .setColor(0x00AE86)
        .setTimestamp();

    let description = `**当前默认轨道：** \`${defaultTrackId}\`\n\n`;
    description += `**轨道总数：** ${Object.keys(tracks).length}\n\n`;
    description += '━━━━━━━━━━━━━━━━━━━━\n\n';

    for (const [trackId, track] of Object.entries(tracks)) {
        const isDefault = trackId === defaultTrackId;
        const defaultBadge = isDefault ? ' 🌟 **(默认)**' : '';
        
        description += `**轨道 ID：** \`${trackId}\`${defaultBadge}\n`;
        description += `**名称：** ${track.name}\n`;
        
        if (track.description) {
            description += `**描述：** ${track.description}\n`;
        }
        
        // 获取审批论坛和赛事分类信息
        let forumInfo = '未设置';
        let categoryInfo = '未设置';
        
        if (track.reviewForumId) {
            try {
                const forum = await interaction.client.channels.fetch(track.reviewForumId);
                forumInfo = forum ? `<#${track.reviewForumId}>` : `ID: ${track.reviewForumId} (已删除)`;
            } catch {
                forumInfo = `ID: ${track.reviewForumId} (无法访问)`;
            }
        }
        
        if (track.contestCategoryId) {
            try {
                const category = await interaction.client.channels.fetch(track.contestCategoryId);
                categoryInfo = category ? category.name : `ID: ${track.contestCategoryId} (已删除)`;
            } catch {
                categoryInfo = `ID: ${track.contestCategoryId} (无法访问)`;
            }
        }
        
        description += `**审批论坛：** ${forumInfo}\n`;
        description += `**赛事分类：** ${categoryInfo}\n`;
        description += `**许可论坛数量：** ${track.allowedForumIds?.length || 0} 个\n`;
        description += `**创建时间：** <t:${Math.floor(new Date(track.createdAt).getTime() / 1000)}:R>\n`;
        description += `**更新时间：** <t:${Math.floor(new Date(track.updatedAt).getTime() / 1000)}:R>\n`;
        description += '\n━━━━━━━━━━━━━━━━━━━━\n\n';
    }

    embed.setDescription(description);

    await interaction.editReply({ embeds: [embed] });
}

/**
 * 删除轨道
 */
async function handleDeleteTrack(interaction) {
    const trackId = interaction.options.getString('轨道id');
    
    try {
        const settings = await getContestSettings(interaction.guild.id);
        
        if (!settings || !settings.tracks) {
            return interaction.editReply({
                content: '❌ 当前服务器没有配置任何赛事轨道。'
            });
        }

        if (!settings.tracks[trackId]) {
            return interaction.editReply({
                content: `❌ 轨道 \`${trackId}\` 不存在。\n\n使用 \`/赛事-管理轨道 列出轨道\` 查看所有轨道。`
            });
        }

        // 禁止删除默认轨道
        if (settings.defaultTrackId === trackId) {
            return interaction.editReply({
                content: `❌ 无法删除当前默认轨道 \`${trackId}\`。\n\n请先使用 \`/赛事-管理轨道 设为默认\` 将其他轨道设为默认，然后再删除此轨道。`
            });
        }

        const trackName = settings.tracks[trackId].name;

        await deleteTrack(interaction.guild.id, trackId);

        await interaction.editReply({
            content: `✅ 成功删除轨道\n\n**轨道 ID：** \`${trackId}\`\n**轨道名称：** ${trackName}\n\n⚠️ 注意：与此轨道关联的申请入口按钮将无法使用，请手动删除相关消息。`
        });

        console.log(`轨道已删除 - ID: ${trackId}, 名称: ${trackName}, 操作者: ${interaction.user.tag}`);
    } catch (error) {
        console.error('删除轨道失败:', error);
        throw error;
    }
}

/**
 * 设为默认轨道
 */
async function handleSetDefault(interaction) {
    const trackId = interaction.options.getString('轨道id');
    
    try {
        const settings = await getContestSettings(interaction.guild.id);
        
        if (!settings || !settings.tracks) {
            return interaction.editReply({
                content: '❌ 当前服务器没有配置任何赛事轨道。'
            });
        }

        if (!settings.tracks[trackId]) {
            return interaction.editReply({
                content: `❌ 轨道 \`${trackId}\` 不存在。\n\n使用 \`/赛事-管理轨道 列出轨道\` 查看所有轨道。`
            });
        }

        if (settings.defaultTrackId === trackId) {
            return interaction.editReply({
                content: `ℹ️ 轨道 \`${trackId}\` 已经是默认轨道了。`
            });
        }

        const oldDefaultId = settings.defaultTrackId;
        const trackName = settings.tracks[trackId].name;

        await setDefaultTrack(interaction.guild.id, trackId);

        await interaction.editReply({
            content: `✅ 成功设置默认轨道\n\n**新默认轨道：** \`${trackId}\` (${trackName})\n**原默认轨道：** \`${oldDefaultId}\`\n\n📝 旧的 \`contest_application\` 按钮（无轨道后缀）现在将使用新的默认轨道。`
        });

        console.log(`默认轨道已更新 - 新: ${trackId}, 旧: ${oldDefaultId}, 操作者: ${interaction.user.tag}`);
    } catch (error) {
        console.error('设置默认轨道失败:', error);
        throw error;
    }
}

/**
 * 重命名轨道
 */
async function handleRename(interaction) {
    const trackId = interaction.options.getString('轨道id');
    const newName = interaction.options.getString('新名称');
    
    try {
        const settings = await getContestSettings(interaction.guild.id);
        
        if (!settings || !settings.tracks) {
            return interaction.editReply({
                content: '❌ 当前服务器没有配置任何赛事轨道。'
            });
        }

        if (!settings.tracks[trackId]) {
            return interaction.editReply({
                content: `❌ 轨道 \`${trackId}\` 不存在。\n\n使用 \`/赛事-管理轨道 列出轨道\` 查看所有轨道。`
            });
        }

        const oldName = settings.tracks[trackId].name;

        await updateTrack(interaction.guild.id, trackId, { name: newName });

        await interaction.editReply({
            content: `✅ 成功重命名轨道\n\n**轨道 ID：** \`${trackId}\`\n**原名称：** ${oldName}\n**新名称：** ${newName}`
        });

        console.log(`轨道已重命名 - ID: ${trackId}, 原名称: ${oldName}, 新名称: ${newName}, 操作者: ${interaction.user.tag}`);
    } catch (error) {
        console.error('重命名轨道失败:', error);
        throw error;
    }
}

module.exports = {
    data,
    execute,
};