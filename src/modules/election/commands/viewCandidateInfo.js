const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const { ElectionData } = require('../data/electionDatabase');
const { CandidateManagementService } = require('../services/candidateManagementService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('募选-查看候选人信息')
        .setDescription('查看指定候选人的参选情况')
        .addUserOption(option =>
            option.setName('candidate')
                .setDescription('要查看的候选人')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('election_id')
                .setDescription('募选ID（可选，默认为当前活跃募选）')
                .setRequired(false)),

    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            // 权限检查
            if (!checkAdminPermission(interaction.member)) {
                const embed = new EmbedBuilder()
                    .setColor('#ff0000')
                    .setDescription(getPermissionDeniedMessage());
                return await interaction.editReply({ embeds: [embed] });
            }

            const candidate = interaction.options.getUser('candidate');
            let electionId = interaction.options.getString('election_id');

            // 如果没有指定募选ID，获取当前活跃募选
            if (!electionId) {
                const activeElection = await ElectionData.getActiveElectionByGuild(interaction.guild.id);
                if (!activeElection) {
                    const errorEmbed = new EmbedBuilder()
                        .setTitle('❌ 错误')
                        .setDescription('当前没有活跃的募选，请指定募选ID')
                        .setColor('#e74c3c');
                    return await interaction.editReply({ embeds: [errorEmbed] });
                }
                electionId = activeElection.electionId;
            }

            // 验证募选是否存在
            const election = await ElectionData.getById(electionId);
            if (!election) {
                const errorEmbed = new EmbedBuilder()
                    .setTitle('❌ 错误')
                    .setDescription('指定的募选不存在')
                    .setColor('#e74c3c');
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            // 验证募选是否属于当前服务器
            if (election.guildId !== interaction.guild.id) {
                const errorEmbed = new EmbedBuilder()
                    .setTitle('❌ 错误')
                    .setDescription('指定的募选不属于当前服务器')
                    .setColor('#e74c3c');
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            // 获取候选人信息
            const candidateService = new CandidateManagementService(interaction.client);
            
            try {
                const candidateInfo = await candidateService.getCandidateInfo(candidate.id, electionId);
                const infoEmbed = candidateService.createCandidateInfoEmbed(candidateInfo);
                
                await interaction.editReply({ embeds: [infoEmbed] });

            } catch (error) {
                if (error.message === '该用户未报名此次募选') {
                    const errorEmbed = new EmbedBuilder()
                        .setTitle('📋 候选人信息')
                        .setDescription(`用户 ${candidate.tag} 未报名 **${election.name}**`)
                        .setColor('#95a5a6')
                        .addFields(
                            { name: '候选人', value: `<@${candidate.id}>`, inline: true },
                            { name: '参选状态', value: '❌ 未报名', inline: true }
                        );
                    return await interaction.editReply({ embeds: [errorEmbed] });
                } else {
                    throw error;
                }
            }

        } catch (error) {
            console.error('查看候选人信息时出错:', error);
            
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 系统错误')
                .setDescription('查看候选人信息时发生错误，请稍后重试')
                .setColor('#e74c3c');

            if (interaction.deferred) {
                await interaction.editReply({ embeds: [errorEmbed] });
            } else {
                await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            }
        }
    }
}; 