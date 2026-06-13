// src/modules/contest/commands/updateContestTitle.js
const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { getContestChannel, updateContestChannel } = require('../utils/contestDatabase');
const { checkContestManagePermission, getManagePermissionDeniedMessage } = require('../utils/contestPermissions');
const { onContestTitleUpdated } = require('../services/tournamentSyncService');

const data = new SlashCommandBuilder()
    .setName('赛事-更新赛事标题')
    .setDescription('更新赛事频道的标题和名称')
    .addStringOption(option => 
        option.setName('新标题')
            .setDescription('新的赛事标题')
            .setRequired(true)
            .setMaxLength(100));

async function execute(interaction) {
    try {
        // 检查是否在服务器中使用
        if (!interaction.guild) {
            return interaction.reply({
                content: '❌ 此指令只能在服务器中使用，不能在私信中使用。',
                flags: MessageFlags.Ephemeral
            });
        }

        // 检查是否在赛事频道中使用
        const contestChannelData = await getContestChannel(interaction.channel.id);
        if (!contestChannelData) {
            return interaction.reply({
                content: '❌ 此指令只能在赛事频道中使用。',
                flags: MessageFlags.Ephemeral
            });
        }

        // 检查管理权限
        const hasPermission = checkContestManagePermission(interaction.member, contestChannelData);
        
        if (!hasPermission) {
            return interaction.reply({
                content: getManagePermissionDeniedMessage(),
                flags: MessageFlags.Ephemeral
            });
        }

        // 立即defer以防止超时
        await interaction.deferReply({ ephemeral: true });

        const newTitle = interaction.options.getString('新标题');
        
        await interaction.editReply({
            content: '⏳ 正在更新赛事标题...'
        });

        try {
            // 更新频道名称
            await interaction.channel.setName(newTitle);
            
            // 更新频道话题
            const applicantName = interaction.guild.members.cache.get(contestChannelData.applicantId)?.displayName || '未知';
            await interaction.channel.setTopic(`🏆 ${newTitle} | 申请人: ${applicantName}`);

            // 更新赛事信息消息的标题
            const infoMessage = await interaction.channel.messages.fetch(contestChannelData.contestInfo);
            
            if (infoMessage && infoMessage.embeds.length > 0) {
                const currentEmbed = infoMessage.embeds[0];
                const updatedEmbed = new EmbedBuilder()
                    .setTitle(`🏆 ${newTitle}`)
                    .setDescription(currentEmbed.description)
                    .setColor(currentEmbed.color)
                    .setFooter(currentEmbed.footer)
                    .setTimestamp();

                await infoMessage.edit({
                    embeds: [updatedEmbed]
                });
            }

            // 更新数据库中的标题
            await updateContestChannel(interaction.channel.id, {
                contestTitle: newTitle
            });
            onContestTitleUpdated(interaction.channel.id, newTitle); // 静默同步书单标题

            await interaction.editReply({
                content: `✅ 赛事标题已成功更新为：**${newTitle}**`
            });

            console.log(`赛事标题已更新 - 频道: ${interaction.channel.id}, 新标题: ${newTitle}, 操作者: ${interaction.user.tag}`);

        } catch (updateError) {
            console.error('更新赛事标题时出错:', updateError);
            
            await interaction.editReply({
                content: '❌ 更新赛事标题时出现错误，请确保机器人有管理频道的权限。'
            });
        }
        
    } catch (error) {
        console.error('更新赛事标题时出错:', error);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: `❌ 更新标题时出错：${error.message}`,
                    flags: MessageFlags.Ephemeral
                });
            } else {
                await interaction.editReply({
                    content: `❌ 更新标题时出错：${error.message}`
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