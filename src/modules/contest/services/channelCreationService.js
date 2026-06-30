// src/modules/contest/services/channelCreationService.js
const { ChannelType, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { 
    getContestApplication,
    updateContestApplication,
    saveContestChannel,
    getContestSettings
} = require('../utils/contestDatabase');
const { sendChannelCreatedNotification } = require('./notificationService');
const { onContestCreated } = require('./tournamentSyncService');
const { ensureContestStatusTags, updateThreadStatusTag } = require('../utils/forumTagManager');

async function processChannelConfirmation(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });
        
        // 从customId中提取申请ID和外部服务器设置（兼容缺失布尔段的情况）
        const customIdParts = interaction.customId.replace('contest_confirm_channel_', '').split('_');
        const applicationId = customIdParts[0];
        let allowExternalServers = false;
        if (customIdParts.length >= 2) {
            allowExternalServers = customIdParts[1] === 'true';
        }
        
        const applicationData = await getContestApplication(applicationId);
        
        if (!applicationData) {
            return interaction.editReply({
                content: '❌ 找不到对应的申请记录。'
            });
        }
        
        // 检查权限：只有申请人可以确认建立频道
        if (applicationData.applicantId !== interaction.user.id) {
            return interaction.editReply({
                content: '❌ 只有申请人可以确认建立频道。'
            });
        }
        
        // 获取表单数据
        const channelName = interaction.fields.getTextInputValue('channel_name').trim();
        const channelContent = interaction.fields.getTextInputValue('channel_content').trim();
        
        await interaction.editReply({
            content: '⏳ 正在创建赛事频道...'
        });
        
        // 创建赛事频道
        const contestChannel = await createContestChannel(
            interaction.client,
            interaction.guild,
            applicationData,
            channelName,
            channelContent,
            allowExternalServers
        );
        
        // 更新申请状态
        await updateContestApplication(applicationId, {
            status: 'completed',
            contestChannelId: contestChannel.id,
            allowExternalServers: allowExternalServers,
            completedAt: new Date().toISOString()
        });
        
        // 更新审核帖子状态为"赛事已开启"
        await updateChannelCreatedThreadStatus(interaction.client, applicationData, contestChannel);
        
        // 发送频道创建成功通知
        await sendChannelCreatedNotification(interaction.client, applicationData, contestChannel);
        
        const externalServerText = allowExternalServers ? '\n🌐 **外部服务器投稿：** 已启用' : '';
        
        await interaction.editReply({
            content: `✅ **赛事频道创建成功！**\n\n📍 **频道：** <#${contestChannel.id}>\n🏷️ **名称：** ${channelName}${externalServerText}\n\n赛事频道已准备就绪，参赛者现在可以开始投稿了！`
        });
        
        console.log(`赛事频道创建成功 - 申请ID: ${applicationId}, 频道ID: ${contestChannel.id}, 外部服务器: ${allowExternalServers}`);
        
    } catch (error) {
        console.error('处理频道确认时出错:', error);
        
        try {
            await interaction.editReply({
                content: `❌ 创建赛事频道时出现错误：${error.message}`
            });
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

async function createContestChannel(client, guild, applicationData, channelName, channelContent, allowExternalServers = false) {
    try {
        const settings = await getContestSettings(guild.id);
        
        // ========== 从申请数据获取轨道ID ==========
        const trackId = applicationData.trackId || settings?.defaultTrackId || 'default';
        console.log(`创建赛事频道 - 申请ID: ${applicationData.id}, 轨道: ${trackId}`);
        
        if (!settings || !settings.tracks || !settings.tracks[trackId]) {
            throw new Error(`轨道 ${trackId} 未配置或不存在`);
        }
        
        // 从轨道获取赛事分类ID
        const track = settings.tracks[trackId];
        const contestCategoryId = track.contestCategoryId;
        
        if (!contestCategoryId) {
            throw new Error(`轨道 ${trackId} 未设置赛事分类，无法创建频道`);
        }
        
        // 获取分类频道
        const category = await guild.channels.fetch(contestCategoryId);
        if (!category || category.type !== ChannelType.GuildCategory) {
            throw new Error('指定的赛事分类不存在或类型错误');
        }
        
        // 创建赛事频道（添加年龄限制）
        const contestChannel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: category.id,
            nsfw: true, // 设置为有年龄限制的频道
            topic: `🏆 ${applicationData.formData.title} | 主办: ${guild.members.cache.get(applicationData.applicantId)?.displayName || '未知'}${allowExternalServers ? ' | 允许外部服务器投稿' : ''}`
        });
        
        // 同步分类权限
        await contestChannel.lockPermissions();
        
        // 为申请人添加管理权限
        await contestChannel.permissionOverwrites.create(applicationData.applicantId, {
            [PermissionFlagsBits.ManageChannels]: true,
            [PermissionFlagsBits.ManageMessages]: true,
            [PermissionFlagsBits.ManageThreads]: true,
            [PermissionFlagsBits.SendMessages]: true,
            [PermissionFlagsBits.ViewChannel]: true,
            [PermissionFlagsBits.EmbedLinks]: true,
            [PermissionFlagsBits.AttachFiles]: true,
            [PermissionFlagsBits.UseExternalEmojis]: true
        });
        
        // 创建频道的三条关键消息
        const { infoMessage, submissionMessage, displayMessage } = await setupChannelMessages(
            contestChannel,
            applicationData,
            channelContent,
            allowExternalServers
        );
        
        // 保存频道数据（包含trackId）
        const channelData = {
            channelId: contestChannel.id,
            trackId: trackId, // 记录所属轨道
            applicationId: applicationData.id,
            applicantId: applicationData.applicantId,
            guildId: guild.id,
            contestTitle: applicationData.formData.title,
            contestTheme: applicationData.formData.theme, // 主题和参赛要求，用作书单简介
            contestInfo: infoMessage.id,
            submissionEntry: submissionMessage.id,
            displayMessage: displayMessage.id,
            currentPage: 1,
            itemsPerPage: settings.itemsPerPage || 6,
            totalSubmissions: 0,
            submissions: [],
            allowExternalServers: allowExternalServers,
            createdAt: new Date().toISOString()
        };
        
        await saveContestChannel(channelData);
        onContestCreated(channelData); // 静默同步到索引页，不阻塞主流程

        console.log(`赛事频道数据已保存 - 频道: ${contestChannel.id} (年龄限制已启用), 轨道: ${trackId}, 外部服务器: ${allowExternalServers}`);
        
        return contestChannel;
        
    } catch (error) {
        console.error('创建赛事频道时出错:', error);
        throw error;
    }
}

async function setupChannelMessages(contestChannel, applicationData, channelContent, allowExternalServers = false) {
    try {
        // 第一条消息：赛事信息
        const infoEmbed = new EmbedBuilder()
            .setTitle(`🏆 ${applicationData.formData.title}`)
            .setDescription(channelContent)
            .setColor('#FFD700')
            .setFooter({ 
                text: `申请人: ${contestChannel.guild.members.cache.get(applicationData.applicantId)?.displayName || '未知'}`,
                iconURL: contestChannel.guild.members.cache.get(applicationData.applicantId)?.displayAvatarURL()
            })
            .setTimestamp();
        
        const infoMessage = await contestChannel.send({
            embeds: [infoEmbed]
        });
        
        // 第二条消息：投稿入口
        let submissionDescription = '点击下方按钮提交您的参赛作品\n\n**投稿要求：**\n• 只能投稿自己的作品\n• 支持消息链接和频道链接\n• 确保作品符合比赛要求';
        
        if (allowExternalServers) {
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
        
        // 第三条消息：作品展示区域
        const displayEmbed = new EmbedBuilder()
            .setTitle('🎨 参赛作品展示')
            .setDescription('暂无投稿作品\n\n快来成为第一个投稿的参赛者吧！')
            .setColor('#87CEEB')
            .setFooter({ text: '第 1 页 | 共 0 个作品' });
        
        const displayMessage = await contestChannel.send({
            embeds: [displayEmbed]
        });
        
        // 自动标注三条关键消息
        try {
            await infoMessage.pin();
            await submissionMessage.pin();
            await displayMessage.pin();
            console.log(`三条关键消息已标注 - 频道: ${contestChannel.id}`);
        } catch (pinError) {
            console.error('标注消息失败:', pinError);
            // 不抛出错误，避免影响主流程
        }
        
        console.log(`赛事频道消息已创建 - 频道: ${contestChannel.id}`);
        
        return {
            infoMessage,
            submissionMessage,
            displayMessage
        };
        
    } catch (error) {
        console.error('设置频道消息时出错:', error);
        throw error;
    }
}

/**
 * 更新审核帖子状态为"赛事已开启"
 */
async function updateChannelCreatedThreadStatus(client, applicationData, contestChannel) {
    try {
        const thread = await client.channels.fetch(applicationData.threadId);
        const firstMessage = await thread.fetchStarterMessage();
        
        if (!firstMessage) {
            throw new Error('找不到要更新的初始消息');
        }
        
        // 确保论坛标签
        const tagMap = await ensureContestStatusTags(thread.parent);
        
        // 构建更新的内容
        const formData = applicationData.formData;
        const updatedContent = `👤 **申请人：** <@${applicationData.applicantId}>
📅 **申请时间：** <t:${Math.floor(new Date(applicationData.createdAt).getTime() / 1000)}:f>
🆔 **申请ID：** \`${applicationData.id}\`
👨‍💼 **审核员：** <@${applicationData.reviewData.reviewerId}>
📅 **审核时间：** <t:${Math.floor(new Date(applicationData.reviewData.reviewedAt).getTime() / 1000)}:f>
🏆 **赛事频道：** ${contestChannel}

---

🏆 **比赛标题**
${formData.title}

📝 **主题和参赛要求**
${formData.theme}

⏰ **比赛持续时间**
${formData.duration}

🎖️ **奖项设置和评价标准**
${formData.awards}

${formData.notes ? `📋 **注意事项和其他补充**\n${formData.notes}\n\n` : ''}---

🎉 **状态：** 赛事已开启

${applicationData.reviewData.reason ? `💬 **审核意见：** ${applicationData.reviewData.reason}\n\n` : ''}`;
        
        // 移除所有按钮，显示已开启状态
        const components = [
            new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`contest_opened_${applicationData.id}`)
                        .setLabel('🎉 赛事已开启')
                        .setStyle(ButtonStyle.Success)
                        .setDisabled(true)
                )
        ];
        
        await firstMessage.edit({
            content: updatedContent,
            components: components
        });
        
        // 更新标签状态
        await updateThreadStatusTag(thread, 'CHANNEL_CREATED', tagMap);
        
        console.log(`频道创建状态已更新 - 帖子: ${thread.id}`);
        
    } catch (error) {
        console.error('更新频道创建状态时出错:', error);
        throw error;
    }
}

module.exports = {
    processChannelConfirmation,
    createContestChannel
};