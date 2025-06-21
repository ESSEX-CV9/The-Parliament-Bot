const { SlashCommandBuilder } = require('discord.js');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const { ElectionData } = require('../data/electionDatabase');
const VoteManagementService = require('../services/voteManagementService');
const { createErrorEmbed, createSuccessEmbed } = require('../utils/messageUtils');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('清除募选投票')
        .setDescription('清除指定用户的募选投票（仅管理员可用）')
        .addUserOption(option =>
            option.setName('用户')
                .setDescription('要清除投票的用户')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('voteid')
                .setDescription('特定投票ID（可选，不填则清除该用户在当前选举中的所有投票）')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('electionid')
                .setDescription('特定选举ID（可选，不填则使用当前活跃选举）')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('原因')
                .setDescription('清除投票的原因（可选）')
                .setRequired(false)),

    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            // 权限检查
            if (!checkAdminPermission(interaction.member)) {
                const errorEmbed = createErrorEmbed('权限不足', getPermissionDeniedMessage());
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            const targetUser = interaction.options.getUser('用户');
            const voteId = interaction.options.getString('voteid');
            const electionId = interaction.options.getString('electionid');
            const reason = interaction.options.getString('原因');

            const voteService = new VoteManagementService();

            // 确定目标选举
            let targetElection;
            if (electionId) {
                targetElection = await ElectionData.getById(electionId);
                if (!targetElection) {
                    const errorEmbed = createErrorEmbed('选举不存在', `找不到ID为 ${electionId} 的选举`);
                    return await interaction.editReply({ embeds: [errorEmbed] });
                }
            } else {
                // 使用当前活跃选举
                targetElection = await ElectionData.getActiveElectionByGuild(interaction.guild.id);
                if (!targetElection) {
                    const errorEmbed = createErrorEmbed('未找到活跃选举', '当前没有活跃的选举，请指定具体的选举ID');
                    return await interaction.editReply({ embeds: [errorEmbed] });
                }
            }

            // 检查选举状态
            if (!voteService.canModifyVotes(targetElection.status)) {
                const errorEmbed = createErrorEmbed(
                    '选举状态不允许',
                    `选举 "${targetElection.name}" 的状态为 ${targetElection.status}，只有在投票阶段才能清除投票`
                );
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            // 获取用户投票信息
            const userVotingInfo = await voteService.getUserVotingInfo(targetElection.electionId, targetUser.id);
            if (!userVotingInfo.success) {
                const errorEmbed = createErrorEmbed('获取投票信息失败', userVotingInfo.message);
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            if (userVotingInfo.data.votesCount === 0) {
                const errorEmbed = createErrorEmbed(
                    '用户未投票',
                    `用户 ${targetUser.tag} 未在选举 "${targetElection.name}" 中投票`
                );
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            // 显示用户投票信息，让管理员确认
            const confirmEmbed = createConfirmationEmbed(targetUser, targetElection, userVotingInfo.data);
            
            const confirmMessage = await interaction.editReply({ 
                embeds: [confirmEmbed],
                components: [createConfirmationButtons()]
            });

            // 等待用户确认
            const filter = (i) => i.user.id === interaction.user.id;
            try {
                const confirmation = await confirmMessage.awaitMessageComponent({ 
                    filter, 
                    time: 60000 // 60秒超时
                });

                if (confirmation.customId === 'confirm_clear_votes') {
                    await confirmation.deferUpdate();

                    // 执行清除操作
                    let result;
                    if (voteId) {
                        // 清除特定投票
                        result = await voteService.clearUserVote(voteId, targetUser.id, interaction.member, reason);
                    } else {
                        // 清除所有投票
                        result = await voteService.clearUserVotesInElection(targetElection.electionId, targetUser.id, interaction.member, reason);
                    }

                    if (result.success) {
                        const successEmbed = createSuccessEmbed('清除投票成功', result.message);
                        
                        // 添加详细信息
                        if (result.data.removedVotes && result.data.removedVotes.length > 0) {
                            let votesInfo = '';
                            for (const vote of result.data.removedVotes) {
                                const candidateNames = vote.candidates.map(c => c.displayName).join(', ');
                                votesInfo += `• ${vote.positionName}: ${candidateNames}\n`;
                            }
                            successEmbed.addFields(
                                { name: '清除的投票详情', value: votesInfo, inline: false }
                            );
                        }

                        if (reason) {
                            successEmbed.addFields(
                                { name: '操作原因', value: reason, inline: false }
                            );
                        }

                        await interaction.editReply({ 
                            embeds: [successEmbed], 
                            components: [] 
                        });
                    } else {
                        const errorEmbed = createErrorEmbed('清除投票失败', result.message);
                        await interaction.editReply({ 
                            embeds: [errorEmbed], 
                            components: [] 
                        });
                    }
                } else {
                    // 用户取消操作
                    const cancelEmbed = createErrorEmbed('操作已取消', '投票清除操作已取消');
                    await confirmation.update({ 
                        embeds: [cancelEmbed], 
                        components: [] 
                    });
                }
            } catch (error) {
                // 超时处理
                const timeoutEmbed = createErrorEmbed('操作超时', '确认操作已超时，投票清除操作已取消');
                await interaction.editReply({ 
                    embeds: [timeoutEmbed], 
                    components: [] 
                });
            }

        } catch (error) {
            console.error('清除募选投票时出错:', error);
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
 * 创建确认嵌入消息
 */
function createConfirmationEmbed(targetUser, election, votingData) {
    const { EmbedBuilder } = require('discord.js');
    
    const embed = new EmbedBuilder()
        .setTitle('⚠️ 确认清除投票')
        .setDescription(`您即将清除用户 ${targetUser.tag} 在选举 "${election.name}" 中的投票`)
        .setColor('#f39c12')
        .addFields(
            { name: '选举信息', value: `**名称**: ${election.name}\n**状态**: ${election.status}\n**ID**: ${election.electionId}`, inline: false }
        );

    if (votingData.votes && votingData.votes.length > 0) {
        let votesInfo = '';
        for (const vote of votingData.votes) {
            const candidateNames = vote.candidates.map(c => c.displayName).join(', ');
            votesInfo += `• **${vote.positionName}**: ${candidateNames}\n`;
        }
        embed.addFields(
            { name: '用户的投票', value: votesInfo, inline: false }
        );
    }

    embed.addFields(
        { name: '⚠️ 警告', value: '此操作不可撤销，请谨慎操作！', inline: false }
    );

    return embed;
}

/**
 * 创建确认按钮
 */
function createConfirmationButtons() {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    
    return new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('confirm_clear_votes')
                .setLabel('确认清除')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🗑️'),
            new ButtonBuilder()
                .setCustomId('cancel_clear_votes')
                .setLabel('取消操作')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('❌')
        );
} 