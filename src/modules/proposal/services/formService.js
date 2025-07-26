// src\modules\proposal\services\formService.js
const { MessageFlags } = require('discord.js');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getSettings, saveMessage, getNextId } = require('../../../core/utils/database');
const { getProposalDeadline } = require('../../../core/config/timeconfig');
const { checkFormPermission, getFormPermissionDeniedMessage } = require('../../../core/utils/permissionManager');
const { getFormPermissionSettings } = require('../../../core/utils/database');
const { getProposalSettings, saveProposalApplication, getNextProposalId } = require('../utils/proposalDatabase');
const { ensureProposalStatusTags, updateProposalThreadStatusTag } = require('../utils/forumTagManager');

/**
 * 处理用户提交的议案。
 * @param {import('discord.js').ModalSubmitInteraction} interaction - 提交交互对象。
 */
async function processFormSubmission(interaction) {
    // 立即defer以防止超时
    await interaction.deferReply({ ephemeral: true });
    
    try {
        // 检查表单使用权限
        const formPermissionSettings = await getFormPermissionSettings(interaction.guild.id);
        const hasFormPermission = checkFormPermission(interaction.member, formPermissionSettings);
        
        if (!hasFormPermission) {
            // 获取身份组名称用于错误消息
            let allowedRoleNames = [];
            if (formPermissionSettings && formPermissionSettings.allowedRoles) {
                for (const roleId of formPermissionSettings.allowedRoles) {
                    try {
                        const role = await interaction.guild.roles.fetch(roleId);
                        if (role) allowedRoleNames.push(role.name);
                    } catch (error) {
                        // 忽略错误，继续处理其他身份组
                    }
                }
            }
            
            return interaction.editReply({
                content: getFormPermissionDeniedMessage(allowedRoleNames)
            });
        }
        
        // 获取表单数据
        const title = interaction.fields.getTextInputValue('title');
        const reason = interaction.fields.getTextInputValue('reason');
        const motion = interaction.fields.getTextInputValue('motion');
        const implementation = interaction.fields.getTextInputValue('implementation');
        const executor = interaction.fields.getTextInputValue('executor'); // 议案执行人
        
        // 从数据库获取设置
        const proposalSettings = await getProposalSettings(interaction.guild.id);
        console.log('处理表单提交，获取议案设置:', proposalSettings);
        
        if (!proposalSettings || !proposalSettings.reviewForumId) {
            return interaction.editReply({ 
                content: '议案系统未配置完整，请联系管理员设置预审核论坛。'
            });
        }
        
        // 获取预审核论坛
        const reviewForum = await interaction.client.channels.fetch(proposalSettings.reviewForumId);
        
        if (!reviewForum) {
            return interaction.editReply({ 
                content: '找不到预审核论坛。请联系管理员修复设置。'
            });
        }
        
        // 生成议案ID
        const proposalId = getNextProposalId();
        
        // 在论坛创建审核帖子
        await interaction.editReply({
            content: '⏳ 正在创建议案审核帖子...'
        });
        
        const reviewThread = await createProposalReviewThread(reviewForum, {
            title,
            reason,
            motion,
            implementation,
            executor
        }, interaction.user, proposalId);
        
        // 保存议案申请数据
        const applicationData = {
            proposalId: proposalId,
            authorId: interaction.user.id,
            guildId: interaction.guild.id,
            threadId: reviewThread.id,
            status: 'pending',
            formData: { 
                title, 
                reason, 
                motion, 
                implementation, 
                executor 
            },
            reviewData: null,
            publishData: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        await saveProposalApplication(applicationData);

        console.log(`成功创建议案申请 - ID: ${proposalId}, 审核帖子: ${reviewThread.id}`);
        
        // 回复用户
        await interaction.editReply({ 
            content: `✅ **议案提交成功！**\n\n📋 **议案ID：** \`${proposalId}\`\n🔗 **审核帖子：** ${reviewThread.url}\n\n您的议案已提交到审核论坛，请等待管理员审核。您可以在审核帖子中编辑议案内容。`
        });
    } catch (error) {
        console.error('处理表单提交时出错:', error);
        await interaction.editReply({
            content: '处理表单提交时出现错误，请稍后重试。'
        });
    }
}

/**
 * 在指定的审核论坛中为新议案创建一个审核贴子。
 * @param {import('discord.js').ForumChannel} reviewForum - 用于创建审核帖子的论坛频道对象。
 * @param {object} formData - 从表单中获取的议案数据。
 * @param {import('discord.js').User} author - 议案提交者。
 * @param {string} proposalId - 新生成的议案ID。
 * @returns {Promise<import('discord.js').ThreadChannel>} 创建的审核帖子对象。
 */
async function createProposalReviewThread(reviewForum, formData, author, proposalId) {
    // 确保论坛有所需的标签
    const tagMap = await ensureProposalStatusTags(reviewForum);
    
    // 创建审核帖子内容
    const threadContent = `👤 **提案人：** <@${author.id}>
📅 **提交时间：** <t:${Math.floor(Date.now() / 1000)}:f>
🆔 **议案ID：** \`${proposalId}\`

---

🏷️ **议案标题**
${formData.title}

📝 **提案原因**
${formData.reason}

📋 **议案动议**
${formData.motion}

🔧 **执行方案**
${formData.implementation}

👨‍💼 **议案执行人**
${formData.executor}

---

⏳ **状态：** 等待审核

管理员可使用 \`/审核议案 ${proposalId}\` 进行审核。`;
    
    // 创建编辑按钮
    const editButton = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`proposal_edit_${proposalId}`)
                .setLabel('✏️ 编辑议案')
                .setStyle(ButtonStyle.Secondary)
        );
    
    // 创建论坛帖子
    const thread = await reviewForum.threads.create({
        name: `【待审核】${formData.title}`,
        message: {
            content: threadContent,
            components: [editButton]
        },
        appliedTags: [tagMap.PENDING] // 应用待审核标签
    });
    
    return thread;
}

module.exports = {
    processFormSubmission
};