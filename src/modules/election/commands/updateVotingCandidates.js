const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { ElectionData, VoteData, RegistrationData } = require('../data/electionDatabase');
const { updateVotingPollCandidates } = require('../services/votingService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('更新投票候选人')
        .setDescription('手动更新投票器中的候选人名单（管理员专用）')
        .addStringOption(option =>
            option.setName('选举id')
                .setDescription('要更新的选举ID（留空则使用当前活跃选举）')
                .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            const guildId = interaction.guild.id;
            const specifiedElectionId = interaction.options.getString('选举id');

            // 获取要更新的选举
            let election;
            if (specifiedElectionId) {
                election = await ElectionData.getById(specifiedElectionId);
                if (!election) {
                    return await interaction.editReply({
                        content: '❌ 未找到指定的选举ID'
                    });
                }
                if (election.guildId !== guildId) {
                    return await interaction.editReply({
                        content: '❌ 该选举不属于当前服务器'
                    });
                }
            } else {
                election = await ElectionData.getActiveElectionByGuild(guildId);
                if (!election) {
                    return await interaction.editReply({
                        content: '❌ 当前没有活跃的选举'
                    });
                }
            }

            // 检查选举状态 - 只有在投票阶段才能更新候选人
            if (election.status !== 'voting') {
                return await interaction.editReply({
                    content: `❌ 只有在投票阶段才能更新候选人名单\n当前选举状态：${getStatusDisplayName(election.status)}`
                });
            }

            // 获取当前的投票器数据
            const votes = await VoteData.getByElection(election.electionId);
            if (votes.length === 0) {
                return await interaction.editReply({
                    content: '❌ 该选举没有投票器'
                });
            }

            // 获取最新的报名数据
            const registrations = await RegistrationData.getByElection(election.electionId);
            if (registrations.length === 0) {
                return await interaction.editReply({
                    content: '❌ 该选举没有候选人报名'
                });
            }

            // 更新每个职位的投票器
            const updateResults = [];
            let totalNewCandidates = 0;
            let totalUpdatedPolls = 0;

            for (const vote of votes) {
                const result = await updateVotingPollCandidates(
                    interaction.client,
                    election,
                    vote,
                    registrations
                );
                
                updateResults.push(result);
                totalNewCandidates += result.newCandidatesCount;
                if (result.updated) {
                    totalUpdatedPolls++;
                }
            }

            // 生成结果报告
            const embed = new EmbedBuilder()
                .setTitle('📊 投票器候选人更新完成')
                .setColor(totalNewCandidates > 0 ? '#00ff00' : '#ffa500')
                .addFields(
                    { name: '选举名称', value: election.name, inline: false },
                    { name: '更新统计', value: `总共更新了 ${totalUpdatedPolls} 个投票器\n新增候选人 ${totalNewCandidates} 人`, inline: false }
                );

            // 添加详细结果
            let detailsText = '';
            for (const result of updateResults) {
                const status = result.updated ? 
                    (result.newCandidatesCount > 0 ? `✅ 新增${result.newCandidatesCount}人` : '✅ 无变化') : 
                    '❌ 更新失败';
                detailsText += `**${result.positionName}**: ${status}\n`;
                
                if (result.newCandidates.length > 0) {
                    const newNames = result.newCandidates.map(c => c.displayName).join(', ');
                    detailsText += `　新增: ${newNames}\n`;
                }
                
                if (result.error) {
                    detailsText += `　错误: ${result.error}\n`;
                }
                detailsText += '\n';
            }

            if (detailsText) {
                embed.addFields({ name: '详细结果', value: detailsText, inline: false });
            }

            // 添加使用提示
            if (totalNewCandidates > 0) {
                embed.addFields({ 
                    name: '💡 提示', 
                    value: '投票器已更新，用户现在可以为新增的候选人投票了', 
                    inline: false 
                });
            }

            embed.setTimestamp();

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('更新投票候选人时出错:', error);
            
            const errorMessage = error.message || '未知错误';
            await interaction.editReply({
                content: `❌ 更新投票候选人时出错：${errorMessage}`
            }).catch(console.error);
        }
    }
};

/**
 * 获取状态的显示名称
 */
function getStatusDisplayName(status) {
    const statusNames = {
        'setup': '设置中',
        'registration': '报名中',
        'registration_ended': '报名已结束',
        'voting': '投票中',
        'completed': '已完成'
    };
    return statusNames[status] || status;
} 