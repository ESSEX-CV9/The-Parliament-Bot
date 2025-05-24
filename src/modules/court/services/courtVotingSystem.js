// src/services/courtVotingSystem.js
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getCourtVote, updateCourtVote } = require('../../../core/utils/database');

async function processCourtVote(interaction) {
    try {
        // 立即回复延迟消息，防止交互超时
        await interaction.deferReply({ ephemeral: true });
        
        // 解析按钮ID
        const customId = interaction.customId;
        let voteType = '';
        let threadId = '';
        
        if (customId.startsWith('court_vote_support_')) {
            voteType = 'support';
            threadId = customId.replace('court_vote_support_', '');
        } else if (customId.startsWith('court_vote_oppose_')) {
            voteType = 'oppose';
            threadId = customId.replace('court_vote_oppose_', '');
        } else {
            return interaction.editReply({ 
                content: '无效的投票按钮。'
            });
        }
        
        console.log(`处理法庭投票: 投票类型=${voteType}, 帖子ID=${threadId}, 用户=${interaction.user.tag}`);
        
        // 从数据库获取投票数据
        const voteData = await getCourtVote(threadId);
        
        if (!voteData) {
            console.error(`在数据库中找不到投票数据: ${threadId}`);
            return interaction.editReply({ 
                content: '找不到此投票数据。'
            });
        }
        
        // 检查投票状态
        if (voteData.status !== 'active') {
            return interaction.editReply({ 
                content: '此投票已结束或被禁用。'
            });
        }
        
        // 检查投票是否已过期
        const now = new Date();
        const endTime = new Date(voteData.voteEndTime);
        
        if (now >= endTime) {
            return interaction.editReply({ 
                content: '投票时间已结束。'
            });
        }
        
        // 检查用户是否已经投票
        const userId = interaction.user.id;
        const hasSupportVoted = voteData.supportVoters.includes(userId);
        const hasOpposeVoted = voteData.opposeVoters.includes(userId);
        
        let replyContent = '';
        let needsUpdate = false;
        
        if (voteType === 'support') {
            if (hasSupportVoted) {
                // 撤销支持票
                voteData.supportVotes -= 1;
                voteData.supportVoters.splice(voteData.supportVoters.indexOf(userId), 1);
                replyContent = '您已撤销支持票！';
                needsUpdate = true;
            } else {
                // 如果之前投了反对票，先撤销
                if (hasOpposeVoted) {
                    voteData.opposeVotes -= 1;
                    voteData.opposeVoters.splice(voteData.opposeVoters.indexOf(userId), 1);
                }
                // 添加支持票
                voteData.supportVotes += 1;
                voteData.supportVoters.push(userId);
                replyContent = '您的支持票已记录！';
                needsUpdate = true;
            }
        } else if (voteType === 'oppose') {
            if (hasOpposeVoted) {
                // 撤销反对票
                voteData.opposeVotes -= 1;
                voteData.opposeVoters.splice(voteData.opposeVoters.indexOf(userId), 1);
                replyContent = '您已撤销反对票！';
                needsUpdate = true;
            } else {
                // 如果之前投了支持票，先撤销
                if (hasSupportVoted) {
                    voteData.supportVotes -= 1;
                    voteData.supportVoters.splice(voteData.supportVoters.indexOf(userId), 1);
                }
                // 添加反对票
                voteData.opposeVotes += 1;
                voteData.opposeVoters.push(userId);
                replyContent = '您的反对票已记录！';
                needsUpdate = true;
            }
        }
        
        if (needsUpdate) {
            // 更新数据库
            await updateCourtVote(threadId, {
                supportVotes: voteData.supportVotes,
                opposeVotes: voteData.opposeVotes,
                supportVoters: voteData.supportVoters,
                opposeVoters: voteData.opposeVoters
            });
            
            // 检查是否需要更新投票显示
            const publicTime = new Date(voteData.publicTime);
            if (now >= publicTime || voteData.isPublic) {
                await updateVoteDisplay(interaction, voteData, threadId);
                if (!voteData.isPublic) {
                    // 标记为已公开
                    await updateCourtVote(threadId, { isPublic: true });
                }
            }
        }
        
        // 回复用户
        await interaction.editReply({ 
            content: replyContent
        });
        
    } catch (error) {
        console.error('处理法庭投票时出错:', error);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ 
                    content: '处理您的投票时出现错误。', 
                    ephemeral: true 
                });
            } else {
                await interaction.editReply({
                    content: '处理您的投票时出现错误。'
                });
            }
        } catch (replyError) {
            console.error('回复错误:', replyError);
        }
    }
}

async function updateVoteDisplay(interaction, voteData, threadId) {
    try {
        // 获取原投票消息
        const thread = await interaction.client.channels.fetch(threadId);
        const voteMessage = await thread.messages.fetch(voteData.voteMessageId);
        
        // 计算投票百分比
        const totalVotes = voteData.supportVotes + voteData.opposeVotes;
        const supportPercentage = totalVotes > 0 ? Math.round((voteData.supportVotes / totalVotes) * 100) : 0;
        const opposePercentage = totalVotes > 0 ? Math.round((voteData.opposeVotes / totalVotes) * 100) : 0;
        
        // 获取目标用户
        const targetUser = await interaction.client.users.fetch(voteData.targetUserId).catch(() => null);
        
        // 构建处罚描述
        let punishmentDescription = '';
        if (voteData.punishmentType === 'timeout') {
            punishmentDescription = `禁言 ${voteData.timeoutDays} 天`;
            if (voteData.warningDays) {
                punishmentDescription += ` + 被警告 ${voteData.warningDays} 天`;
            }
        } else {
            punishmentDescription = '封禁';
        }
        
        // 计算投票截止时间
        const voteEndTimestamp = Math.floor(new Date(voteData.voteEndTime).getTime() / 1000);
        
        // 更新投票器嵌入
        const voteEmbed = new EmbedBuilder()
            .setTitle('议会辩诉投票')
            .setDescription(`**投票截止时间:** <t:${voteEndTimestamp}:f>\n\n` +
                           `**辩诉主题:**\n对 ${targetUser ? `<@${targetUser.id}>` : '未知用户'} 执行 ${punishmentDescription}\n\n` +
                           `**投票结果**\n` +
                           `支持处罚: **${voteData.supportVotes}** 票 (**${supportPercentage}%**)\n` +
                           `反对处罚: **${voteData.opposeVotes}** 票 (**${opposePercentage}%**)\n\n` +
                           `总投票人数: **${totalVotes}**\n\n` +
                           `**投票结果:**\n` +
                           `支持率 >= 50% 获得多数，执行惩罚`)
            .setColor('#FFD700') // 金色
            .setFooter({ 
                text: `法庭申请ID ${voteData.courtId} | 匿名投票`,
                iconURL: thread.guild.iconURL()
            })
            .setTimestamp();
        
        // 保持原投票按钮
        const voteButtons = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`court_vote_support_${threadId}`)
                    .setLabel('支持处罚')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(`court_vote_oppose_${threadId}`)
                    .setLabel('反对处罚')
                    .setStyle(ButtonStyle.Secondary)
            );
        
        // 更新投票消息
        await voteMessage.edit({
            embeds: [voteEmbed],
            components: [voteButtons]
        });
        
        console.log(`投票显示已更新: 支持=${voteData.supportVotes}, 反对=${voteData.opposeVotes}`);
        
    } catch (error) {
        console.error('更新投票显示时出错:', error);
    }
}

// 定时检查投票状态的函数
async function checkVoteStatus(client) {
    try {
        console.log('\n=== 开始检查法庭投票状态 ===');
        const now = new Date();
        
        // 这里需要获取所有投票数据，由于我们还没有getAllCourtVotes函数，先添加它
        // 暂时跳过此功能的实现，等待完善数据库函数
        
        console.log('=== 法庭投票状态检查完成 ===\n');
    } catch (error) {
        console.error('检查法庭投票状态时出错:', error);
    }
}

// 处理投票结束的函数
async function finalizeVote(client, voteData) {
    try {
        console.log(`开始结算投票: 法庭ID ${voteData.courtId}`);
        
        // 计算结果
        const totalVotes = voteData.supportVotes + voteData.opposeVotes;
        const supportPercentage = totalVotes > 0 ? (voteData.supportVotes / totalVotes) * 100 : 0;
        
        // 获取相关用户
        const targetUser = await client.users.fetch(voteData.targetUserId).catch(() => null);
        const applicant = await client.users.fetch(voteData.applicantId).catch(() => null);
        
        // 构建处罚描述
        let punishmentDescription = '';
        if (voteData.punishmentType === 'timeout') {
            punishmentDescription = `禁言 ${voteData.timeoutDays} 天`;
            if (voteData.warningDays) {
                punishmentDescription += ` + 被警告 ${voteData.warningDays} 天`;
            }
        } else {
            punishmentDescription = '封禁';
        }
        
        let resultText = '';
        let resultColor = '';
        
        // 判断投票结果
        if (totalVotes < 20) {
            // 总投票人数不足
            resultText = `**投票无效** - 总投票人数不足 (${totalVotes}/20)`;
            resultColor = '#808080'; // 灰色
        } else if (supportPercentage >= 50) {
            // 支持处罚
            resultText = `**处罚生效** - 支持率 ${supportPercentage.toFixed(1)}%`;
            resultColor = '#FF0000'; // 红色
        } else {
            // 反对处罚
            resultText = `**处罚驳回** - 支持率 ${supportPercentage.toFixed(1)}%`;
            resultColor = '#00FF00'; // 绿色
        }
        
        // 获取投票消息并更新
        const thread = await client.channels.fetch(voteData.threadId);
        const voteMessage = await thread.messages.fetch(voteData.voteMessageId);
        
        // 创建最终结果嵌入
        const finalEmbed = new EmbedBuilder()
            .setTitle('议会辩诉投票 - 结果')
            .setDescription(`**辩诉主题:**\n对 ${targetUser ? `<@${targetUser.id}>` : '未知用户'} 执行 ${punishmentDescription}\n\n` +
                           `**最终投票结果**\n` +
                           `支持处罚: **${voteData.supportVotes}** 票 (**${Math.round((voteData.supportVotes / totalVotes) * 100) || 0}%**)\n` +
                           `反对处罚: **${voteData.opposeVotes}** 票 (**${Math.round((voteData.opposeVotes / totalVotes) * 100) || 0}%**)\n\n` +
                           `总投票人数: **${totalVotes}**\n\n` +
                           resultText)
            .setColor(resultColor)
            .setFooter({ 
                text: `法庭申请ID ${voteData.courtId} | 投票已结束`,
                iconURL: thread.guild.iconURL()
            })
            .setTimestamp();
        
        // 禁用投票按钮
        const disabledButtons = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`court_vote_ended_support`)
                    .setLabel('支持处罚')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId(`court_vote_ended_oppose`)
                    .setLabel('反对处罚')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true)
            );
        
        // 更新投票消息
        await voteMessage.edit({
            embeds: [finalEmbed],
            components: [disabledButtons]
        });
        
        // 更新数据库状态
        await updateCourtVote(voteData.threadId, {
            status: 'completed',
            finalResult: {
                totalVotes: totalVotes,
                supportVotes: voteData.supportVotes,
                opposeVotes: voteData.opposeVotes,
                supportPercentage: supportPercentage,
                resultType: totalVotes < 20 ? 'invalid' : (supportPercentage >= 50 ? 'approved' : 'rejected'),
                completedAt: new Date().toISOString()
            }
        });
        
        console.log(`投票结算完成: 法庭ID ${voteData.courtId}, 结果: ${resultText}`);
        
        // TODO: 这里可以添加实际执行处罚的逻辑
        // 例如：如果结果是 'approved'，则执行相应的禁言或封禁操作
        
    } catch (error) {
        console.error('结算投票时出错:', error);
    }
}

module.exports = {
    processCourtVote,
    updateVoteDisplay,
    checkVoteStatus,
    finalizeVote
};