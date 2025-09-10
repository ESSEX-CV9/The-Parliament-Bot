// src\modules\court\commands\applyToCourt.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getCourtSettings } = require('../../../core/utils/database');
const { processCourtApplication } = require('../services/courtService');

const data = new SlashCommandBuilder()
    .setName('上庭-申请上庭')
    .setDescription('申请对某个成员进行处罚')
    .addUserOption(option => 
        option.setName('处罚对象')
            .setDescription('要处罚的成员')
            .setRequired(true)) // 必需选项 1
    .addStringOption(option => 
        option.setName('处罚类型')
            .setDescription('处罚类型')
            .setRequired(true) // 必需选项 2
            .addChoices(
                { name: '禁言', value: 'timeout' },
                { name: '封禁', value: 'ban' }
            ))
    .addStringOption(option => 
        option.setName('处罚理由')
            .setDescription('处罚理由')
            .setRequired(true)) // 必需选项 3 - 移到前面
    .addIntegerOption(option => 
        option.setName('禁言时长')
            .setDescription('禁言时长（天）')
            .setRequired(false) // 非必需选项 1
            .setMinValue(1)
            .setMaxValue(999))
    .addIntegerOption(option => 
        option.setName('被警告时长')
            .setDescription('被警告时长（天）')
            .setRequired(false) // 非必需选项 2
            .setMinValue(1)
            .setMaxValue(999))
    .addAttachmentOption(option => 
        option.setName('附加图片')
            .setDescription('证据图片（可选）')
            .setRequired(false)); // 非必需选项 3

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

        // 获取辩诉设置
        const courtSettings = await getCourtSettings(interaction.guild.id);
        
        if (!courtSettings) {
            return interaction.editReply({
                content: '❌ 辩诉系统尚未设置。请联系管理员使用 `/setallowcourtrole` 指令进行设置。'
            });
        }

        // 检查用户是否有辩诉身份组
        const member = interaction.member;
        const hasCourtRole = member.roles.cache.has(courtSettings.courtRoleId);
        
        if (!hasCourtRole) {
            const courtRole = await interaction.guild.roles.fetch(courtSettings.courtRoleId);
            return interaction.editReply({
                content: `❌ 您没有权限使用此指令。需要拥有 ${courtRole ? courtRole.name : '指定身份组'} 身份组。`
            });
        }

        // 获取参数
        const targetUser = interaction.options.getUser('处罚对象');
        const punishmentType = interaction.options.getString('处罚类型');
        const reason = interaction.options.getString('处罚理由');
        const timeoutDays = interaction.options.getInteger('禁言时长');
        const warningDays = interaction.options.getInteger('被警告时长');
        const attachment = interaction.options.getAttachment('附加图片');

        // 验证参数逻辑
        if (punishmentType === 'timeout') {
            if (!timeoutDays) {
                return interaction.editReply({
                    content: '❌ 选择禁言处罚时，必须指定禁言时长。'
                });
            }
        }

        // 检查目标用户是否在服务器中
        let targetMember;
        try {
            targetMember = await interaction.guild.members.fetch(targetUser.id);
        } catch (error) {
            return interaction.editReply({
                content: '❌ 目标用户不在当前服务器中。'
            });
        }

        // 不能对自己申请
        if (targetUser.id === interaction.user.id) {
            return interaction.editReply({
                content: '❌ 不能对自己申请上庭。'
            });
        }

        // 不能对机器人申请
        if (targetUser.bot) {
            return interaction.editReply({
                content: '❌ 不能对机器人申请上庭。'
            });
        }

        // 构建申请数据
        const applicationData = {
            applicantId: interaction.user.id,
            targetUserId: targetUser.id,
            punishmentType: punishmentType,
            timeoutDays: timeoutDays,
            warningDays: warningDays,
            reason: reason,
            attachment: attachment ? {
                url: attachment.url,
                name: attachment.name,
                contentType: attachment.contentType
            } : null,
            guildId: interaction.guild.id,
            timestamp: new Date().toISOString()
        };

        console.log('处理辩诉申请:', applicationData);

        // 处理申请
        try {
            await processCourtApplication(interaction, applicationData, courtSettings);
            
            await interaction.editReply({
                content: `✅ 辩诉申请已成功提交！\n\n**申请信息：**\n• **处罚对象：** ${targetUser}\n• **处罚类型：** ${punishmentType === 'timeout' ? '禁言' : '封禁'}\n• **申请理由：** ${reason}\n\n申请已发送到指定频道，需要 ${courtSettings.requiredSupports} 个支持才能创建辩诉帖。`
            });
        } catch (error) {
            console.error('处理辩诉申请时出错:', error);
            await interaction.editReply({
                content: '❌ 处理申请时出现错误，请稍后重试或联系管理员。'
            });
        }
        
    } catch (error) {
        console.error('申请上庭指令执行出错:', error);
        console.error('错误堆栈:', error.stack);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: `❌ 执行指令时出错：${error.message}`,
                    flags: MessageFlags.Ephemeral
                });
            } else {
                await interaction.editReply({
                    content: `❌ 执行指令时出错：${error.message}`
                });
            }
        } catch (replyError) {
            console.error('回复错误信息失败:', replyError);
        }
    }
}

module.exports = {
    data,
    execute,
};