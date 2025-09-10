const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType } = require('discord.js');
const { RateLimiter } = require('../services/rateLimiter');
const { KeywordDetector } = require('../services/keywordDetector');
const { getBannedKeywords } = require('../../../core/utils/database');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('频道冲水-清理历史消息')
        .setNameLocalizations({
            'en-US': 'cleanup-history'
        })
        .setDescription('清理指定频道的历史消息')
        .addChannelOption(option =>
            option.setName('频道')
                .setNameLocalizations({ 'en-US': 'channel' })
                .setDescription('要清理的频道')
                .addChannelTypes(ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread)
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option.setName('天数')
                .setNameLocalizations({ 'en-US': 'days' })
                .setDescription('清理多少天内的消息（默认7天，最多30天）')
                .setMinValue(1)
                .setMaxValue(30)
                .setRequired(false)
        )
        .addIntegerOption(option =>
            option.setName('限制数量')
                .setNameLocalizations({ 'en-US': 'limit' })
                .setDescription('最多扫描多少条消息（默认1000条，最多5000条）')
                .setMinValue(100)
                .setMaxValue(5000)
                .setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    async execute(interaction) {
        try {
            await interaction.deferReply();

            const channel = interaction.options.getChannel('频道');
            const days = interaction.options.getInteger('天数') || 7;
            const limit = interaction.options.getInteger('限制数量') || 1000;
            const guildId = interaction.guild.id;

            // 检查频道权限
            const permissions = channel.permissionsFor(interaction.guild.members.me);
            if (!permissions.has(['ViewChannel', 'ReadMessageHistory', 'ManageMessages'])) {
                const embed = new EmbedBuilder()
                    .setTitle('❌ 权限不足')
                    .setDescription('机器人在该频道没有必要的权限（查看频道、阅读消息历史、管理消息）。')
                    .setColor(0xff0000);

                return await interaction.editReply({
                    embeds: [embed]
                });
            }

            // 获取违禁关键字
            const bannedKeywords = await getBannedKeywords(guildId);
            if (bannedKeywords.length === 0) {
                const embed = new EmbedBuilder()
                    .setTitle('❌ 没有违禁关键字')
                    .setDescription('请先使用 `/添加违禁关键字` 命令设置要清理的关键字。')
                    .setColor(0xff0000);

                return await interaction.editReply({
                    embeds: [embed]
                });
            }

            // 计算时间范围
            const cutoffTime = Date.now() - (days * 24 * 60 * 60 * 1000);

            // 创建服务实例
            const rateLimiter = new RateLimiter();
            const keywordDetector = new KeywordDetector();

            // 发送开始消息
            const startEmbed = new EmbedBuilder()
                .setTitle('🔍 开始历史消息清理')
                .setDescription(`正在扫描频道 <#${channel.id}> 中的消息...`)
                .addFields(
                    { name: '时间范围', value: `最近 ${days} 天`, inline: true },
                    { name: '扫描限制', value: `最多 ${limit.toLocaleString()} 条`, inline: true },
                    { name: '违禁关键字', value: `${bannedKeywords.length} 个`, inline: true }
                )
                .setColor(0x00ff00)
                .setTimestamp();

            const statusMessage = await interaction.editReply({
                embeds: [startEmbed]
            });

            let scannedCount = 0;
            let deletedCount = 0;
            let lastMessageId = null;
            let hasMoreMessages = true;
            let lastUpdateTime = Date.now();

            console.log(`🔍 开始历史消息清理 - Guild: ${guildId}, Channel: ${channel.name}, Days: ${days}, User: ${interaction.user.tag}`);

            while (hasMoreMessages && scannedCount < limit) {
                try {
                    // 获取消息批次
                    const messages = await rateLimiter.execute(async () => {
                        const options = { limit: Math.min(100, limit - scannedCount) };
                        if (lastMessageId) {
                            options.before = lastMessageId;
                        }
                        return await channel.messages.fetch(options);
                    });

                    if (messages.size === 0) {
                        hasMoreMessages = false;
                        break;
                    }

                    // 处理消息批次
                    for (const [messageId, message] of messages) {
                        scannedCount++;

                        // 检查消息时间
                        if (message.createdTimestamp < cutoffTime) {
                            hasMoreMessages = false;
                            break;
                        }

                        // 跳过机器人消息和系统消息
                        if (message.author.bot || message.system) {
                            continue;
                        }

                        // 检查关键字
                        const checkResult = await keywordDetector.checkMessageAdvanced(message, bannedKeywords);
                        
                        if (checkResult.shouldDelete) {
                            try {
                                await rateLimiter.execute(async () => {
                                    await message.delete();
                                });
                                deletedCount++;
                                
                                console.log(`🗑️ 删除历史违规消息 - 频道: ${channel.name}, 作者: ${message.author.tag}, 关键字: ${checkResult.matchedKeywords.join(', ')}`);
                            } catch (deleteError) {
                                console.error(`删除消息失败 - ID: ${messageId}:`, deleteError);
                            }
                        }
                    }

                    lastMessageId = messages.last().id;

                    // 定期更新进度（每5秒）
                    const now = Date.now();
                    if (now - lastUpdateTime >= 5000) {
                        const progressEmbed = new EmbedBuilder()
                            .setTitle('🔍 历史消息清理进行中')
                            .setDescription(`正在扫描频道 <#${channel.id}> 中的消息...`)
                            .addFields(
                                { name: '已扫描', value: `${scannedCount.toLocaleString()} 条`, inline: true },
                                { name: '已删除', value: `${deletedCount.toLocaleString()} 条`, inline: true },
                                { name: '进度', value: `${Math.round((scannedCount / limit) * 100)}%`, inline: true }
                            )
                            .setColor(0x00ff00)
                            .setTimestamp();

                        await statusMessage.edit({ embeds: [progressEmbed] });
                        lastUpdateTime = now;
                    }

                    // 小延迟避免过快请求
                    await new Promise(resolve => setTimeout(resolve, 200));

                } catch (error) {
                    console.error('处理消息批次时出错:', error);
                    break;
                }
            }

            // 发送完成消息
            const successRate = scannedCount > 0 ? ((deletedCount / scannedCount) * 100).toFixed(2) : '0';
            const duration = Math.round((Date.now() - statusMessage.createdTimestamp) / 1000);

            const completeEmbed = new EmbedBuilder()
                .setTitle('✅ 历史消息清理完成')
                .setDescription(`频道 <#${channel.id}> 的历史消息清理已完成！`)
                .addFields(
                    { name: '扫描消息', value: `${scannedCount.toLocaleString()} 条`, inline: true },
                    { name: '删除消息', value: `${deletedCount.toLocaleString()} 条`, inline: true },
                    { name: '清理率', value: `${successRate}%`, inline: true },
                    { name: '用时', value: `${duration} 秒`, inline: true },
                    { name: '时间范围', value: `最近 ${days} 天`, inline: true },
                    { name: '状态', value: scannedCount >= limit ? '达到扫描限制' : '全部完成', inline: true }
                )
                .setColor(0x00ff00)
                .setTimestamp();

            await statusMessage.edit({ embeds: [completeEmbed] });

            console.log(`✅ 历史消息清理完成 - Guild: ${guildId}, Channel: ${channel.name}, Scanned: ${scannedCount}, Deleted: ${deletedCount}`);

        } catch (error) {
            console.error('清理历史消息时出错:', error);
            
            const errorMessage = error.message || '清理历史消息时发生未知错误';
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 操作失败')
                .setDescription(`清理历史消息时出错：${errorMessage}`)
                .setColor(0xff0000);

            await interaction.editReply({
                embeds: [errorEmbed]
            });
        }
    },
}; 