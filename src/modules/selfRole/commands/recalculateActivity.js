// src/modules/selfRole/commands/recalculateActivity.js

const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType } = require('discord.js');
const { saveUserActivityBatch, saveDailyUserActivityBatch, clearChannelActivity } = require('../../../core/utils/database');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('回溯统计活跃度')
        .setDescription('扫描指定频道的历史消息以统计用户活跃度')
        .addStringOption(option =>
            option.setName('频道id')
                .setDescription('要进行统计的频道的ID')
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option.setName('扫描天数')
                .setDescription('要扫描多少天内的历史消息（默认不限制）')
                .setMinValue(1)
                .setRequired(false)
        )
        .addBooleanOption(option =>
            option.setName('重置数据')
                .setDescription('在扫描前是否清空该频道的现有统计数据（默认为否）')
                .setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const channelId = interaction.options.getString('频道id');
        const days = interaction.options.getInteger('扫描天数');
        const resetData = interaction.options.getBoolean('重置数据') || false;
        const guildId = interaction.guild.id;

        try {
            const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
            if (!channel || channel.type !== ChannelType.GuildText) {
                return interaction.editReply({ content: '❌ 无效的频道ID或频道类型不是文字频道。' });
            }

            console.log(`[SelfRole] 🔍 开始回溯统计频道 ${channel.name} 的历史消息...`);
            const startEmbed = new EmbedBuilder()
                .setTitle('🔍 开始回溯统计...')
                .setDescription(`正在扫描频道 <#${channel.id}> 的历史消息。这可能需要一些时间。`)
                .setColor(0x5865F2)
                .setTimestamp();
            await interaction.editReply({ embeds: [startEmbed] });

            let scannedCount = 0;
            let lastMessageId = null;
            let hasMoreMessages = true;
            const channelActivity = {}; // 只计算当前频道的增量
            const dailyChannelActivity = {}; // 按日期分组的活跃度数据

            if (resetData) {
                console.log(`[SelfRole] 🗑️ 重置频道 ${channel.name} 的活跃度数据...`);
                await clearChannelActivity(guildId, channel.id);
            }

            const cutoffTimestamp = days ? Date.now() - (days * 24 * 60 * 60 * 1000) : 0;

            while (hasMoreMessages) {
                const messages = await channel.messages.fetch({ limit: 100, before: lastMessageId });

                if (messages.size === 0) {
                    hasMoreMessages = false;
                    break;
                }

                for (const message of messages.values()) {
                    if (message.createdTimestamp < cutoffTimestamp) {
                        hasMoreMessages = false;
                        break;
                    }
                    if (message.author.bot) continue;

                    const authorId = message.author.id;
                    const messageDate = new Date(message.createdTimestamp).toISOString().split('T')[0]; // YYYY-MM-DD

                    // 更新总体活跃度
                    if (!channelActivity[authorId]) {
                        channelActivity[authorId] = { messageCount: 0, mentionedCount: 0, mentioningCount: 0 };
                    }
                    channelActivity[authorId].messageCount++;

                    // 更新每日活跃度
                    if (!dailyChannelActivity[messageDate]) {
                        dailyChannelActivity[messageDate] = {};
                    }
                    if (!dailyChannelActivity[messageDate][authorId]) {
                        dailyChannelActivity[messageDate][authorId] = { messageCount: 0, mentionedCount: 0, mentioningCount: 0 };
                    }
                    dailyChannelActivity[messageDate][authorId].messageCount++;

                    // 检查是否为主动提及 (回复或@)
                    const isMentioning = message.reference !== null || message.mentions.users.size > 0 || message.mentions.roles.size > 0;
                    if (isMentioning) {
                        channelActivity[authorId].mentioningCount++;
                        dailyChannelActivity[messageDate][authorId].mentioningCount++;
                    }

                    message.mentions.users.forEach(user => {
                        if (user.bot || user.id === authorId) return;
                        const mentionedId = user.id;

                        // 更新总体被提及数
                        if (!channelActivity[mentionedId]) {
                            channelActivity[mentionedId] = { messageCount: 0, mentionedCount: 0, mentioningCount: 0 };
                        }
                        channelActivity[mentionedId].mentionedCount++;

                        // 更新每日被提及数
                        if (!dailyChannelActivity[messageDate][mentionedId]) {
                            dailyChannelActivity[messageDate][mentionedId] = { messageCount: 0, mentionedCount: 0, mentioningCount: 0 };
                        }
                        dailyChannelActivity[messageDate][mentionedId].mentionedCount++;
                    });
                }

                scannedCount += messages.size;
                lastMessageId = messages.last().id;
                console.log(`[SelfRole] 📜 已扫描 ${scannedCount} 条消息...`);
            }

            // 构建用于批量保存的 batchData 对象
            const batchData = {
                [guildId]: {
                    [channel.id]: channelActivity
                }
            };

            await saveUserActivityBatch(batchData);

            // 保存每日活跃度数据
            for (const date in dailyChannelActivity) {
                const dailyBatchData = {
                    [guildId]: {
                        [channel.id]: dailyChannelActivity[date]
                    }
                };
                await saveDailyUserActivityBatch(dailyBatchData, date);
            }

            console.log(`[SelfRole] ✅ 频道 ${channel.name} 的历史消息回溯统计完成。`);
            const successEmbed = new EmbedBuilder()
                .setTitle('✅ 回溯统计完成')
                .setDescription(`成功扫描了频道 <#${channel.id}> 的 **${scannedCount}** 条历史消息，并更新了用户活跃度数据。`)
                .setColor(0x57F287)
                .setTimestamp();
            // 使用 channel.send 替代 editReply，避免长时间任务导致 token 过期
            await interaction.channel.send({ embeds: [successEmbed] });

        } catch (error) {
            console.error('[SelfRole] ❌ 回溯统计活跃度时出错:', error);
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 操作失败')
                .setDescription('在回溯统计过程中发生错误，请检查机器人在该频道是否具有“读取消息历史”的权限。')
                .setColor(0xED4245);
            // 同样使用 channel.send 发送错误信息
            try {
                await interaction.channel.send({ embeds: [errorEmbed] });
            } catch (sendError) {
                console.error('[SelfRole] ❌ 发送错误通知失败:', sendError);
            }
        }
    },
};