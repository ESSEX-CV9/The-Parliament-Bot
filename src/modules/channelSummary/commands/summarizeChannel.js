// src/modules/channelSummary/commands/summarizeChannel.js

const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { parseTimeInput, validateTimeRange } = require('../utils/timeParser');
const { collectMessages } = require('../services/messageCollector');
const { generateSummary } = require('../services/aiSummaryService');
const { generateMessagesJSON, saveToTempFile, cleanupTempFiles } = require('../services/jsonExporter');
const { generatePlainTextSummary, splitLongText, createSummaryTextFile } = require('../utils/summaryFormatter');
const config = require('../config/summaryConfig');

const data = new SlashCommandBuilder()
    .setName('\u603b\u7ed3\u9891\u9053\u5185\u5bb9')
    .setDescription('\u603b\u7ed3\u6307\u5b9a\u65f6\u95f4\u6bb5\u5185\u7684\u9891\u9053\u6d88\u606f')
    .addStringOption(option =>
        option
            .setName('\u5f00\u59cb\u65f6\u95f4')
            .setDescription('\u5f00\u59cb\u65f6\u95f4\uff08\u683c\u5f0f: YYYY-MM-DD HH:mm \u6216 YYYY-MM-DD\uff09')
            .setRequired(true))
    .addStringOption(option =>
        option
            .setName('\u7ed3\u675f\u65f6\u95f4')
            .setDescription('\u7ed3\u675f\u65f6\u95f4\uff08\u683c\u5f0f: YYYY-MM-DD HH:mm \u6216 YYYY-MM-DD\uff09')
            .setRequired(true))
    .addStringOption(option =>
        option
            .setName('\u6a21\u578b')
            .setDescription('\u6307\u5b9a\u7528\u4e8e\u603b\u7ed3\u7684 AI \u6a21\u578b\uff0c\u4e0d\u586b\u5219\u4f7f\u7528\u9ed8\u8ba4\u6a21\u578b')
            .setRequired(false))
    .addStringOption(option =>
        option
            .setName('url')
            .setDescription('OpenAI \u517c\u5bb9\u63a5\u53e3 URL\uff0c\u4f8b\u5982 https://newapi.momoaisite.com/v1')
            .setRequired(false))
    .addStringOption(option =>
        option
            .setName('api')
            .setDescription('OpenAI \u517c\u5bb9\u63a5\u53e3\u7684 API Key')
            .setRequired(false))
    .addStringOption(option =>
        option
            .setName('\u81ea\u5b9a\u4e49\u989d\u5916\u63d0\u793a\u8bcd')
            .setDescription('\u53ef\u9009\uff1a\u8ffd\u52a0\u5230\u9ed8\u8ba4\u603b\u7ed3\u63d0\u793a\u8bcd\u672b\u5c3e\u7684\u989d\u5916\u8981\u6c42')
            .setRequired(false));

async function execute(interaction) {
    try {
        if (!interaction || !interaction.isRepliable()) {
            console.error('Invalid interaction for channel summary command');
            return;
        }

        let channel = interaction.channel;
        if (!channel) {
            channel = await interaction.guild.channels.fetch(interaction.channelId);
        }

        await interaction.deferReply({ ephemeral: true });

        if (!channel) {
            return await interaction.editReply('\u274c \u65e0\u6cd5\u83b7\u53d6\u9891\u9053\u4fe1\u606f\uff0c\u8bf7\u5728\u6b63\u786e\u7684\u9891\u9053\u4e2d\u4f7f\u7528\u6b64\u547d\u4ee4\u3002');
        }

        const isValidChannel =
            channel.isTextBased() ||
            (channel.isThread && channel.isThread()) ||
            channel.type === 0 ||
            channel.type === 11;

        if (!isValidChannel) {
            return await interaction.editReply('\u274c \u6b64\u547d\u4ee4\u53ea\u80fd\u5728\u6587\u5b57\u9891\u9053\u6216\u7ebf\u7a0b\u4e2d\u4f7f\u7528\u3002');
        }

        const startTimeStr = interaction.options.getString('\u5f00\u59cb\u65f6\u95f4');
        const endTimeStr = interaction.options.getString('\u7ed3\u675f\u65f6\u95f4');
        const model = interaction.options.getString('\u6a21\u578b');
        const baseURL = interaction.options.getString('url');
        const apiKey = interaction.options.getString('api');
        const extraPrompt = interaction.options.getString('\u81ea\u5b9a\u4e49\u989d\u5916\u63d0\u793a\u8bcd');

        const startTime = parseTimeInput(startTimeStr);
        const endTime = parseTimeInput(endTimeStr);

        validateTimeRange(startTime, endTime, config.MAX_TIME_RANGE_DAYS);

        await interaction.editReply('\u23f3 \u5f00\u59cb\u6536\u96c6\u6d88\u606f...');

        const messages = await collectMessages(channel, startTime, endTime, config.MAX_MESSAGES);

        if (messages.length === 0) {
            return await interaction.editReply('\u274c \u5728\u6307\u5b9a\u65f6\u95f4\u8303\u56f4\u5185\u6ca1\u6709\u627e\u5230\u4efb\u4f55\u6d88\u606f\u3002');
        }

        await interaction.editReply(`\ud83d\udce8 \u6536\u96c6\u5230 ${messages.length} \u6761\u6d88\u606f\uff0c\u6b63\u5728\u751f\u6210 AI \u603b\u7ed3...`);

        const channelInfo = {
            id: channel.id,
            name: channel.name || '\u672a\u547d\u540d\u9891\u9053',
            type: channel.type,
            timeRange: {
                start: startTime.toISOString(),
                end: endTime.toISOString()
            }
        };

        const aiSummary = await generateSummary(messages, channelInfo, {
            model,
            baseURL,
            apiKey,
            extraPrompt
        });

        await interaction.editReply('\ud83d\udcc4 \u6b63\u5728\u751f\u6210\u6587\u4ef6\u548c\u603b\u7ed3...');

        const messagesData = generateMessagesJSON(channelInfo, messages);
        const fileInfo = await saveToTempFile(messagesData, channelInfo.name);
        const attachment = new AttachmentBuilder(fileInfo.filePath, {
            name: fileInfo.fileName
        });

        cleanupTempFiles(config.FILE_RETENTION_HOURS).catch(console.warn);

        const completionEmbed = {
            color: 0x00ff00,
            title: '\u2705 \u9891\u9053\u5185\u5bb9\u603b\u7ed3\u5b8c\u6210',
            fields: [
                { name: '\u9891\u9053', value: channelInfo.name, inline: true },
                { name: '\u6d88\u606f\u6570\u91cf', value: messages.length.toString(), inline: true },
                { name: '\u53c2\u4e0e\u7528\u6237', value: aiSummary.participant_stats.total_participants.toString(), inline: true },
                { name: '\u65f6\u95f4\u8303\u56f4', value: `${startTimeStr} \u81f3 ${endTimeStr}`, inline: false },
                { name: '\u6587\u4ef6\u5927\u5c0f', value: `${Math.round(fileInfo.size / 1024)} KB`, inline: true }
            ],
            description: '\ud83d\udce6 \u6d88\u606f\u6570\u636e\u5df2\u5bfc\u51fa\u4e3a JSON \u6587\u4ef6\n\ud83e\udd16 AI \u603b\u7ed3\u5c06\u4ee5\u516c\u5f00\u6d88\u606f\u53d1\u9001',
            timestamp: new Date().toISOString()
        };

        await interaction.editReply({
            content: '\u5904\u7406\u5b8c\u6210\uff0cAI \u603b\u7ed3\u5373\u5c06\u4ee5\u516c\u5f00\u6d88\u606f\u53d1\u9001...',
            embeds: [completionEmbed],
            files: [attachment]
        });

        const plainTextSummary = generatePlainTextSummary(aiSummary, channelInfo, messages.length);
        const summaryParts = splitLongText(plainTextSummary);

        await interaction.channel.send(
            `\ud83d\udcdc **\u9891\u9053\u5185\u5bb9\u603b\u7ed3** (\u7531 ${interaction.user.displayName} \u53d1\u8d77)\n` +
            `\u23f0 \u65f6\u95f4\u8303\u56f4: ${startTimeStr} \u81f3 ${endTimeStr}`
        );

        for (let i = 0; i < summaryParts.length; i++) {
            const part = summaryParts[i];
            const isLastPart = i === summaryParts.length - 1;

            if (isLastPart && summaryParts.length > 1) {
                try {
                    const textFile = await createSummaryTextFile(aiSummary, channelInfo, messages.length);
                    const textAttachment = new AttachmentBuilder(textFile.filePath, {
                        name: textFile.fileName
                    });

                    await interaction.channel.send({
                        content: `${part}\n\n\ud83d\udcce **\u5b8c\u6574\u603b\u7ed3\u5df2\u4fdd\u5b58\u4e3a\u6587\u4ef6**`,
                        files: [textAttachment]
                    });
                } catch (fileError) {
                    console.warn('Failed to create summary text file:', fileError);
                    await interaction.channel.send(part);
                }
            } else {
                await interaction.channel.send(part);
            }

            if (i < summaryParts.length - 1) {
                await new Promise(resolve => setTimeout(resolve, config.SUMMARY_DISPLAY.MESSAGE_SEND_DELAY));
            }
        }
    } catch (error) {
        console.error('Channel summary command failed:', error);

        const errorMessage = error.message.includes('\u65f6\u95f4\u683c\u5f0f') ||
            error.message.includes('\u65e0\u6548\u7684\u65f6\u95f4') ||
            error.message.includes('\u65f6\u95f4\u8303\u56f4')
            ? error.message
            : '\u6267\u884c\u603b\u7ed3\u65f6\u53d1\u751f\u9519\u8bef\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002';

        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(`\u274c ${errorMessage}`);
            } else {
                await interaction.reply({
                    content: `\u274c ${errorMessage}`,
                    ephemeral: true
                });
            }
        } catch (replyError) {
            console.error('Failed to send error response:', replyError);
        }
    }
}

module.exports = {
    data,
    execute
};
