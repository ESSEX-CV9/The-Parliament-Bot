const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { ElectionData } = require('../data/electionDatabase');
const { validatePermission } = require('../utils/validationUtils');
const { createRegistrationEntryMessage, createErrorEmbed, createSuccessEmbed } = require('../utils/messageUtils');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('设置报名入口')
        .setDescription('在指定频道创建选举报名入口')
        .addChannelOption(option =>
            option.setName('频道')
                .setDescription('发送报名入口的频道')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            // 验证权限
            if (!validatePermission(interaction.member, [])) {
                const errorEmbed = createErrorEmbed('权限不足', '只有管理员可以设置报名入口');
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            const guildId = interaction.guild.id;
            const channel = interaction.options.getChannel('频道') || interaction.channel;

            // 获取当前活跃的选举
            const election = await ElectionData.getActiveElectionByGuild(guildId);
            if (!election) {
                const errorEmbed = createErrorEmbed('未找到选举', '请先使用 `/设置选举职位` 创建选举');
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            // 检查是否已设置职位
            if (!election.positions || Object.keys(election.positions).length === 0) {
                const errorEmbed = createErrorEmbed('未设置职位', '请先使用 `/设置选举职位` 设置职位');
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            // 检查是否已设置时间安排
            if (!election.schedule || !election.schedule.registrationStartTime || !election.schedule.registrationEndTime) {
                const errorEmbed = createErrorEmbed('未设置时间安排', '请先使用 `/设置选举时间安排` 设置时间安排');
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            // 检查频道权限
            const botMember = interaction.guild.members.me;
            const permissions = channel.permissionsFor(botMember);
            
            if (!permissions.has(['SendMessages', 'EmbedLinks', 'UseExternalEmojis'])) {
                const errorEmbed = createErrorEmbed('权限不足', `机器人在频道 ${channel} 中缺少必要权限（发送消息、嵌入链接、使用外部表情）`);
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            // 创建报名入口消息
            const registrationMessage = createRegistrationEntryMessage(election);
            
            try {
                const sentMessage = await channel.send(registrationMessage);
                
                // 更新选举配置
                await ElectionData.update(election.electionId, {
                    channels: {
                        ...election.channels,
                        registrationChannelId: channel.id
                    },
                    messageIds: {
                        ...election.messageIds,
                        registrationEntryMessageId: sentMessage.id
                    }
                });

                const successEmbed = createSuccessEmbed(
                    '报名入口创建成功',
                    `报名入口已在 ${channel} 创建完成\n\n**选举名称：** ${election.name}\n**报名入口消息ID：** ${sentMessage.id}\n\n✅ 用户现在可以点击按钮开始报名了`
                );

                await interaction.editReply({ embeds: [successEmbed] });

            } catch (sendError) {
                console.error('发送报名入口消息失败:', sendError);
                const errorEmbed = createErrorEmbed('发送消息失败', '无法在指定频道发送报名入口消息，请检查频道权限');
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

        } catch (error) {
            console.error('设置报名入口时出错:', error);
            const errorEmbed = createErrorEmbed('系统错误', '处理命令时发生错误，请稍后重试');
            
            if (interaction.deferred) {
                await interaction.editReply({ embeds: [errorEmbed] });
            } else {
                await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            }
        }
    }
}; 