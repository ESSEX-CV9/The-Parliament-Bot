const { SlashCommandBuilder, EmbedBuilder, ChannelType } = require('discord.js');
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
        await interaction.deferReply({ ephemeral: true });

        // 1. 检查是否在允许的论坛频道的帖子内
        const isAllowed = interaction.channel.isThread() && ALLOWED_FORUM_IDS.includes(interaction.channel.parentId);
        if (!isAllowed) {
            return interaction.editReply({
                content: '❌ 此命令只能在指定论坛的帖子中使用。',
            });
        }

        const fileAttachment = interaction.options.getAttachment('文件');
        const isSigned = interaction.options.getString('署名') === 'yes';
        const description = interaction.options.getString('描述'); // 获取描述内容
        
        // 修改：检查帖子作者是否拒绝任何形式的自助补档
        const threadOwnerId = interaction.channel.ownerId;
        // 确保能获取到帖子作者ID
        if (threadOwnerId) {
            const ownerOptedOut = await isUserOptedOut(threadOwnerId);
            if (ownerOptedOut) {
                return interaction.editReply({
                    content: '❌ 操作失败。该帖子的作者不允许他人在其帖子下使用自助补档功能。',
                });
            }
        }

        // 2. 检查文件大小 (Discord 机器人上传限制为 25MB)
        if (fileAttachment.size > 25 * 1024 * 1024) {
            return interaction.editReply({
                content: '❌ 文件大小超过 25MB 限制，无法上传。',
            });
        }

        try {
            const messageOptions = {
                files: [fileAttachment],
            };

            let embedDescription = '';

            // 如果有描述，则设置它
            if (description) {
                embedDescription = description;
            }

            // 如果用户选择署名，则附上签名
            if (isSigned) {
                const signature = `由 <@${interaction.user.id}> 上传`;
                if (embedDescription) {
                    // 将签名附加到现有描述的末尾
                    embedDescription += `\n\n*${signature}*`;
                } else {
                    // 如果没有描述，则仅显示签名
                    embedDescription = `*${signature}*`;
                }
            }

            // 仅当有内容（描述或签名）时才创建并添加Embed
            if (embedDescription) {
                const embed = new EmbedBuilder()
                    .setDescription(embedDescription)
                    .setColor('#C7EDCC'); // 使用一个中性的颜色
                messageOptions.embeds = [embed];
            }

            // 4. 在当前帖子中发送消息
            const sentMessage = await interaction.channel.send(messageOptions);

            // 5. 如果是匿名上传，则记录日志
            if (!isSigned) {
                const logEntry = {
                    newMessageId: sentMessage.id, // 消息ID，用于查询
                    uploaderId: interaction.user.id,   // 上传者ID
                    uploaderTag: interaction.user.tag, // 上传者Tag，用于显示
                };
                await addAnonymousUploadLog(logEntry);
                console.log(`匿名上传日志已记录: ${interaction.user.tag} 上传了 ${fileAttachment.name}`);
            }

            // 6. 回复用户操作成功
            await interaction.editReply({
                content: `✅ 文件上传成功！感谢您的贡献`,
            });

        } catch (error) {
            console.error('文件上传失败:', error);
            await interaction.editReply({
                content: '❌ 文件上传失败，可能是机器人权限不足或发生未知错误。',
            });
        }
    },
};