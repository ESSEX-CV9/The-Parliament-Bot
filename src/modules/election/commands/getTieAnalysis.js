const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { ElectionData } = require('../data/electionDatabase');
const { calculateElectionResults } = require('../services/electionResultService');
const { createTieAnalysisEmbed, createErrorEmbed } = require('../utils/messageUtils');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('募选-并列情况分析')
        .setDescription('查看募选中的并列情况分析报告')
        .addStringOption(option =>
            option.setName('election_id')
                .setDescription('募选ID（可选，不填则显示最新募选）')
                .setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        try {
            await interaction.deferReply();

            let electionId = interaction.options.getString('election_id');
            let election;

            if (electionId) {
                // 使用指定的募选ID
                election = await ElectionData.getById(electionId);
                if (!election) {
                    return await interaction.editReply({
                        embeds: [createErrorEmbed('募选不存在', '请检查募选ID是否正确')]
                    });
                }
            } else {
                // 修复：使用 getByGuild 而不是 getAll，避免对象转数组的问题
                const guildId = interaction.guild.id;
                const allElections = await ElectionData.getByGuild(guildId);
                
                if (allElections.length === 0) {
                    return await interaction.editReply({
                        embeds: [createErrorEmbed('无募选数据', '当前服务器没有任何募选记录')]
                    });
                }
                
                // 获取最新的募选（按创建时间排序）
                election = allElections.sort((a, b) => 
                    new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
                )[0];
                electionId = election.electionId;
            }

            // 检查募选状态
            if (election.status !== 'completed') {
                return await interaction.editReply({
                    embeds: [createErrorEmbed('募选未完成', '只能查看已完成募选的并列分析')]
                });
            }

            // 计算选举结果（包含并列分析）
            const results = await calculateElectionResults(electionId);

            // 创建并列分析嵌入消息
            const embed = createTieAnalysisEmbed(election, results);

            await interaction.editReply({
                embeds: [embed]
            });

        } catch (error) {
            console.error('查看并列分析时出错:', error);
            
            const errorEmbed = createErrorEmbed(
                '系统错误',
                '查看并列分析时发生错误，请稍后重试'
            );

            if (interaction.deferred) {
                await interaction.editReply({ embeds: [errorEmbed] });
            } else {
                await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            }
        }
    }
}; 