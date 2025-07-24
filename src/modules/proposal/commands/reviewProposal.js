// src/modules/proposal/commands/reviewProposal.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getProposalSettings } = require('../utils/proposalDatabase');
const { checkProposalReviewPermission, getReviewPermissionDeniedMessage } = require('../utils/proposalPermissions');
const { processProposalReview } = require('../services/reviewService');

const data = new SlashCommandBuilder()
    .setName('审核议案')
    .setDescription('审核议案申请')
    .addIntegerOption(option => 
        option.setName('议案id')
            .setDescription('要审核的议案ID')
            .setRequired(true)
            .setMinValue(1))
    .addStringOption(option => 
        option.setName('审核结果')
            .setDescription('审核结果')
            .setRequired(true)
            .addChoices(
                { name: '✅ 通过', value: 'approved' },
                { name: '⚠️ 需要修改', value: 'modification_required' },
                { name: '❌ 拒绝', value: 'rejected' }
            ))
    .addStringOption(option => 
        option.setName('审核意见')
            .setDescription('审核意见或修改要求（可选）')
            .setRequired(false)
            .setMaxLength(500));

async function execute(interaction) {
    try {
        // 检查是否在服务器中使用
        if (!interaction.guild) {
            return interaction.reply({
                content: '❌ 此指令只能在服务器中使用，不能在私信中使用。',
                flags: MessageFlags.Ephemeral
            });
        }

        // 检查审核权限
        const proposalSettings = await getProposalSettings(interaction.guild.id);
        const hasPermission = checkProposalReviewPermission(interaction.member, proposalSettings);
        
        if (!hasPermission) {
            return interaction.reply({
                content: getReviewPermissionDeniedMessage(),
                flags: MessageFlags.Ephemeral
            });
        }

        const proposalId = interaction.options.getInteger('议案id');
        const reviewResult = interaction.options.getString('审核结果');
        const reviewReason = interaction.options.getString('审核意见') || '';
        
        console.log(`审核议案 - ID: ${proposalId}, 结果: ${reviewResult}, 审核员: ${interaction.user.tag}`);
        
        // 调用审核处理服务
        await processProposalReview(interaction, proposalId, reviewResult, reviewReason);
        
    } catch (error) {
        console.error('审核议案时出错:', error);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: `❌ 审核议案时出错：${error.message}\n请查看控制台获取详细信息。`,
                    flags: MessageFlags.Ephemeral
                });
            } else if (interaction.deferred) {
                await interaction.editReply({
                    content: `❌ 审核议案时出错：${error.message}\n请查看控制台获取详细信息。`
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