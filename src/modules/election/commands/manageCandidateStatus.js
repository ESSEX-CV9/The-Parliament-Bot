const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const { ElectionData } = require('../data/electionDatabase');
const { CandidateManagementService } = require('../services/candidateManagementService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('募选-管理候选人状态')
        .setDescription('管理候选人参选资格（打回或撤销）')
        .addUserOption(option =>
            option.setName('candidate')
                .setDescription('要管理的候选人')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('action')
                .setDescription('执行的操作')
                .setRequired(true)
                .addChoices(
                    { name: '打回报名（候选人可申诉）', value: 'reject' },
                    { name: '撤销资格（不可申诉）', value: 'revoke' }
                ))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('操作原因')
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
            const action = interaction.options.getString('action');
            const reason = interaction.options.getString('reason');
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

            // 执行候选人管理操作
            const candidateService = new CandidateManagementService(interaction.client);
            
            try {
                let result;
                if (action === 'reject') {
                    result = await candidateService.rejectCandidate(
                        candidate.id, 
                        electionId, 
                        reason, 
                        interaction.user.id
                    );
                } else if (action === 'revoke') {
                    result = await candidateService.revokeCandidate(
                        candidate.id, 
                        electionId, 
                        reason, 
                        interaction.user.id
                    );
                }

                const actionName = action === 'reject' ? '打回' : '撤销';
                const statusEmoji = action === 'reject' ? '✅' : '✅';

                const successEmbed = new EmbedBuilder()
                    .setTitle(`${statusEmoji} 操作成功`)
                    .setDescription(`已成功${actionName}候选人 ${candidate.tag} 的参选资格`)
                    .setColor(action === 'reject' ? '#f39c12' : '#e74c3c')
                    .addFields(
                        { name: '候选人', value: `<@${candidate.id}>`, inline: true },
                        { name: '操作类型', value: actionName, inline: true },
                        { name: '操作人', value: `<@${interaction.user.id}>`, inline: true },
                        { name: '操作原因', value: reason, inline: false },
                        { name: '募选', value: election.name, inline: true },
                        { name: '操作时间', value: `<t:${Math.floor(Date.now() / 1000)}:f>`, inline: true }
                    );

                if (action === 'reject') {
                    successEmbed.addFields(
                        { name: '后续处理', value: '候选人将收到私信通知，可选择修改报名或放弃参选', inline: false }
                    );
                } else {
                    successEmbed.addFields(
                        { name: '后续处理', value: '候选人将收到私信通知，资格已永久撤销', inline: false }
                    );
                }

                // 如果简介消息已更新，添加提示
                if (result.registration.introductionMessageId) {
                    successEmbed.addFields(
                        { name: '消息更新', value: '✅ 候选人简介消息已自动更新状态', inline: false }
                    );
                } else {
                    successEmbed.addFields(
                        { name: '消息更新', value: '⚠️ 未找到候选人简介消息，可能需要手动处理', inline: false }
                    );
                }

                await interaction.editReply({ embeds: [successEmbed] });

            } catch (error) {
                if (error.message === '该用户未报名此次募选') {
                    const errorEmbed = new EmbedBuilder()
                        .setTitle('❌ 操作失败')
                        .setDescription(`用户 ${candidate.tag} 未报名 **${election.name}**，无法执行此操作`)
                        .setColor('#e74c3c');
                    return await interaction.editReply({ embeds: [errorEmbed] });
                } else if (error.message.includes('候选人当前状态为')) {
                    const errorEmbed = new EmbedBuilder()
                        .setTitle('❌ 操作失败')
                        .setDescription(error.message)
                        .setColor('#e74c3c');
                    return await interaction.editReply({ embeds: [errorEmbed] });
                } else {
                    throw error;
                }
            }

        } catch (error) {
            console.error('管理候选人状态时出错:', error);
            
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 系统错误')
                .setDescription('管理候选人状态时发生错误，请稍后重试')
                .setColor('#e74c3c');

            if (interaction.deferred) {
                await interaction.editReply({ embeds: [errorEmbed] });
            } else {
                await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            }
        }
    }
}; 