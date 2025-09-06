const { SlashCommandBuilder, MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getContestChannel, updateContestChannel, getContestApplication, getSubmissionsByChannel } = require('../utils/contestDatabase');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const { checkContestManagePermission, getManagePermissionDeniedMessage } = require('../utils/contestPermissions');

const data = new SlashCommandBuilder()
    .setName('赛事-生成赛事频道初始信息')
    .setDescription('重新生成赛事频道的初始消息（用于恢复被删除的消息）')
    .addStringOption(option =>
        option.setName('赛事频道id')
            .setDescription('赛事频道的ID')
            .setRequired(true))
    .addStringOption(option =>
        option.setName('消息类型')
            .setDescription('要生成的消息类型')
            .setRequired(true)
            .addChoices(
                { name: '全部', value: 'all' },
                { name: '比赛详情', value: 'info' },
                { name: '投稿入口', value: 'submission' },
                { name: '最近投稿作品展示', value: 'display' }
            ));

async function execute(interaction) {
    try {
        // 检查是否在服务器中使用
        if (!interaction.guild) {
            return interaction.reply({
                content: '❌ 此指令只能在服务器中使用，不能在私信中使用。',
                flags: MessageFlags.Ephemeral
            });
        }

        // 立即defer以防止超时
        await interaction.deferReply({ ephemeral: true });

        const contestChannelId = interaction.options.getString('赛事频道id').trim();
        const messageType = interaction.options.getString('消息类型');

        // 获取赛事频道数据
        const contestChannelData = await getContestChannel(contestChannelId);
        if (!contestChannelData) {
            return interaction.editReply({
                content: '❌ 未找到指定的赛事频道数据。请确认频道ID是否正确。'
            });
        }

        // 检查用户权限（管理员或申请人）
        const hasPermission = checkContestManagePermission(interaction.member, contestChannelData);
        
        if (!hasPermission) {
            return interaction.editReply({
                content: getManagePermissionDeniedMessage()
            });
        }

        // 获取赛事频道对象
        let contestChannel;
        try {
            contestChannel = await interaction.client.channels.fetch(contestChannelId);
            if (!contestChannel) {
                return interaction.editReply({
                    content: '❌ 无法访问指定的频道。请确认频道ID是否正确。'
                });
            }
        } catch (error) {
            return interaction.editReply({
                content: '❌ 无法访问指定的频道。请确认频道ID是否正确且机器人有权限访问。'
            });
        }

        // 检查频道权限
        const botPermissions = contestChannel.permissionsFor(interaction.guild.members.me);
        if (!botPermissions || !botPermissions.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
            return interaction.editReply({
                content: '❌ 机器人在该频道没有足够的权限。需要：查看频道、发送消息、嵌入链接权限。'
            });
        }

        // 获取申请数据（用于生成消息内容）
        const applicationData = await getContestApplication(contestChannelData.applicationId);
        if (!applicationData) {
            return interaction.editReply({
                content: '❌ 未找到对应的申请数据，无法生成消息内容。'
            });
        }

        await interaction.editReply({
            content: '⏳ 正在生成赛事频道消息...'
        });

        const generatedMessages = {};

        // 根据选择的类型生成相应的消息
        if (messageType === 'all' || messageType === 'info') {
            const infoMessage = await generateInfoMessage(contestChannel, applicationData, contestChannelData);
            generatedMessages.info = infoMessage;
        }

        if (messageType === 'all' || messageType === 'submission') {
            const submissionMessage = await generateSubmissionMessage(contestChannel, contestChannelData);
            generatedMessages.submission = submissionMessage;
        }

        if (messageType === 'all' || messageType === 'display') {
            const displayMessage = await generateDisplayMessage(contestChannel, contestChannelData);
            generatedMessages.display = displayMessage;
        }

        // 更新数据库中的消息ID
        const updates = {};
        if (generatedMessages.info) {
            updates.contestInfo = generatedMessages.info.id;
        }
        if (generatedMessages.submission) {
            updates.submissionEntry = generatedMessages.submission.id;
        }
        if (generatedMessages.display) {
            updates.displayMessage = generatedMessages.display.id;
        }

        if (Object.keys(updates).length > 0) {
            await updateContestChannel(contestChannelId, updates);
            
            // 同步旧消息状态到新消息
            await syncDisplayMessages(interaction.client, contestChannelData, generatedMessages, contestChannelId);
        }

        // 构建结果消息
        const typeNames = {
            'info': '比赛详情',
            'submission': '投稿入口', 
            'display': '作品展示'
        };

        // 判断用户类型用于显示
        const isAdmin = checkAdminPermission(interaction.member);
        const userType = isAdmin ? '管理员' : '主办人';

        let resultText = '✅ **赛事频道消息生成完成！**\n\n';
        resultText += `📍 **目标频道：** <#${contestChannelId}>\n`;
        resultText += `🎯 **生成类型：** ${messageType === 'all' ? '全部消息' : typeNames[messageType]}\n`;
        resultText += `👤 **操作者：** ${userType}\n\n`;
        
        if (messageType === 'all') {
            resultText += '**生成的消息：**\n';
            if (generatedMessages.info) resultText += `• 📋 比赛详情 (ID: \`${generatedMessages.info.id}\`)\n`;
            if (generatedMessages.submission) resultText += `• 📝 投稿入口 (ID: \`${generatedMessages.submission.id}\`)\n`;
            if (generatedMessages.display) resultText += `• 🎨 作品展示 (ID: \`${generatedMessages.display.id}\`)\n`;
        } else {
            const messageId = Object.values(generatedMessages)[0]?.id;
            if (messageId) {
                resultText += `**消息ID：** \`${messageId}\`\n`;
            }
        }
        
        resultText += '\n📌 **所有消息已自动标注，方便用户查看。**';
        resultText += '\n🔄 **消息内容已自动同步最新的投稿数据。**';

        await interaction.editReply({
            content: resultText
        });

        console.log(`赛事频道消息重新生成完成 - 频道: ${contestChannelId}, 类型: ${messageType}, 操作者: ${interaction.user.tag} (${userType})`);

    } catch (error) {
        console.error('生成赛事频道消息时出错:', error);
        
        try {
            await interaction.editReply({
                content: `❌ 生成消息时出现错误：${error.message}`
            });
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

/**
 * 生成比赛详情消息
 */
async function generateInfoMessage(contestChannel, applicationData, contestChannelData) {
    const infoEmbed = new EmbedBuilder()
        .setTitle(`🏆 ${applicationData.formData.title}`)
        .setDescription(applicationData.formData.theme || '比赛详情')
        .setColor('#FFD700')
        .setFooter({ 
            text: `申请人: ${contestChannel.guild.members.cache.get(applicationData.applicantId)?.displayName || '未知'}`,
            iconURL: contestChannel.guild.members.cache.get(applicationData.applicantId)?.displayAvatarURL()
        })
        .setTimestamp();

    const infoMessage = await contestChannel.send({
        embeds: [infoEmbed]
    });

    // 标注消息
    try {
        await infoMessage.pin();
        console.log(`比赛详情消息已标注 - 消息ID: ${infoMessage.id}`);
    } catch (pinError) {
        console.error('标注比赛详情消息失败:', pinError);
    }

    return infoMessage;
}

/**
 * 生成投稿入口消息
 */
async function generateSubmissionMessage(contestChannel, contestChannelData) {
    let submissionDescription = '点击下方按钮提交您的参赛作品\n\n**投稿要求：**\n• 只能投稿自己的作品\n• 支持消息链接和频道链接\n• 确保作品符合比赛要求';
    
    if (contestChannelData.allowExternalServers) {
        submissionDescription += '\n\n⚠️ **外部服务器投稿说明：**\n• 本比赛允许外部服务器的作品投稿\n• 机器人无法验证外部服务器内容\n• 投稿者需对外部链接内容负责\n• 如有问题请联系赛事主办处理';
    }

    const submissionEmbed = new EmbedBuilder()
        .setTitle('📝 作品投稿入口')
        .setDescription(submissionDescription)
        .setColor('#00FF00');

    const submissionButton = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`contest_submit_${contestChannel.id}`)
                .setLabel('📝 投稿作品')
                .setStyle(ButtonStyle.Primary)
        );

    const submissionMessage = await contestChannel.send({
        embeds: [submissionEmbed],
        components: [submissionButton]
    });

    // 标注消息
    try {
        await submissionMessage.pin();
        console.log(`投稿入口消息已标注 - 消息ID: ${submissionMessage.id}`);
    } catch (pinError) {
        console.error('标注投稿入口消息失败:', pinError);
    }

    return submissionMessage;
}

/**
 * 生成作品展示消息
 */
async function generateDisplayMessage(contestChannel, contestChannelData) {
    const submissionCount = contestChannelData.totalSubmissions || 0;
    
    const displayEmbed = new EmbedBuilder()
        .setTitle('🎨 最近投稿作品展示')
        .setColor('#87CEEB');

    if (submissionCount === 0) {
        displayEmbed
            .setDescription('暂无投稿作品\n\n快来成为第一个投稿的参赛者吧！')
            .setFooter({ text: `显示最近 0 个作品 | 共 0 个作品` });
    } else {
        displayEmbed
            .setDescription(`当前共有 ${submissionCount} 个投稿作品\n\n点击下方"📋 查看所有投稿作品"按钮查看详情`)
            .setFooter({ text: `显示最近 ${Math.min(submissionCount, 5)} 个作品 | 共 ${submissionCount} 个作品` });
    }

    // 添加必要的按钮组件
    const components = [
        new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`c_ref_${contestChannel.id}`)
                    .setLabel('🔄 刷新展示')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`c_all_${contestChannel.id}`)
                    .setLabel('📋 查看所有投稿作品')
                    .setStyle(ButtonStyle.Primary)
            )
    ];

    const displayMessage = await contestChannel.send({
        embeds: [displayEmbed],
        components: components
    });

    // 标注消息
    try {
        await displayMessage.pin();
        console.log(`作品展示消息已标注 - 消息ID: ${displayMessage.id}`);
    } catch (pinError) {
        console.error('标注作品展示消息失败:', pinError);
    }

    return displayMessage;
}

/**
 * 同步新旧消息的状态，确保展示内容一致
 */
async function syncDisplayMessages(client, contestChannelData, generatedMessages, contestChannelId) {
    try {
        if (!generatedMessages.display) {
            return; // 如果没有生成新的展示消息，不需要同步
        }

        // 获取最新的投稿数据
        const submissions = await getSubmissionsByChannel(contestChannelId);
        const validSubmissions = submissions.filter(sub => sub.isValid);

        // 如果有投稿数据，更新新生成的展示消息内容
        if (validSubmissions.length > 0) {
            const { displayService } = require('../services/displayService');
            await displayService.updateDisplayMessage(
                generatedMessages.display,
                validSubmissions,
                1,
                5,
                contestChannelId
            );
            
            console.log(`新生成的展示消息已同步投稿数据 - 消息ID: ${generatedMessages.display.id}, 投稿数: ${validSubmissions.length}`);
        }

        // 清除缓存以确保数据一致性
        const { displayService } = require('../services/displayService');
        displayService.clearCache(contestChannelId);

    } catch (error) {
        console.error('同步展示消息时出错:', error);
        // 不抛出错误，避免影响主流程
    }
}

module.exports = {
    data,
    execute
}; 