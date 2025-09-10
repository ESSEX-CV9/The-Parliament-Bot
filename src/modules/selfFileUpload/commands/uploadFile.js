const { SlashCommandBuilder, ChannelType, MessageFlags } = require('discord.js');
const { ALLOWED_FORUM_IDS } = require('../config/config');
const { addAnonymousUploadLog, isUserOptedOut } = require('../../../core/utils/database');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('自助补档')
        .setDescription('上传一个文件，机器人将代为在本帖中发出消息。')
        .addAttachmentOption(option =>
            option.setName('文件')
                .setDescription('要上传的文件 (json, zip, 7z, png等)')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('文件名')
                .setDescription('为你的文件设置一个清晰的名称。')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('描述')
                .setDescription('对文件的简短描述。')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('署名')
                .setDescription('是否署名？默认为否 (匿名)。')
                .setRequired(false)
                .addChoices(
                    { name: '是', value: 'yes' },
                    { name: '否', value: 'no' }
                )),

    async execute(interaction) {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        // 1. 检查是否在允许的论坛频道的帖子内
        const isAllowed = interaction.channel.isThread() && ALLOWED_FORUM_IDS.includes(interaction.channel.parentId);
        if (!isAllowed) {
            return interaction.editReply({
                content: '❌ 此命令只能在指定论坛的帖子中使用。',
            });
        }

        const fileAttachment = interaction.options.getAttachment('文件');
        const fileName = interaction.options.getString('文件名');
        const isSigned = interaction.options.getString('署名') === 'yes';
        const description = interaction.options.getString('描述');
        
        // 检查帖子原作者是否拒绝任何形式的自助补档
        try {
            const starterMessage = await interaction.channel.fetchStarterMessage();
            if (starterMessage) {
                const mentionedUserIds = new Set();
                const mentionRegex = /<@!?(\d+)>/g;

                // 1. 从消息内容中提取ID
                let contentMatch;
                while ((contentMatch = mentionRegex.exec(starterMessage.content)) !== null) {
                    mentionedUserIds.add(contentMatch[1]);
                }

                // 2. 从Embed的描述中提取ID
                if (starterMessage.embeds && starterMessage.embeds.length > 0) {
                    starterMessage.embeds.forEach(embed => {
                        if (embed.description) {
                            let embedMatch;
                            // 需要重置正则表达式的 lastIndex
                            mentionRegex.lastIndex = 0;
                            while ((embedMatch = mentionRegex.exec(embed.description)) !== null) {
                                mentionedUserIds.add(embedMatch[1]);
                            }
                        }
                    });
                }
                
                // 3. 检查所有提取到的作者ID
                if (mentionedUserIds.size > 0) {
                    for (const userId of mentionedUserIds) {
                        const ownerOptedOut = await isUserOptedOut(userId);
                        if (ownerOptedOut) {
                            return interaction.editReply({
                                content: `❌ 操作失败。该帖子的作者 (<@${userId}>) 不允许他人在其帖子下使用自助补档功能。`,
                            });
                        }
                    }
                }
            }
        } catch (error) {
            console.error('获取帖子初始消息或检查作者状态时出错:', error);
            return interaction.editReply({
                content: '❌ 无法验证帖子作者状态，操作已取消。',
            });
        }

        // 2. 检查文件大小 (Discord 机器人上传限制为 25MB)
        if (fileAttachment.size > 25 * 1024 * 1024) {
            return interaction.editReply({
                content: '❌ 文件大小超过 25MB 限制，无法上传。',
            });
        }

        try {
            // 构造消息内容
            let messageContent = `**${fileName}**`;
            if (description) {
                messageContent += `\n${description}`;
            }

            if (isSigned) {
                messageContent += `\n\n*由 <@${interaction.user.id}> 上传*`;
            }

            const messageOptions = {
                content: messageContent,
                files: [fileAttachment],
            };
            
            // 4. 在当前帖子中发送消息
            const sentMessage = await interaction.channel.send(messageOptions);

            // 5. 编辑首楼消息
            try {
                const starterMessage = await interaction.channel.fetchStarterMessage();
                if (starterMessage) {
                    const fileUrl = sentMessage.attachments.first().url;
                    const messageLink = sentMessage.url;
                    
                    let content = starterMessage.content || '';
                    const sectionTitle = '自助补档:';
                    
                    let newEntryText;
                    if (fileAttachment.contentType && fileAttachment.contentType.startsWith('image/')) {
                        newEntryText = `[${fileName}](${messageLink}) (${fileUrl})`;
                    } else {
                        newEntryText = `[${fileName}](${messageLink})`;
                    }

                    const lines = content.split('\n');
                    const sectionStartIndex = lines.findIndex(line => line.startsWith(sectionTitle));

                    if (sectionStartIndex !== -1) {
                        // Section exists. Find where it ends (first empty line after title).
                        let sectionEndIndex = lines.findIndex((line, index) => index > sectionStartIndex && line.trim() === '');
                        if (sectionEndIndex === -1) {
                            sectionEndIndex = lines.length; // Reaches end of message
                        }

                        // Find last number in section
                        let lastNumber = 0;
                        for (let i = sectionStartIndex + 1; i < sectionEndIndex; i++) {
                            const match = lines[i].match(/^(\d+)\./);
                            if (match) {
                                lastNumber = parseInt(match[1], 10);
                            }
                        }
                        const newNumber = lastNumber + 1;
                        const newLine = `${newNumber}. ${newEntryText}`;

                        // Insert new line at the end of the section
                        lines.splice(sectionEndIndex, 0, newLine);
                        content = lines.join('\n');

                    } else {
                        // Section doesn't exist, add it
                        content += `\n\n${sectionTitle}\n1. ${newEntryText}`;
                    }

                    await starterMessage.edit({ content });
                }
            } catch (editError) {
                console.error('编辑首楼消息失败:', editError);
                // 即使编辑失败，也应通知用户上传成功
            }

            // 6. 如果是匿名上传，则记录日志
            if (!isSigned) {
                const logEntry = {
                    newMessageId: sentMessage.id,
                    uploaderId: interaction.user.id,
                    uploaderTag: interaction.user.tag,
                };
                await addAnonymousUploadLog(logEntry);
                console.log(`匿名上传日志已记录: ${interaction.user.tag} 上传了 ${fileAttachment.name}`);
            }

            // 7. 回复用户操作成功
            await interaction.editReply({
                content: `✅ 文件上传成功！感谢您的贡献`,
            });

        } catch (error) {
            console.error('文件上传失败:', error);
            await interaction.editReply({
                content: `❌ 文件上传失败。\n\n**错误详情:**\n\`\`\`${error.name}: ${error.message}\`\`\``,
            });
        }
    },
};