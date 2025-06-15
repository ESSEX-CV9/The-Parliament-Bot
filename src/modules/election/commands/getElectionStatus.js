const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { ElectionData, RegistrationData, VoteData } = require('../data/electionDatabase');
const { validatePermission } = require('../utils/validationUtils');
const { createElectionStatusEmbed, createErrorEmbed } = require('../utils/messageUtils');
const { getElectionStatistics } = require('../services/electionResultService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('查看募选状态')
        .setDescription('查看当前募选的状态和统计信息')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            // 验证权限
            if (!validatePermission(interaction.member, [])) {
                const errorEmbed = createErrorEmbed('权限不足', '只有管理员可以查看募选状态');
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            const guildId = interaction.guild.id;

            // 获取当前活跃的募选
            const election = await ElectionData.getActiveElectionByGuild(guildId);
            if (!election) {
                const errorEmbed = createErrorEmbed('未找到募选', '当前没有活跃的募选，请先使用 `/设置募选职位` 创建募选');
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            // 创建基本状态嵌入
            const statusEmbed = createElectionStatusEmbed(election);
            
            // 获取统计信息
            let statisticsText = '';
            try {
                const stats = await getElectionStatistics(election.electionId);
                
                // 报名统计
                statisticsText += `**📊 报名统计**\n`;
                statisticsText += `总报名人数: ${stats.registration.total}人\n\n`;
                
                if (stats.registration.total > 0) {
                    for (const [positionId, positionStats] of Object.entries(stats.registration.byPosition)) {
                        statisticsText += `**${positionStats.positionName}**\n`;
                        statisticsText += `• 第一志愿: ${positionStats.firstChoice}人\n`;
                        statisticsText += `• 第二志愿: ${positionStats.secondChoice}人\n`;
                        statisticsText += `• 总计: ${positionStats.total}人\n\n`;
                    }
                }

                // 投票统计（如果有）
                if (election.status === 'voting' || election.status === 'completed') {
                    statisticsText += `**🗳️ 投票统计**\n`;
                    statisticsText += `总投票人数: ${stats.voting.totalVoters}人\n\n`;
                    
                    for (const [positionId, votingStats] of Object.entries(stats.voting.byPosition)) {
                        statisticsText += `**${votingStats.positionName}**\n`;
                        statisticsText += `• 投票人数: ${votingStats.voterCount}人\n`;
                        statisticsText += `• 候选人数: ${votingStats.candidateCount}人\n\n`;
                    }
                }

            } catch (statsError) {
                console.error('获取统计信息失败:', statsError);
                statisticsText = '统计信息获取失败';
            }

            // 添加统计信息到嵌入
            if (statisticsText) {
                statusEmbed.addFields(
                    { name: '详细统计', value: statisticsText, inline: false }
                );
            }

            // 添加操作建议
            let suggestions = '';
            switch (election.status) {
                case 'setup':
                    if (!election.positions || Object.keys(election.positions).length === 0) {
                        suggestions += '• 使用 `/设置募选职位` 设置竞选职位\n';
                    }
                    if (!election.schedule || !election.schedule.registrationStartTime) {
                        suggestions += '• 使用 `/设置募选时间安排` 设置时间安排\n';
                    }
                    if (!election.messageIds?.registrationEntryMessageId) {
                        suggestions += '• 使用 `/设置报名入口` 创建报名入口\n';
                    }
                    break;
                case 'registration':
                    suggestions += '• 报名进行中，用户可以点击报名按钮参与\n';
                    suggestions += '• 报名结束后将自动开始投票阶段\n';
                    break;
                case 'voting':
                    suggestions += '• 投票进行中，用户可以为候选人投票\n';
                    suggestions += '• 投票结束后将自动计算和公布结果\n';
                    break;
                case 'completed':
                    suggestions += '• 募选已完成，结果已公布\n';
                    suggestions += '• 可以创建新的募选\n';
                    break;
            }

            if (suggestions) {
                statusEmbed.addFields(
                    { name: '💡 操作建议', value: suggestions, inline: false }
                );
            }

            // 添加配置检查
            const configIssues = checkElectionConfiguration(election);
            if (configIssues.length > 0) {
                statusEmbed.addFields(
                    { name: '⚠️ 配置问题', value: configIssues.join('\n'), inline: false }
                );
                statusEmbed.setColor('#f39c12'); // 橙色警告
            }

            await interaction.editReply({ embeds: [statusEmbed] });

        } catch (error) {
            console.error('查看募选状态时出错:', error);
            const errorEmbed = createErrorEmbed('系统错误', '处理命令时发生错误，请稍后重试');
            
            if (interaction.deferred) {
                await interaction.editReply({ embeds: [errorEmbed] });
            } else {
                await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            }
        }
    }
};

/**
 * 检查募选配置是否完整
 * @param {object} election - 募选数据
 * @returns {Array} 配置问题列表
 */
function checkElectionConfiguration(election) {
    const issues = [];

    // 检查职位配置
    if (!election.positions || Object.keys(election.positions).length === 0) {
        issues.push('• 未设置募选职位');
    }

    // 检查时间安排
    if (!election.schedule) {
        issues.push('• 未设置时间安排');
    } else {
        const { registrationStartTime, registrationEndTime, votingStartTime, votingEndTime } = election.schedule;
        
        if (!registrationStartTime || !registrationEndTime || !votingStartTime || !votingEndTime) {
            issues.push('• 时间安排不完整');
        } else {
            const now = new Date();
            const regStart = new Date(registrationStartTime);
            const regEnd = new Date(registrationEndTime);
            const voteStart = new Date(votingStartTime);
            const voteEnd = new Date(votingEndTime);

            if (regStart >= regEnd) {
                issues.push('• 报名开始时间不能晚于结束时间');
            }
            if (voteStart >= voteEnd) {
                issues.push('• 投票开始时间不能晚于结束时间');
            }
            if (regEnd > voteStart) {
                issues.push('• 报名结束时间不能晚于投票开始时间');
            }
            if (voteEnd <= now && election.status !== 'completed') {
                issues.push('• 投票结束时间已过，但募选状态未更新');
            }
        }
    }

    // 检查频道配置
    if (!election.channels?.registrationChannelId) {
        issues.push('• 未设置报名频道');
    }

    // 检查报名入口
    if (!election.messageIds?.registrationEntryMessageId && election.status !== 'setup') {
        issues.push('• 未创建报名入口消息');
    }

    return issues;
} 