const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const { ElectionData } = require('../data/electionDatabase');
const { MessageTrackingService } = require('../services/messageTrackingService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('扫描候选人消息')
        .setDescription('扫描并记录现有候选人简介消息ID（向后兼容功能）')
        .addStringOption(option =>
            option.setName('election_id')
                .setDescription('募选ID（可选，默认为当前活跃募选）')
                .setRequired(false))
        .addBooleanOption(option =>
            option.setName('verify_only')
                .setDescription('仅验证现有记录，不进行扫描')
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

            let electionId = interaction.options.getString('election_id');
            const verifyOnly = interaction.options.getBoolean('verify_only') || false;

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

            const messageTracker = new MessageTrackingService(interaction.client);

            if (verifyOnly) {
                // 仅验证现有记录
                try {
                    const verifyResult = await messageTracker.verifyMessageRecords(electionId);
                    
                    const embed = new EmbedBuilder()
                        .setTitle('📊 消息记录验证结果')
                        .setDescription(`验证募选 **${election.name}** 的候选人简介消息记录`)
                        .setColor('#3498db')
                        .addFields(
                            { name: '✅ 有效记录', value: verifyResult.valid.toString(), inline: true },
                            { name: '❌ 无效记录', value: verifyResult.invalid.toString(), inline: true },
                            { name: '⚠️ 缺失记录', value: verifyResult.missing.toString(), inline: true }
                        );

                    if (verifyResult.details.length > 0) {
                        const detailsText = verifyResult.details
                            .slice(0, 10) // 最多显示10条详情
                            .map(detail => {
                                const statusEmoji = {
                                    'valid': '✅',
                                    'invalid': '❌', 
                                    'missing': '⚠️',
                                    'error': '💥'
                                };
                                return `${statusEmoji[detail.status]} <@${detail.userId}>: ${detail.message || detail.status}`;
                            })
                            .join('\n');

                        embed.addFields(
                            { name: '详细信息', value: detailsText, inline: false }
                        );

                        if (verifyResult.details.length > 10) {
                            embed.addFields(
                                { name: '说明', value: `仅显示前10条记录，总共${verifyResult.details.length}条`, inline: false }
                            );
                        }
                    }

                    await interaction.editReply({ embeds: [embed] });

                } catch (error) {
                    const errorEmbed = new EmbedBuilder()
                        .setTitle('❌ 验证失败')
                        .setDescription(`验证消息记录时发生错误: ${error.message}`)
                        .setColor('#e74c3c');
                    await interaction.editReply({ embeds: [errorEmbed] });
                }

            } else {
                // 执行扫描
                const progressEmbed = new EmbedBuilder()
                    .setTitle('🔍 正在扫描')
                    .setDescription(`正在扫描募选 **${election.name}** 的候选人简介消息...`)
                    .setColor('#f39c12');
                
                await interaction.editReply({ embeds: [progressEmbed] });

                try {
                    const scanResult = await messageTracker.scanAndRecordExistingMessages(electionId);
                    
                    let resultEmbed;
                    if (scanResult.success) {
                        resultEmbed = new EmbedBuilder()
                            .setTitle('✅ 扫描完成')
                            .setDescription(scanResult.message)
                            .setColor('#2ecc71')
                            .addFields(
                                { name: '总候选人数', value: scanResult.total?.toString() || '0', inline: true },
                                { name: '找到消息数', value: scanResult.found.toString(), inline: true },
                                { name: '成功记录数', value: scanResult.recorded.toString(), inline: true }
                            );

                        if (scanResult.results && scanResult.results.length > 0) {
                            const resultsText = scanResult.results
                                .slice(0, 10) // 最多显示10条结果
                                .map(result => {
                                    const statusEmoji = {
                                        'recorded': '✅',
                                        'not_found': '❌',
                                        'error': '💥'
                                    };
                                    return `${statusEmoji[result.status]} <@${result.userId}>`;
                                })
                                .join('\n');

                            resultEmbed.addFields(
                                { name: '处理结果', value: resultsText, inline: false }
                            );

                            if (scanResult.results.length > 10) {
                                resultEmbed.addFields(
                                    { name: '说明', value: `仅显示前10条结果，总共${scanResult.results.length}条`, inline: false }
                                );
                            }
                        }

                        if (scanResult.found > 0) {
                            resultEmbed.addFields(
                                { name: '后续操作', value: '现在可以使用候选人管理功能来处理候选人状态了', inline: false }
                            );
                        }

                    } else {
                        resultEmbed = new EmbedBuilder()
                            .setTitle('❌ 扫描失败')
                            .setDescription(`扫描失败: ${scanResult.error}`)
                            .setColor('#e74c3c');
                    }

                    await interaction.editReply({ embeds: [resultEmbed] });

                } catch (error) {
                    const errorEmbed = new EmbedBuilder()
                        .setTitle('❌ 扫描失败')
                        .setDescription(`扫描候选人简介消息时发生错误: ${error.message}`)
                        .setColor('#e74c3c');
                    await interaction.editReply({ embeds: [errorEmbed] });
                }
            }

        } catch (error) {
            console.error('扫描候选人消息时出错:', error);
            
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 系统错误')
                .setDescription('执行扫描时发生错误，请稍后重试')
                .setColor('#e74c3c');

            if (interaction.deferred) {
                await interaction.editReply({ embeds: [errorEmbed] });
            } else {
                await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            }
        }
    }
}; 