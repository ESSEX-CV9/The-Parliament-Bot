// src/modules/contest/services/applicationService.js
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { 
    getNextApplicationId, 
    saveContestApplication,
    updateContestApplication,
    getContestApplication 
} = require('../utils/contestDatabase');
const { ensureContestStatusTags, updateThreadStatusTag } = require('../utils/forumTagManager');

async function processContestApplication(interaction) {
    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        
        console.log(`处理赛事申请 - 用户: ${interaction.user.tag}`);
        
        // ========== 解析轨道ID ==========
        // 从按钮customId解析轨道ID
        // 格式: contest_application_{trackId} 或旧格式 contest_application
        let trackId;
        const customId = interaction.customId || '';
        
        if (customId.startsWith('contest_application_')) {
            // 新格式，提取轨道ID
            trackId = customId.replace('contest_application_', '');
            console.log(`检测到新格式按钮，轨道ID: ${trackId}`);
        } else {
            // 旧格式，使用默认轨道
            const { getContestSettings } = require('../utils/contestDatabase');
            const tempSettings = await getContestSettings(interaction.guild.id);
            trackId = tempSettings?.defaultTrackId || 'default';
            console.log(`检测到旧格式按钮，使用默认轨道: ${trackId}`);
        }
        
        // 获取表单数据
        const formData = {
            title: interaction.fields.getTextInputValue('contest_title'),
            theme: interaction.fields.getTextInputValue('contest_theme'),
            duration: interaction.fields.getTextInputValue('contest_duration'),
            awards: interaction.fields.getTextInputValue('contest_awards'),
            notes: interaction.fields.getTextInputValue('contest_notes') || ''
        };
        
        const { getContestSettings } = require('../utils/contestDatabase');
        const settings = await getContestSettings(interaction.guild.id);
        
        if (!settings || !settings.tracks || !settings.tracks[trackId]) {
            return interaction.editReply({
                content: `❌ 赛事系统未配置完整或轨道 \`${trackId}\` 不存在，请联系管理员设置。`
            });
        }
        
        // 从轨道获取审批论坛ID
        const track = settings.tracks[trackId];
        const reviewForumId = track.reviewForumId;
        
        if (!reviewForumId) {
            return interaction.editReply({
                content: `❌ 轨道 \`${trackId}\` 未配置审批论坛，请联系管理员设置。`
            });
        }
        
        // 获取审批论坛
        const reviewForum = await interaction.client.channels.fetch(reviewForumId);
        if (!reviewForum) {
            return interaction.editReply({
                content: '❌ 无法访问审批论坛，请联系管理员检查设置。'
            });
        }
        
        // 生成申请ID
        const applicationId = getNextApplicationId();
        
        // 在论坛创建审核帖子
        await interaction.editReply({
            content: '⏳ 正在创建申请帖子...'
        });
        
        const reviewThread = await createReviewThread(reviewForum, formData, interaction.user, applicationId);
        
        // 保存申请数据（包含trackId）
        const applicationData = {
            id: applicationId,
            trackId: trackId, // 记录所属轨道
            applicantId: interaction.user.id,
            guildId: interaction.guild.id,
            threadId: reviewThread.id,
            status: 'pending',
            formData: formData,
            reviewData: null,
            channelId: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        
        await saveContestApplication(applicationData);
        
        console.log(`成功创建赛事申请 - ID: ${applicationId}, 轨道: ${trackId}, 帖子: ${reviewThread.id}`);
        
        const trackName = track.name || trackId;
        await interaction.editReply({
            content: `✅ **申请提交成功！**\n\n📋 **申请ID：** \`${applicationId}\`\n🛤️ **轨道：** ${trackName}\n🔗 **审核帖子：** ${reviewThread.url}\n\n您的申请已提交到审核论坛，请等待管理员审核。您可以在审核帖子中编辑申请内容。`
        });
        
    } catch (error) {
        console.error('处理赛事申请时出错:', error);
        
        try {
            await interaction.editReply({
                content: `❌ 处理申请时出现错误：${error.message}\n请稍后重试或联系管理员。`
            });
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

async function createReviewThread(reviewForum, formData, applicant, applicationId) {
    // 确保论坛有所需的标签
    const tagMap = await ensureContestStatusTags(reviewForum);
    
    // 创建审核帖子内容
    const threadContent = `👤 **申请人：** <@${applicant.id}>
📅 **申请时间：** <t:${Math.floor(Date.now() / 1000)}:f>
🆔 **申请ID：** \`${applicationId}\`

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

⏳ **状态：** 等待审核

管理员可使用 \`/审核赛事申请 ${applicationId}\` 进行审核。`;
    
    // 创建编辑按钮
    const editButton = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`contest_edit_${applicationId}`)
                .setLabel('✏️ 编辑申请')
                .setStyle(ButtonStyle.Secondary)
        );
    
    // 创建论坛帖子，标题只显示【待审核】前缀
    const thread = await reviewForum.threads.create({
        name: `【待审核】${formData.title}`,
        message: {
            content: threadContent,
            components: [editButton]
        },
        appliedTags: [tagMap.PENDING] // 应用待审核标签
    });
    
    // 设置帖子权限
    await setupReviewThreadPermissions(thread, applicant.id);

    // 发送申请通知 @ 身份组
    try {
        const { getContestSettings } = require('../utils/contestDatabase');
        const notifySettings = await getContestSettings(reviewForum.guild.id);
        const notifyRoles = notifySettings?.applicationNotifyRoles || [];
        if (notifyRoles.length > 0) {
            const mentions = notifyRoles.map(id => `<@&${id}>`).join(' ');
            await thread.send({
                content: `${mentions}\n📋 有新的赛事申请待审核，申请ID：\`${applicationId}\``
            });
        }
    } catch (error) {
        console.error('发送申请通知时出错:', error);
        // 不影响主流程
    }

    return thread;
}

async function setupReviewThreadPermissions(thread, applicantId) {
    try {
        const { getContestSettings } = require('../utils/contestDatabase');
        const settings = await getContestSettings(thread.guild.id);
        
        // 检查thread是否有permissionOverwrites属性
        if (!thread.permissionOverwrites) {
            console.log(`论坛帖子 ${thread.id} 不支持权限覆盖，跳过权限设置`);
            return;
        }
        
        // 允许申请人发言
        await thread.permissionOverwrites.create(applicantId, {
            SendMessages: true,
            ViewChannel: true
        });
        
        // 如果设置了审核员身份组，给予发言权限
        if (settings && settings.reviewerRoles) {
            for (const roleId of settings.reviewerRoles) {
                try {
                    await thread.permissionOverwrites.create(roleId, {
                        SendMessages: true,
                        ViewChannel: true
                    });
                } catch (error) {
                    console.error(`设置审核员身份组权限失败 ${roleId}:`, error);
                }
            }
        }
        
        console.log(`成功设置审核帖子权限 - 帖子: ${thread.id}`);
        
    } catch (error) {
        console.error('设置审核帖子权限时出错:', error);
        // 不要抛出错误，让流程继续
    }
}

async function processEditApplication(interaction) {
    try {
        // 从按钮ID中提取申请ID
        const applicationId = interaction.customId.replace('contest_edit_', '');
        const applicationData = await getContestApplication(applicationId);
        
        if (!applicationData) {
            return interaction.reply({
                content: '❌ 找不到对应的申请记录。',
                ephemeral: true
            });
        }
        
        // 检查权限：只有申请人可以编辑
        if (applicationData.applicantId !== interaction.user.id) {
            return interaction.reply({
                content: '❌ 只有申请人可以编辑申请内容。',
                ephemeral: true
            });
        }
        
        // 检查状态：只有待审核或要求修改的申请可以编辑
        if (!['pending', 'modification_required'].includes(applicationData.status)) {
            return interaction.reply({
                content: '❌ 当前申请状态不允许编辑。',
                ephemeral: true
            });
        }
        
        const { createEditApplicationModal } = require('../components/applicationModal');
        const modal = createEditApplicationModal(applicationData.formData);
        
        // 直接显示模态窗口，不要先 defer
        await interaction.showModal(modal);
        
    } catch (error) {
        console.error('处理编辑申请时出错:', error);
        
        // 如果还没有回复过，则回复错误信息
        if (!interaction.replied && !interaction.deferred) {
            try {
                await interaction.reply({
                    content: `❌ 处理编辑请求时出现错误：${error.message}`,
                    ephemeral: true
                });
            } catch (replyError) {
                console.error('回复错误信息失败:', replyError);
            }
        }
    }
}

async function processEditApplicationSubmission(interaction) {
    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        
        // 获取申请ID（从modal的customId中提取）
        const applicationId = await findApplicationIdFromThread(interaction.channel.id);
        
        if (!applicationId) {
            return interaction.editReply({
                content: '❌ 无法确定申请ID，请重新尝试。'
            });
        }
        
        const applicationData = await getContestApplication(applicationId);
        if (!applicationData) {
            return interaction.editReply({
                content: '❌ 找不到对应的申请记录。'
            });
        }
        
        // 保存原始状态，用于判断是否需要更新标签
        const originalStatus = applicationData.status;
        
        // 获取更新的表单数据
        const updatedFormData = {
            title: interaction.fields.getTextInputValue('contest_title'),
            theme: interaction.fields.getTextInputValue('contest_theme'),
            duration: interaction.fields.getTextInputValue('contest_duration'),
            awards: interaction.fields.getTextInputValue('contest_awards'),
            notes: interaction.fields.getTextInputValue('contest_notes') || ''
        };
        
        // 更新数据库
        await updateContestApplication(applicationId, {
            formData: updatedFormData,
            status: 'pending', // 重新设为待审核
            updatedAt: new Date().toISOString()
        });
        
        // 更新帖子内容
        await interaction.editReply({
            content: '⏳ 正在更新申请内容...'
        });
        
        await updateReviewThreadContent(interaction.client, applicationData.threadId, updatedFormData, interaction.user, applicationId, originalStatus);
        
        await interaction.editReply({
            content: '✅ 申请内容已成功更新！'
        });
        
        console.log(`申请已更新 - ID: ${applicationId}, 用户: ${interaction.user.tag}`);
        
    } catch (error) {
        console.error('处理编辑申请提交时出错:', error);
        
        try {
            await interaction.editReply({
                content: `❌ 更新申请时出现错误：${error.message}`
            });
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

async function updateReviewThreadContent(client, threadId, formData, applicant, applicationId, originalStatus) {
    try {
        const thread = await client.channels.fetch(threadId);
        const firstMessage = await thread.fetchStarterMessage();
        
        if (!firstMessage) {
            throw new Error('找不到要更新的初始消息');
        }

        const updatedContent = `👤 **申请人：** <@${applicant.id}>
📅 **申请时间：** <t:${Math.floor(Date.now() / 1000)}:f>
🆔 **申请ID：** \`${applicationId}\`
🔄 **最后更新：** <t:${Math.floor(Date.now() / 1000)}:f>

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

⏳ **状态：** 等待审核

管理员可使用 \`/审核赛事申请 ${applicationId}\` 进行审核。`;
        
        // 重新创建编辑按钮
        const editButton = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`contest_edit_${applicationId}`)
                    .setLabel('✏️ 编辑申请')
                    .setStyle(ButtonStyle.Secondary)
            );
        
        await firstMessage.edit({
            content: updatedContent,
            components: [editButton]
        });
        
        // 只有标题内容变化时才更新帖子标题
        const currentTitle = thread.name;
        const newTitle = `【待审核】${formData.title}`;
        
        if (currentTitle !== newTitle) {
            await thread.setName(newTitle);
        }
        
        // 如果原始状态是要求修改，则更新为待再审状态
        if (originalStatus === 'modification_required') {
            try {
                const tagMap = await ensureContestStatusTags(thread.parent);
                await updateThreadStatusTag(thread, 'PENDING_RECHECK', tagMap);
                console.log(`申请状态从"要求修改"更新为"待再审" - 申请ID: ${applicationId}`);
            } catch (tagError) {
                console.error('更新标签失败:', tagError);
                // 标签更新失败不影响主流程
            }
        } else {
            // 其他情况更新为普通的待审核状态
            try {
                const tagMap = await ensureContestStatusTags(thread.parent);
                await updateThreadStatusTag(thread, 'PENDING', tagMap);
                console.log(`申请状态更新为"待审核" - 申请ID: ${applicationId}`);
            } catch (tagError) {
                console.error('更新标签失败:', tagError);
                // 标签更新失败不影响主流程
            }
        }
        
    } catch (error) {
        console.error('更新审核帖子内容时出错:', error);
        throw error;
    }
}

// 辅助函数：从帖子ID查找申请ID
async function findApplicationIdFromThread(threadId) {
    try {
        const { getAllContestApplications } = require('../utils/contestDatabase');
        const applications = await getAllContestApplications();
        
        // 遍历所有申请，查找匹配的threadId
        for (const appId in applications) {
            const app = applications[appId];
            if (app.threadId === threadId) {
                return app.id;
            }
        }
        
        console.log(`未找到threadId ${threadId} 对应的申请ID`);
        console.log('当前所有申请:', Object.keys(applications));
        return null;
    } catch (error) {
        console.error('查找申请ID时出错:', error);
        return null;
    }
}

module.exports = {
    processContestApplication,
    processEditApplication,
    processEditApplicationSubmission,
    updateReviewThreadContent
};