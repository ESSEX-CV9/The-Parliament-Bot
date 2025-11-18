// src/modules/contest/commands/viewSubmissions.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getContestChannel } = require('../utils/contestDatabase');
const { preprocessSubmissions, paginateData } = require('../utils/dataProcessor');
const { displayService } = require('../services/displayService');

const data = new SlashCommandBuilder()
    .setName('view-submissions')
    .setDescription('查看当前赛事频道的所有投稿作品')
    .setDescriptionLocalizations({
        'zh-CN': '查看当前赛事频道的所有投稿作品'
    })
    .setNameLocalizations({
        'zh-CN': '查看赛事稿件'
    });

async function execute(interaction) {
    try {
        // 检查是否在服务器中使用
        if (!interaction.guild) {
            return interaction.reply({
                content: '❌ 此指令只能在服务器中使用，不能在私信中使用。',
                flags: MessageFlags.Ephemeral
            });
        }

        await interaction.deferReply({ ephemeral: true });

        const channelId = interaction.channel.id;

        // 检查当前频道是否为赛事频道
        const contestChannelData = await displayService.getContestChannelData(channelId);
        
        if (!contestChannelData) {
            return interaction.editReply({
                content: '❌ 此频道不是赛事频道。\n\n💡 提示：此指令只能在赛事频道中使用。'
            });
        }

        // 检查用户权限
        const isOrganizer = contestChannelData.applicantId === interaction.user.id;

        // 获取所有有效投稿
        const submissions = await displayService.getSubmissionsData(channelId);
        const processedSubmissions = preprocessSubmissions(submissions);

        if (processedSubmissions.length === 0) {
            return interaction.editReply({
                content: '📝 当前没有任何投稿作品。'
            });
        }

        const itemsPerPage = 5; // 默认每页5个
        const paginationInfo = paginateData(processedSubmissions, 1, itemsPerPage);

        // 构建展示内容
        const embed = await displayService.buildFullDisplayEmbed(processedSubmissions, paginationInfo, itemsPerPage);

        // 根据权限构建不同的组件
        const components = displayService.buildFullDisplayComponents(
            paginationInfo.currentPage,
            paginationInfo.totalPages,
            channelId,
            itemsPerPage,
            isOrganizer,
            paginationInfo.pageData  // 传递当前页面的投稿数据
        );

        await interaction.editReply({
            embeds: [embed],
            components: components
        });

        console.log(`用户通过斜杠指令查看赛事稿件 - 频道: ${channelId}, 用户: ${interaction.user.tag}, 权限: ${isOrganizer ? '主办人' : '普通用户'}`);

    } catch (error) {
        console.error('查看赛事稿件时出错:', error);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: `❌ 查看稿件时出错：${error.message}\n请查看控制台获取详细信息。`,
                    flags: MessageFlags.Ephemeral
                });
            } else if (interaction.deferred) {
                await interaction.editReply({
                    content: `❌ 查看稿件时出错：${error.message}\n请查看控制台获取详细信息。`
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