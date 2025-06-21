const { SlashCommandBuilder } = require('discord.js');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const { readVoteRemovalLogs } = require('../utils/voteLogger');
const { createErrorEmbed } = require('../utils/messageUtils');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('查看投票清除日志')
        .setDescription('查看投票清除操作的日志记录（仅管理员可用）')
        .addIntegerOption(option =>
            option.setName('行数')
                .setDescription('要查看的日志行数（默认50行，最大200行）')
                .setRequired(false)
                .setMinValue(10)
                .setMaxValue(200)),

    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            // 权限检查
            if (!checkAdminPermission(interaction.member)) {
                const errorEmbed = createErrorEmbed('权限不足', getPermissionDeniedMessage());
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            const lines = interaction.options.getInteger('行数') || 50;

            // 读取日志
            const logContent = await readVoteRemovalLogs(lines);

            // 创建响应
            const { EmbedBuilder } = require('discord.js');
            const embed = new EmbedBuilder()
                .setTitle('📋 投票清除日志')
                .setDescription(`显示最近 ${lines} 行日志记录`)
                .setColor('#3498db')
                .setTimestamp();

            // 如果日志内容过长，需要分段发送
            if (logContent.length > 4000) {
                // 将日志分成多个部分
                const chunks = [];
                let currentChunk = '';
                const logLines = logContent.split('\n');
                
                for (const line of logLines) {
                    if ((currentChunk + line + '\n').length > 3900) {
                        if (currentChunk) {
                            chunks.push(currentChunk);
                            currentChunk = line + '\n';
                        } else {
                            // 单行过长，截断
                            chunks.push(line.substring(0, 3900) + '...\n');
                        }
                    } else {
                        currentChunk += line + '\n';
                    }
                }
                if (currentChunk) {
                    chunks.push(currentChunk);
                }

                // 发送第一部分
                embed.addFields(
                    { name: '日志内容 (1/'+chunks.length+')', value: '```\n' + chunks[0] + '```', inline: false }
                );
                
                await interaction.editReply({ embeds: [embed] });

                // 发送其余部分
                for (let i = 1; i < chunks.length && i < 5; i++) { // 最多发送5个片段
                    const followEmbed = new EmbedBuilder()
                        .setTitle(`📋 投票清除日志 (${i+1}/${Math.min(chunks.length, 5)})`)
                        .setColor('#3498db')
                        .addFields(
                            { name: '日志内容', value: '```\n' + chunks[i] + '```', inline: false }
                        );
                    
                    await interaction.followUp({ embeds: [followEmbed], ephemeral: true });
                }

                if (chunks.length > 5) {
                    const moreEmbed = new EmbedBuilder()
                        .setTitle('📋 更多日志')
                        .setDescription(`还有 ${chunks.length - 5} 个片段未显示，请减少查看行数或查看日志文件`)
                        .setColor('#f39c12');
                    
                    await interaction.followUp({ embeds: [moreEmbed], ephemeral: true });
                }

            } else if (logContent.trim()) {
                embed.addFields(
                    { name: '日志内容', value: '```\n' + logContent + '```', inline: false }
                );
                await interaction.editReply({ embeds: [embed] });
            } else {
                embed.setDescription('暂无投票清除日志记录');
                await interaction.editReply({ embeds: [embed] });
            }

        } catch (error) {
            console.error('查看投票清除日志时出错:', error);
            const errorEmbed = createErrorEmbed('系统错误', '读取日志时发生错误，请稍后重试');
            
            if (interaction.deferred) {
                await interaction.editReply({ embeds: [errorEmbed] });
            } else {
                await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            }
        }
    }
}; 