// src/modules/channelSummary/commands/summarizeChannel.js

const { SlashCommandBuilder, PermissionFlagsBits, AttachmentBuilder } = require('discord.js');
const { parseTimeInput, validateTimeRange } = require('../utils/timeParser');
const { collectMessages } = require('../services/messageCollector');
const { generateSummary } = require('../services/aiSummaryService');
const { generateMessagesJSON, saveToTempFile, cleanupTempFiles } = require('../services/jsonExporter');
const { formatSummaryForDiscord, generateSummaryText, generatePlainTextSummary, splitLongText, createSummaryTextFile } = require('../utils/summaryFormatter');
const config = require('../config/summaryConfig');

const data = new SlashCommandBuilder()
    .setName('总结频道内容')
    .setDescription('总结指定时间段内的频道消息')
    .addStringOption(option =>
        option.setName('开始时间')
            .setDescription('开始时间 (格式: YYYY-MM-DD HH:mm 或 YYYY-MM-DD)')
            .setRequired(true))
    .addStringOption(option =>
        option.setName('结束时间')
            .setDescription('结束时间 (格式: YYYY-MM-DD HH:mm 或 YYYY-MM-DD)')
            .setRequired(true))
    .addStringOption(option =>
        option.setName('模型')
            .setDescription('指定用于总结的AI模型，不填则使用默认模型')
            .setRequired(false))
    // .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages); // 注释了权限要求，需要使用时候取消注释

async function execute(interaction) {
    try {
        // 1. 添加更强的错误处理和验证
        // 首先验证interaction和channel的有效性
        if (!interaction || !interaction.isRepliable()) {
            console.error('无效的交互对象');
            return;
        }

        // 2. 改进channel获取逻辑，处理子区情况
        let channel = interaction.channel;
        
        // 如果在子区中，可能需要获取父频道
        if (!channel) {
            // 尝试从guild获取频道
            try {
                channel = await interaction.guild.channels.fetch(interaction.channelId);
            } catch (error) {
                console.error('无法获取频道信息:', error);
                return;
            }
        }

        // 3. 立即defer回复，避免3秒超时
        try {
            await interaction.deferReply({ ephemeral: true });
        } catch (deferError) {
            console.error('Defer回复失败:', deferError);
            // 如果defer失败，尝试直接回复
            try {
                await interaction.reply({ 
                    content: '❌ 交互已过期，请重新尝试命令。', 
                    ephemeral: true 
                });
            } catch (replyError) {
                console.error('直接回复也失败:', replyError);
            }
            return;
        }
        
        // 4. 检查频道类型（添加null检查）
        if (!channel) {
            return await interaction.editReply('❌ 无法获取频道信息，请确保在正确的频道中使用此命令。');
        }

        // 改进频道类型检查
        const isValidChannel = channel.isTextBased() || 
                              (channel.isThread && channel.isThread()) ||
                              channel.type === 0 || // GUILD_TEXT
                              channel.type === 11;  // GUILD_PUBLIC_THREAD

        if (!isValidChannel) {
            return await interaction.editReply('❌ 此命令只能在文字频道或线程中使用。');
        }
        
        // 解析时间参数
        const startTimeStr = interaction.options.getString('开始时间');
        const endTimeStr = interaction.options.getString('结束时间');
        const model = interaction.options.getString('模型'); // 获取模型参数
        
        const startTime = parseTimeInput(startTimeStr);
        const endTime = parseTimeInput(endTimeStr);
        
        // 验证时间范围
        validateTimeRange(startTime, endTime, config.MAX_TIME_RANGE_DAYS);
        
        await interaction.editReply('⏳ 开始收集消息...');
        
        // 收集消息
        const messages = await collectMessages(
            channel, 
            startTime, 
            endTime, 
            config.MAX_MESSAGES
        );
        
        if (messages.length === 0) {
            return await interaction.editReply('❌ 在指定时间范围内没有找到任何消息。');
        }
        
        await interaction.editReply(`📊 收集到 ${messages.length} 条消息，正在生成AI总结...`);
        
        // 准备频道信息
        const channelInfo = {
            id: channel.id,
            name: channel.name || '未命名频道',
            type: channel.type,
            timeRange: {
                start: startTime.toISOString(),
                end: endTime.toISOString()
            }
        };
        
        // 生成AI总结
        const aiSummary = await generateSummary(messages, channelInfo, model);
        
        await interaction.editReply('📝 正在生成文件和总结...');
        
        // 生成并保存JSON（只包含消息数据）
        const messagesData = generateMessagesJSON(channelInfo, messages);
        const fileInfo = await saveToTempFile(messagesData, channelInfo.name);
        
        // 创建附件
        const attachment = new AttachmentBuilder(fileInfo.filePath, { 
            name: fileInfo.fileName 
        });
        
        // 清理过期文件
        cleanupTempFiles(config.FILE_RETENTION_HOURS).catch(console.warn);
        
        // 先私密回复完成信息和文件
        const completionEmbed = {
            color: 0x00ff00,
            title: '✅ 频道内容总结完成',
            fields: [
                { name: '频道', value: channelInfo.name, inline: true },
                { name: '消息数量', value: messages.length.toString(), inline: true },
                { name: '参与用户', value: aiSummary.participant_stats.total_participants.toString(), inline: true },
                { name: '时间范围', value: `${startTimeStr} 至 ${endTimeStr}`, inline: false },
                { name: '文件大小', value: `${Math.round(fileInfo.size / 1024)} KB`, inline: true }
            ],
            description: '📁 消息数据已导出到JSON文件\n🤖 AI总结将以公开消息发送',
            timestamp: new Date().toISOString()
        };
        
        await interaction.editReply({
            content: '处理完成！AI总结即将以公开消息发送...',
            embeds: [completionEmbed],
            files: [attachment]
        });
        
        // 发送公开的AI总结消息
        const plainTextSummary = generatePlainTextSummary(aiSummary, channelInfo, messages.length);
        const summaryParts = splitLongText(plainTextSummary);
        
        // 发送总结的开头信息
        await interaction.channel.send(
            `📋 **频道内容总结** (由 ${interaction.user.displayName} 发起)\n` +
            `⏰ 时间范围: ${startTimeStr} 至 ${endTimeStr}`
        );
        
        // 分段发送总结内容
        for (let i = 0; i < summaryParts.length; i++) {
            const part = summaryParts[i];
            const isLastPart = i === summaryParts.length - 1;
            
            if (isLastPart && summaryParts.length > 1) {
                // 最后一条消息，生成并附加txt文件
                try {
                    const textFile = await createSummaryTextFile(aiSummary, channelInfo, messages.length);
                    const textAttachment = new AttachmentBuilder(textFile.filePath, { 
                        name: textFile.fileName 
                    });
                    
                    await interaction.channel.send({
                        content: `${part}\n\n📄 **完整总结已保存为文件**`,
                        files: [textAttachment]
                    });
                } catch (fileError) {
                    console.warn('创建文本文件失败:', fileError);
                    await interaction.channel.send(part);
                }
            } else {
                await interaction.channel.send(part);
            }
            
            // 避免发送过快
            if (i < summaryParts.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
        
    } catch (error) {
        console.error('频道总结命令执行失败:', error);
        
        const errorMessage = error.message.includes('不支持的时间格式') || 
                           error.message.includes('无效的时间') ||
                           error.message.includes('时间范围') ?
                           error.message : '执行总结时发生错误，请稍后重试。';
        
        // 5. 改进错误处理
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(`❌ ${errorMessage}`);
            } else {
                await interaction.reply({ 
                    content: `❌ ${errorMessage}`, 
                    ephemeral: true 
                });
            }
        } catch (replyError) {
            console.error('错误回复失败:', replyError);
        }
    }
}

module.exports = {
    data,
    execute
};