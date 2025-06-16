const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { ElectionData, VoteData } = require('../data/electionDatabase');
const { validatePermission } = require('../utils/validationUtils');
const { createErrorEmbed, createSuccessEmbed, createElectionResultEmbed } = require('../utils/messageUtils');
const { calculateElectionResults } = require('../services/electionResultService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('重新处理选举结果')
        .setDescription('手动重新计算和发布最近一次选举的结果')
        .addStringOption(option =>
            option.setName('选举id')
                .setDescription('指定要重新处理的选举ID（可选，默认使用最近的已完成选举）')
                .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            // 验证权限
            if (!validatePermission(interaction.member, [])) {
                const errorEmbed = createErrorEmbed('权限不足', '只有管理员可以重新处理选举结果');
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            const guildId = interaction.guild.id;
            const specifiedElectionId = interaction.options.getString('选举id');

            let election;

            // 获取要处理的选举
            if (specifiedElectionId) {
                // 使用指定的选举ID
                election = await ElectionData.getById(specifiedElectionId);
                if (!election) {
                    const errorEmbed = createErrorEmbed('选举不存在', `找不到ID为 ${specifiedElectionId} 的选举`);
                    return await interaction.editReply({ embeds: [errorEmbed] });
                }
                if (election.guildId !== guildId) {
                    const errorEmbed = createErrorEmbed('权限不足', '不能处理其他服务器的选举');
                    return await interaction.editReply({ embeds: [errorEmbed] });
                }
            } else {
                // 查找最近的已完成选举
                election = await findLatestCompletedElection(guildId);
                if (!election) {
                    const errorEmbed = createErrorEmbed('未找到选举', '没有找到可以重新处理的已完成选举');
                    return await interaction.editReply({ embeds: [errorEmbed] });
                }
            }

            // 检验选举状态
            if (election.status !== 'completed' && election.status !== 'voting') {
                const errorEmbed = createErrorEmbed(
                    '无法处理', 
                    `只能重新处理已完成或投票中的选举。当前状态：${election.status}`
                );
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            // 开始重新处理
            await interaction.editReply({
                embeds: [createSuccessEmbed(
                    '开始重新处理', 
                    `正在重新计算选举"${election.name}"的结果...`
                )]
            });

            // 重新计算结果
            console.log(`手动重新处理选举结果: ${election.name} (${election.electionId})`);
            const results = await calculateElectionResults(election.electionId);

            // 更新选举状态和结果
            await ElectionData.update(election.electionId, {
                status: 'completed',
                results: results,
                lastResultUpdate: new Date().toISOString()
            });

            // 重新发布结果
            await republishElectionResults(interaction.client, election, results);

            // 发送成功消息
            const successEmbed = createSuccessEmbed(
                '重新处理完成',
                `已成功重新计算并发布选举"${election.name}"的结果。\n\n` +
                `选举ID: ${election.electionId}\n` +
                `处理时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
            );

            successEmbed.addFields(
                { name: '📊 结果摘要', value: generateResultSummary(results), inline: false }
            );

            await interaction.editReply({ embeds: [successEmbed] });

        } catch (error) {
            console.error('重新处理选举结果时出错:', error);
            const errorEmbed = createErrorEmbed(
                '处理失败', 
                `重新处理选举结果时发生错误：${error.message}`
            );
            
            if (interaction.deferred) {
                await interaction.editReply({ embeds: [errorEmbed] });
            } else {
                await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            }
        }
    }
};

/**
 * 查找最近的已完成选举
 * @param {string} guildId - 服务器ID
 * @returns {object|null} 最近的已完成选举
 */
async function findLatestCompletedElection(guildId) {
    try {
        const allElections = await ElectionData.getByGuild(guildId);
        
        // 筛选已完成的选举
        const completedElections = allElections.filter(election => 
            election.status === 'completed' || election.status === 'voting'
        );

        if (completedElections.length === 0) {
            return null;
        }

        // 按创建时间排序，返回最新的
        completedElections.sort((a, b) => {
            const timeA = new Date(a.createdAt || 0);
            const timeB = new Date(b.createdAt || 0);
            return timeB.getTime() - timeA.getTime();
        });

        return completedElections[0];
    } catch (error) {
        console.error('查找最近的已完成选举时出错:', error);
        return null;
    }
}

/**
 * 重新发布选举结果
 * @param {Client} client - Discord客户端
 * @param {object} election - 选举数据
 * @param {object} results - 选举结果
 */
async function republishElectionResults(client, election, results) {
    try {
        const channelId = election.channels?.votingChannelId;
        if (!channelId) {
            console.log('未设置投票频道，跳过结果发布');
            return;
        }

        const channel = client.channels.cache.get(channelId);
        if (!channel) {
            console.error(`找不到投票频道: ${channelId}`);
            return;
        }

        const resultEmbed = createElectionResultEmbed(election, results);
        
        // 获取通知权限配置
        const { ElectionPermissions } = require('../data/electionDatabase');
        const permissions = await ElectionPermissions.getByGuild(election.guildId);
        const notificationRole = permissions.notificationRoles?.voting;

        let content = `🔄 **${election.name}** 选举结果已重新计算并更新！`;
        if (notificationRole) {
            content += `\n<@&${notificationRole}>`;
        }
        
        const allowedMentions = {};
        if (notificationRole) {
            allowedMentions.roles = [notificationRole];
        } else {
            allowedMentions.parse = [];
        }
        
        await channel.send({
            content: content,
            embeds: [resultEmbed],
            allowedMentions: allowedMentions
        });

        console.log(`已重新发布选举结果: ${election.name}`);

    } catch (error) {
        console.error('重新发布选举结果时出错:', error);
    }
}

/**
 * 生成结果摘要
 * @param {object} results - 选举结果
 * @returns {string} 结果摘要文本
 */
function generateResultSummary(results) {
    const summary = [];
    
    // 添加安全检查
    if (!results || typeof results !== 'object') {
        return '结果数据无效';
    }
    
    for (const [positionId, result] of Object.entries(results)) {
        // 跳过元数据字段（如 _tieAnalysis）
        if (positionId.startsWith('_')) {
            continue;
        }
        
        // 添加安全检查
        if (!result || typeof result !== 'object') {
            summary.push(`• 职位 ${positionId}: 数据无效`);
            continue;
        }
        
        if (result.isVoid) {
            const positionName = result.position?.name || `职位${positionId}`;
            const voidReason = result.voidReason || '未知原因';
            summary.push(`• ${positionName}: 募选作废 (${voidReason})`);
        } else {
            const positionName = result.position?.name || `职位${positionId}`;
            
            // 安全地获取获胜者列表
            const candidates = result.candidates || [];
            const winners = candidates.filter(c => {
                if (!c) return false;
                return c.isWinner || 
                       (c.statusInfo && [
                           'confirmed_winner', 
                           'conditional_winner', 
                           'tied_pending'
                       ].includes(c.statusInfo.status));
            });
            
            const tieCount = result.tieAnalysis?.tieGroups?.length || 0;
            
            let line = `• ${positionName}: ${winners.length}人当选`;
            if (tieCount > 0) {
                line += ` (${tieCount}组并列)`;
            }
            summary.push(line);
        }
    }
    
    return summary.length > 0 ? summary.join('\n') : '暂无有效结果';
} 