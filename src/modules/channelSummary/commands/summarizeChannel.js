// src/modules/channelSummary/commands/summarizeChannel.js

const { SlashCommandBuilder, PermissionFlagsBits, AttachmentBuilder } = require('discord.js');
const { parseTimeInput, validateTimeRange } = require('../utils/timeParser');
const { collectMessages } = require('../services/messageCollector');
const { generateSummary } = require('../services/aiSummaryService');
const { generateSummaryJSON, saveToTempFile, cleanupTempFiles } = require('../services/jsonExporter');
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
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages);

async function execute(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });
        
        // 检查频道类型
        if (!interaction.channel.isThread() && !interaction.channel.isTextBased()) {
            return await interaction.editReply('此命令只能在文字频道或线程中使用。');
        }
        
        // 解析时间参数
        const startTimeStr = interaction.options.getString('开始时间');
        const endTimeStr = interaction.options.getString('结束时间');
        
        const startTime = parseTimeInput(startTimeStr);
        const endTime = parseTimeInput(endTimeStr);
        
        // 验证时间范围
        validateTimeRange(startTime, endTime, config.MAX_TIME_RANGE_DAYS);
        
        await interaction.editReply('⏳ 开始收集消息...');
        
        // 收集消息
        const messages = await collectMessages(
            interaction.channel, 
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
            id: interaction.channel.id,
            name: interaction.channel.name || '未命名频道',
            type: interaction.channel.type,
            timeRange: {
                start: startTime.toISOString(),
                end: endTime.toISOString()
            }
        };
        
        // 生成AI总结
        const aiSummary = await generateSummary(messages, channelInfo);
        
        await interaction.editReply('📝 正在生成JSON文件...');
        
        // 生成并保存JSON
        const summaryData = generateSummaryJSON(channelInfo, messages, aiSummary);
        const fileInfo = await saveToTempFile(summaryData, channelInfo.name);
        
        // 创建附件
        const attachment = new AttachmentBuilder(fileInfo.filePath, { 
            name: fileInfo.fileName 
        });
        
        // 清理过期文件
        cleanupTempFiles(config.FILE_RETENTION_HOURS).catch(console.warn);
        
        // 发送结果
        const embed = {
            color: 0x00ff00,
            title: '📊 频道内容总结完成',
            fields: [
                { name: '频道', value: channelInfo.name, inline: true },
                { name: '消息数量', value: messages.length.toString(), inline: true },
                { name: '参与用户', value: aiSummary.participant_stats.total_participants.toString(), inline: true },
                { name: '时间范围', value: `${startTimeStr} 至 ${endTimeStr}`, inline: false },
                { name: '文件大小', value: `${Math.round(fileInfo.size / 1024)} KB`, inline: true }
            ],
            timestamp: new Date().toISOString()
        };
        
        await interaction.editReply({
            content: '✅ 总结完成！请查看附件中的详细JSON文件。',
            embeds: [embed],
            files: [attachment]
        });
        
    } catch (error) {
        console.error('频道总结命令执行失败:', error);
        
        const errorMessage = error.message.includes('不支持的时间格式') || 
                           error.message.includes('无效的时间') ||
                           error.message.includes('时间范围') ?
                           error.message : '执行总结时发生错误，请稍后重试。';
        
        await interaction.editReply(`❌ ${errorMessage}`);
    }
}

module.exports = {
    data,
    execute
};