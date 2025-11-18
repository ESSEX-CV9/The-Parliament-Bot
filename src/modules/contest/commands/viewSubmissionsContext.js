// src/modules/contest/commands/viewSubmissionsContext.js
const { ContextMenuCommandBuilder, ApplicationCommandType, MessageFlags } = require('discord.js');
const { getContestChannel } = require('../utils/contestDatabase');
const { displayService } = require('../services/displayService');

const data = new ContextMenuCommandBuilder()
    .setName('查看赛事稿件')
    .setType(ApplicationCommandType.Message);

async function execute(interaction) {
    try {
        // 检查是否在服务器中使用
        if (!interaction.guild) {
            return interaction.reply({
                content: '❌ 此指令只能在服务器中使用，不能在私信中使用。',
                flags: MessageFlags.Ephemeral
            });
        }

        const channelId = interaction.channel.id;

        // 检查当前频道是否为赛事频道
        const contestChannelData = await getContestChannel(channelId);
        
        if (!contestChannelData) {
            return interaction.reply({
                content: '❌ 此频道不是赛事频道。\n\n💡 提示：此指令只能在赛事频道中使用。',
                flags: MessageFlags.Ephemeral
            });
        }

        // 构造一个兼容的 interaction 对象，模拟按钮点击
        // 复用现有的 handleViewAllSubmissions 逻辑
        const mockInteraction = {
            ...interaction,
            customId: `c_all_${channelId}`,
            isButton: () => false,
            isMessageContextMenuCommand: () => true
        };

        // 调用现有的展示逻辑
        await displayService.handleViewAllSubmissions(mockInteraction);

        console.log(`用户通过右键指令查看赛事稿件 - 频道: ${channelId}, 用户: ${interaction.user.tag}`);

    } catch (error) {
        console.error('查看赛事稿件时出错:', error);
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: `❌ 查看稿件时出错：${error.message}\n请查看控制台获取详细信息。`,
                    flags: MessageFlags.Ephemeral
                });
            } else if (interaction.deferred) {
                await interaction.editReply({
                    content: `❌ 查看稿件时出错：${error.message}\n请查看控制台获取详细信息。`
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