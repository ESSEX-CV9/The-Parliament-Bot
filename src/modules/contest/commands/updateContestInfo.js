// src/modules/contest/commands/updateContestInfo.js
const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { getContestChannel } = require('../utils/contestDatabase');
const { checkContestManagePermission, getManagePermissionDeniedMessage } = require('../utils/contestPermissions');

const data = new SlashCommandBuilder()
    .setName('更新赛事信息')
    .setDescription('更新赛事频道的详细信息')
    .addStringOption(option => 
        option.setName('新内容')
            .setDescription('新的赛事信息内容')
            .setRequired(true)
            .setMaxLength(4000));

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

        const newContent = interaction.options.getString('新内容');
        
        await interaction.editReply({
            content: '⏳ 正在更新赛事信息...'
        });

        try {
            // 获取赛事信息消息
            const infoMessage = await interaction.channel.messages.fetch(contestChannelData.contestInfo);
            
            if (!infoMessage) {
                return interaction.editReply({
                    content: '❌ 找不到赛事信息消息，可能已被删除。'
                });
            }

            // 更新嵌入消息
            const updatedEmbed = new EmbedBuilder()
                .setTitle(`🏆 ${contestChannelData.contestTitle}`)
                .setDescription(newContent)
                .setColor('#FFD700')
                .setFooter({ 
                    text: `申请人: ${interaction.guild.members.cache.get(contestChannelData.applicantId)?.displayName || '未知'} | 最后更新`,
                    iconURL: interaction.guild.members.cache.get(contestChannelData.applicantId)?.displayAvatarURL()
                })
                .setTimestamp();

            await infoMessage.edit({
                embeds: [updatedEmbed]
            });

            await interaction.editReply({
                content: '✅ 赛事信息已成功更新！'
            });

            console.log(`赛事信息已更新 - 频道: ${interaction.channel.id}, 操作者: ${interaction.user.tag}`);

        } catch (messageError) {
            console.error('更新赛事信息消息时出错:', messageError);
            
            await interaction.editReply({
                content: '❌ 更新赛事信息时出现错误，请确保信息消息存在且机器人有权限编辑。'
            });
        }
        
    } catch (error) {
        console.error('更新赛事信息时出错:', error);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: `❌ 更新信息时出错：${error.message}`,
                    flags: MessageFlags.Ephemeral
                });
            } else {
                await interaction.editReply({
                    content: `❌ 更新信息时出错：${error.message}`
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