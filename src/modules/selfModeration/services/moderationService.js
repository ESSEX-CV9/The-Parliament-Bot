// src\modules\selfModeration\services\moderationService.js
const { EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { getSelfModerationSettings,checkMessageTimeLimit } = require('../../../core/utils/database');
const { checkSelfModerationPermission, checkSelfModerationChannelPermission, getSelfModerationPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const { parseMessageUrl, isMessageFromSameGuild, formatMessageLink } = require('../utils/messageParser');
const { validateChannel, checkBotPermissions } = require('../utils/channelValidator');
const { createOrMergeVote, checkConflictingVote, formatVoteInfo } = require('./votingManager');
const { getShitReactionCount } = require('./reactionTracker');
const { getSelfModerationVoteEndTime, DELETE_THRESHOLD, MUTE_DURATIONS, getCurrentTimeMode, computeSeriousBase, SERIOUS_MUTE_STABILITY_CONFIG, getSeriousMuteTotalDurationMinutes } = require('../../../core/config/timeconfig');
const { getRecentSeriousMuteCount } = require('./seriousMuteHistory');
const { formatDuration } = require('../utils/timeCalculator');

/**
 * 处理所有来自自助管理模块的交互（按钮点击和嵌入窗口的提交）。
 * @param {import('discord.js').Interaction} interaction - Discord交互对象。
 */
async function processSelfModerationInteraction(interaction) {
    try {
        if (interaction.isButton()) {
            await handleSelfModerationButton(interaction);
        } else if (interaction.isModalSubmit()) {
            await handleSelfModerationModal(interaction);
        }
    } catch (error) {
        console.error('处理自助管理交互时出错:', error);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '处理请求时出现错误，请稍后重试。',
                    ephemeral: true
                });
            }
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

/**
 * 处理自助管理按钮点击
 * @param {ButtonInteraction} interaction - 按钮交互
 */
async function handleSelfModerationButton(interaction) {
    const customId = interaction.customId;
    
    if (customId === 'selfmod_delete_message') {
        await showMessageInputModal(interaction, 'delete');
    } else if (customId === 'selfmod_mute_user') {
        await showMessageInputModal(interaction, 'mute');
    }
}

/**
 * 处理自助管理模态窗口提交
 * @param {ModalSubmitInteraction} interaction - 模态窗口交互
 */
async function handleSelfModerationModal(interaction) {
    await interaction.deferReply({ ephemeral: true });
    
    const customId = interaction.customId;
    
    if (customId.startsWith('selfmod_modal_')) {
        const type = customId.replace('selfmod_modal_', '');
        const messageUrl = interaction.fields.getTextInputValue('message_url');
        
        await processMessageUrlSubmission(interaction, type, messageUrl);
    }
}

/**
 * 显示消息链接输入模态窗口
 * @param {ButtonInteraction} interaction - 按钮交互
 * @param {string} type - 操作类型 ('delete' 或 'mute')
 */
async function showMessageInputModal(interaction, type) {
    const actionName = type === 'delete' ? '删除搬屎消息' : '禁言搬屎用户';
    
    const modal = new ModalBuilder()
        .setCustomId(`selfmod_modal_${type}`)
        .setTitle(actionName);
    
    const messageUrlInput = new TextInputBuilder()
        .setCustomId('message_url')
        .setLabel('消息链接')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('请粘贴要处理的消息链接（右键消息 -> 复制消息链接）');
    
    const row = new ActionRowBuilder().addComponents(messageUrlInput);
    modal.addComponents(row);
    
    await interaction.showModal(modal);
}

/**
 * 处理用户在窗口中提交的消息链接，并启动一个自助管理投票流程。
 * @param {import('discord.js').ModalSubmitInteraction} interaction - 窗口提交的交互对象。
 * @param {string} type - 操作类型 ('delete' 或 'mute')。
 * @param {string} messageUrl - 用户提交的消息链接。
 */
async function processMessageUrlSubmission(interaction, type, messageUrl, options = {}) {
    try {
        // 获取设置
        const settings = await getSelfModerationSettings(interaction.guild.id);
        if (!settings) {
            return interaction.editReply({
                content: '❌ 该服务器未配置自助管理功能，请联系管理员设置。'
            });
        }
        
        // 检查用户权限（serious_mute 视同 mute 放行）
        const permType = (type === 'serious_mute') ? 'mute' : type;
        const hasPermission = checkSelfModerationPermission(interaction.member, permType, settings);
        if (!hasPermission) {
            return interaction.editReply({
                content: getSelfModerationPermissionDeniedMessage(permType)
            });
        }
        
        // 检查当前频道权限（用户使用指令的频道）
        const currentChannelAllowed = await validateChannel(interaction.channel.id, settings, interaction.channel);
        if (!currentChannelAllowed) {
            return interaction.editReply({
                content: '❌ 此频道不允许使用自助管理功能。请在管理员设置的允许频道中使用此指令。'
            });
        }
        
        // 解析消息链接
        const parsed = parseMessageUrl(messageUrl);
        if (!parsed) {
            return interaction.editReply({
                content: '❌ 消息链接格式无效，请确保链接是完整的Discord消息链接。'
            });
        }
        
        // 检查是否是同一服务器的消息
        if (parsed.guildId !== interaction.guild.id) {
            return interaction.editReply({
                content: '❌ 只能处理本服务器内的消息。'
            });
        }
        
        // 获取并验证目标消息
        const messageInfo = await validateTargetMessage(interaction.client, parsed);
        if (!messageInfo.success) {
            return interaction.editReply({
                content: `❌ ${messageInfo.error}`
            });
        }
        
        // 🔥 检查目标消息所在的频道是否也被授权
        const targetChannelAllowed = await validateChannel(parsed.channelId, settings, messageInfo.channel);
        if (!targetChannelAllowed) {
            // 获取频道名称用于更友好的错误提示
            let channelMention = `<#${parsed.channelId}>`;
            let channelTypeDesc = '频道';
            
            try {
                const targetChannel = messageInfo.channel;
                if (targetChannel) {
                    channelMention = targetChannel.toString();
                    
                    // 获取频道类型描述
                    const { getChannelTypeDescription } = require('../utils/channelValidator');
                    channelTypeDesc = getChannelTypeDescription(targetChannel);
                }
            } catch (error) {
                console.error('获取目标频道信息时出错:', error);
            }
            
            let errorMessage = `❌ 目标消息所在的${channelTypeDesc} ${channelMention} 不允许使用自助管理功能。\n\n`;
            errorMessage += `**权限要求：**\n`;
            errorMessage += `• 使用指令的频道必须被授权 ✅\n`;
            errorMessage += `• 目标消息所在的频道也必须被授权 ❌\n\n`;
            
            return interaction.editReply({
                content: errorMessage
            });
        }
        
        // 检查机器人权限
        const botPermissions = checkBotPermissions(messageInfo.channel, interaction.guild.members.me, type);
        if (!botPermissions.hasPermission) {
            return interaction.editReply({
                content: `❌ 机器人权限不足，缺少以下权限：${botPermissions.missingPermissions.join(', ')}`
            });
        }
        
        // 创建或合并投票
        const voteData = {
            guildId: interaction.guild.id,
            channelId: interaction.channel.id,
            targetChannelId: parsed.channelId,
            targetMessageId: parsed.messageId,
            targetUserId: messageInfo.message.author.id,
            targetMessageUrl: messageUrl,
            type: type,
            initiatorId: interaction.user.id
        };

        // 严肃禁言：注入提前删除与原消息描述配置（默认 earlyDelete = true）
        if (type === 'serious_mute') {
            voteData.earlyDelete = options.earlyDelete !== undefined ? options.earlyDelete : true;
            if (options.originalDescription) voteData.originalDescription = options.originalDescription;

            // 冻结严肃禁言基准与初始历史次数（避免在投票活动期间动态变化导致时长跳档）
            try {
                const base0 = MUTE_DURATIONS.LEVEL_1.threshold;
                const seriousBase = computeSeriousBase(base0);
                const initialPrev = await getRecentSeriousMuteCount(voteData.guildId, voteData.targetUserId);
                voteData.seriousBase = seriousBase;
                voteData.initialPrev = initialPrev;
            } catch (freezeErr) {
                console.error('[SeriousMute Freeze] 计算 seriousBase/initialPrev 时出错：', freezeErr);
            }
        }
        
        const voteResult = await createOrMergeVote(voteData);
        
        // 发送投票结果
        await sendVoteStartNotification(interaction, voteResult, messageInfo);
        
        // 回复用户
        await interaction.editReply({
            content: `✅ ${voteResult.message}`
        });
        
    } catch (error) {
        console.error('处理消息链接提交时出错:', error);
        await interaction.editReply({
            content: '❌ 处理请求时出现错误，请稍后重试。'
        });
    }
}

/**
 * 验证目标消息
 * @param {Client} client - Discord客户端
 * @param {object} parsed - 解析后的消息信息
 * @returns {object} 验证结果
 */
async function validateTargetMessage(client, parsed) {
    try {
        const { guildId, channelId, messageId } = parsed;
        
        // 获取频道
        const channel = await client.channels.fetch(channelId);
        if (!channel) {
            return { success: false, error: '找不到目标频道，可能已被删除或机器人无权访问。' };
        }
        
        // 获取消息
        const message = await channel.messages.fetch(messageId);
        if (!message) {
            return { success: false, error: '找不到目标消息，可能已被删除。' };
        }
        
        // 检查消息是否是机器人发送的
        if (message.author.bot) {
            return { success: false, error: '不能对机器人发送的消息执行自助管理操作。' };
        }
        
        // 检查消息时间限制
        const timeLimitCheck = await checkMessageTimeLimit(guildId, message.createdTimestamp);
        if (!timeLimitCheck.withinLimit) {
            const days = Math.floor(timeLimitCheck.limitHours / 24);
            const hours = timeLimitCheck.limitHours % 24;
            let limitText = '';
            if (days > 0) limitText += `${days}天`;
            if (hours > 0) limitText += `${hours}小时`;
            
            return { 
                success: false, 
                error: `该消息发送时间超过了限制（${timeLimitCheck.elapsedHours}小时前），只能对过去${limitText}内的消息进行投票。` 
            };
        }
        
        return {
            success: true,
            channel,
            message
        };
        
    } catch (error) {
        console.error('验证目标消息时出错:', error);
        return { success: false, error: '验证消息时出现错误。' };
    }
}

/**
 * 发送投票开始通知
 * @param {ModalSubmitInteraction} interaction - 交互对象
 * @param {object} voteResult - 投票结果
 * @param {object} messageInfo - 消息信息
 */
async function sendVoteStartNotification(interaction, voteResult, messageInfo) {
    try {
        const { voteData, isNewVote } = voteResult;
        const { type, targetMessageUrl, endTime, currentReactionCount, initiatorId, targetUserId } = voteData;
        
        if (!isNewVote) return; // 如果不是新投票，不发送通知
        
        const actionName = type === 'delete' ? '删除搬屎消息' : '禁言搬屎用户';
        const endTimestamp = Math.floor(new Date(endTime).getTime() / 1000);
        
        // 获取对应投票类型的表情符号
        const voteEmoji = (type === 'mute' || type === 'serious_mute') ? '🚫' : '⚠️';
        const emojiName = (type === 'mute' || type === 'serious_mute') ? '🚫' : '⚠️';
        
        // 获取当前反应数量
        const initialReactionCount = await getShitReactionCount(
            interaction.client,
            voteData.guildId,
            voteData.targetChannelId,
            voteData.targetMessageId
        );
        
        // 🔥 动态获取阈值配置
        const deleteThreshold = DELETE_THRESHOLD;
        const { calculateLinearMuteDuration, LINEAR_MUTE_CONFIG } = require('../../../core/config/timeconfig');
        
        // 🔥 获取当前时段模式
        const currentTimeMode = getCurrentTimeMode();
        const isNight = require('../../../core/config/timeconfig').isDayTime() === false;
        
        // 🔥 构建执行条件文本 - 显示线性禁言规则
        let executionCondition;
        if (type === 'delete') {
            executionCondition = `${deleteThreshold}个⚠️删除消息 (${currentTimeMode})`;
        } else {
            const muteCalc = calculateLinearMuteDuration(10, isNight); // 使用基础阈值计算
            const baseThreshold = muteCalc.threshold;
            executionCondition = `${baseThreshold}个🚫开始禁言(${LINEAR_MUTE_CONFIG.BASE_DURATION}分钟)，每票+${LINEAR_MUTE_CONFIG.ADDITIONAL_MINUTES_PER_VOTE}分钟 (${currentTimeMode})`;
        }
        
        let embed;

        if (type === 'serious_mute') {
            // 严肃禁言分支：红色样式 + 额外字段
            const base0 = MUTE_DURATIONS.LEVEL_1.threshold;
            const base = typeof voteData.seriousBase === 'number'
                ? voteData.seriousBase
                : computeSeriousBase(base0);

            // 近15天累计次数
            const guildId = voteData.guildId;
            const prev = typeof voteData.initialPrev === 'number'
                ? voteData.initialPrev
                : await getRecentSeriousMuteCount(guildId, targetUserId);

            // 若仅达基础反应的最低禁言时长
            const levelIndexMin = prev + 1;
            const minutesMin = getSeriousMuteTotalDurationMinutes(levelIndexMin);
            const minutesMinHuman = formatDuration(minutesMin);

            const seriousExecutionCondition = `${base}个🚫开始严肃禁言 (${currentTimeMode})`;

            // 新增：根据投票数据决定提前删除提示与原消息描述
            const earlyDeleteFlag = (voteData && voteData.earlyDelete !== undefined) ? voteData.earlyDelete : true;
            const originalDesc = voteData && voteData.originalDescription;

            const descIntro =
                `请前往目标消息添加🚫反应支持严肃禁言，**或者直接对本消息添加🚫反应**。\n\n` +
                `**目标消息：** ${formatMessageLink(targetMessageUrl)}\n` +
                `**消息作者：** <@${targetUserId}>\n` +
                `**发起人：** <@${initiatorId}>\n` +
                `**投票结束时间：** <t:${endTimestamp}:f>\n\n`;

            const earlyDeleteText = earlyDeleteFlag === true
                ? `达到 5 个 🚫 将立即删除被引用消息`
                : `本投票不启用提前删除。仅当禁言投票达到阈值并执行禁言时才删除原消息。`;

            embed = new EmbedBuilder()
                .setTitle('【严肃禁言】这是一场严肃禁言，请仔细思考后投票。')
                .setDescription(descIntro + earlyDeleteText)
                .setColor('#FF0000')
                .setTimestamp()
                .setFooter({
                    text: `🚫反应数量会定时检查，达到条件后会自动执行相应操作。可以对目标消息或本公告添加🚫反应，同一用户只计算一次。`
                })
                .addFields(
                    { name: '当前累计（近15天）', value: `${prev} 次`, inline: true },
                    { name: '严肃禁言阈值（当前时段）', value: `${base} 人`, inline: true },
                    { name: '若仅达基础反应的最低禁言时长', value: `${minutesMinHuman}`, inline: false },
                );

            // 若提供原消息描述，则追加显示
            if (originalDesc) {
                embed.addFields({ name: '原消息描述', value: originalDesc, inline: false });
            }
        } else {
            // 其它类型保持现状
            embed = new EmbedBuilder()
                .setTitle(`🗳️ ${actionName}投票已启动`)
                .setDescription(`有用户发起了${actionName}投票，请大家前往目标消息添加${voteEmoji}反应来表达支持，**或者直接对本消息添加${voteEmoji}反应**。\n\n**目标消息：** ${formatMessageLink(targetMessageUrl)}\n**消息作者：** <@${targetUserId}>\n**发起人：** <@${initiatorId}>\n**投票结束时间：** <t:${endTimestamp}:f>\n**当前${emojiName}数量：** ${initialReactionCount}\n**执行条件：** ${executionCondition}`)
                .setColor('#FFA500')
                .setTimestamp()
                .setFooter({
                    text: `${emojiName}反应数量会定时检查，达到条件后会自动执行相应操作。可以对目标消息或本公告添加${emojiName}反应，同一用户只计算一次。`
                });
        }
        
        // 检查是否有冲突的投票
        const conflictingVote = await checkConflictingVote(voteData.guildId, voteData.targetMessageId, type);
        if (conflictingVote) {
            const conflictActionName = conflictingVote.type === 'delete' ? '删除消息' : '禁言用户';
            embed.addFields({
                name: '⚠️ 注意',
                value: `该消息同时存在${conflictActionName}投票，如果删除消息投票先达到条件，将等待禁言投票结束后再删除消息。`,
                inline: false
            });
        }
        
        // 发送投票公告
        const announcementMessage = await interaction.channel.send({ embeds: [embed] });
        
        // 根据投票类型自动添加对应的反应到公告消息
        try {
            await announcementMessage.react(voteEmoji);
            console.log(`已为投票公告消息 ${announcementMessage.id} 添加${voteEmoji}反应`);
        } catch (error) {
            console.error('添加反应到投票公告失败:', error);
        }
        
        // 更新投票数据，保存公告消息ID
        const { updateSelfModerationVote } = require('../../../core/utils/database');
        await updateSelfModerationVote(voteData.guildId, voteData.targetMessageId, type, {
            voteAnnouncementMessageId: announcementMessage.id,
            voteAnnouncementChannelId: interaction.channel.id,
            targetUserId: targetUserId // 确保保存目标用户ID
        });
        
        console.log(`投票公告已发送，消息ID: ${announcementMessage.id}`);
        
    } catch (error) {
        console.error('发送投票通知时出错:', error);
    }
}

module.exports = {
    processSelfModerationInteraction,
    validateTargetMessage,
    processMessageUrlSubmission
};
