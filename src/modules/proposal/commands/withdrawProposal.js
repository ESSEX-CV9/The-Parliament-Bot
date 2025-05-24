// src/commands/withdrawProposal.js
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getAllMessages, updateMessage } = require('../../../core/utils/database');
const { checkAdminPermission, getPermissionDeniedMessage } = require('../../../core/utils/permissionManager');

const data = new SlashCommandBuilder()
    .setName('withdrawproposal')
    .setDescription('撤回指定的议案')
    .addIntegerOption(option => 
        option.setName('提案id')
            .setDescription('要撤回的提案ID（数据库排序ID）')
            .setRequired(true)
            .setMinValue(1))
    .addStringOption(option => 
        option.setName('理由')
            .setDescription('撤回理由')
            .setRequired(true)
            .setMaxLength(500))
    // .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

async function execute(interaction) {
    try {
        // 检查用户权限
        const hasPermission = checkAdminPermission(interaction.member);
        
        if (!hasPermission) {
            return interaction.reply({
                content: getPermissionDeniedMessage(),
                flags: MessageFlags.Ephemeral
            });
        }
        
        // 立即defer以防止超时
        await interaction.deferReply({ ephemeral: true });
        
        const proposalId = interaction.options.getInteger('提案id');
        const reason = interaction.options.getString('理由');
        
        console.log(`用户 ${interaction.user.tag} 尝试撤回提案ID: ${proposalId}, 理由: ${reason}`);
        
        // 获取所有消息
        const allMessages = await getAllMessages();
        
        // 根据proposalId查找对应的消息
        let targetMessage = null;
        let targetMessageId = null;
        
        for (const messageId in allMessages) {
            const message = allMessages[messageId];
            if (message.proposalId === proposalId) {
                targetMessage = message;
                targetMessageId = messageId;
                break;
            }
        }
        
        if (!targetMessage) {
            return interaction.editReply({
                content: `❌ 找不到提案ID为 **${proposalId}** 的议案。`
            });
        }
        
        // 检查提案状态
        if (targetMessage.status === 'withdrawn') {
            return interaction.editReply({
                content: `❌ 提案ID **${proposalId}** 已经被撤回。`
            });
        }
        
        if (targetMessage.status === 'posted') {
            return interaction.editReply({
                content: `❌ 提案ID **${proposalId}** 已经发布到论坛，无法撤回。`
            });
        }
        
        try {
            // 获取原始消息
            const channel = await interaction.client.channels.fetch(targetMessage.channelId);
            const originalMessage = await channel.messages.fetch(targetMessageId);
            
            // 创建撤回后的嵌入消息
            const withdrawnEmbed = new EmbedBuilder()
                .setTitle(`❌ ${targetMessage.formData.title}`)
                .setDescription(`**提案人：** <@${targetMessage.authorId}>\n\n**撤回信息：**\n此提案被管理员 <@${interaction.user.id}> 撤回\n\n**撤回理由：**\n${reason}`)
                .setColor('#FF0000') // 红色表示撤回
                .setFooter({ 
                    text: `提案ID ${targetMessage.proposalId} | 已撤回`,
                    iconURL: interaction.guild.iconURL()
                })
                .setTimestamp();
            
            // 创建禁用的按钮
            const disabledButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`withdrawn_${targetMessageId}`)
                        .setLabel('❌ 已撤回')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true)
                );
            
            // 更新原消息
            await originalMessage.edit({
                embeds: [withdrawnEmbed],
                components: [disabledButton]
            });
            
            // 更新数据库状态
            await updateMessage(targetMessageId, {
                status: 'withdrawn',
                withdrawnBy: interaction.user.id,
                withdrawReason: reason,
                withdrawnAt: new Date().toISOString()
            });
            
            console.log(`成功撤回提案ID ${proposalId}, 操作者: ${interaction.user.tag}`);
            
            await interaction.editReply({
                content: `✅ 提案ID **${proposalId}** 已成功撤回。`
            });
            
        } catch (messageError) {
            console.error('更新消息时出错:', messageError);
            
            // 即使更新消息失败，也要更新数据库状态
            await updateMessage(targetMessageId, {
                status: 'withdrawn',
                withdrawnBy: interaction.user.id,
                withdrawReason: reason,
                withdrawnAt: new Date().toISOString()
            });
            
            await interaction.editReply({
                content: `⚠️ 提案ID **${proposalId}** 已在数据库中标记为撤回，但更新Discord消息时出现错误。`
            });
        }
        
    } catch (error) {
        console.error('撤回提案时出错:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: '❌ 撤回提案时出现错误，请查看控制台日志。',
                flags: MessageFlags.Ephemeral
            });
        } else {
            await interaction.editReply({
                content: '❌ 撤回提案时出现错误，请查看控制台日志。'
            });
        }
    }
}

module.exports = {
    data,
    execute,
};