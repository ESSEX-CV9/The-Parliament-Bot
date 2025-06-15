const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { ElectionData } = require('../data/electionDatabase');
const { validateAdminPermission } = require('../utils/validationUtils');
const { createRegistrationEntryMessage, createErrorEmbed, createSuccessEmbed } = require('../utils/messageUtils');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('设置募选入口')
        .setDescription('设置募选的报名和投票频道')
        .addChannelOption(option =>
            option.setName('报名频道')
                .setDescription('发送报名入口的频道')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true))
        .addChannelOption(option =>
            option.setName('投票频道')
                .setDescription('发送投票入口的频道')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            // 验证权限 - 使用核心权限管理器
            if (!validateAdminPermission(interaction.member)) {
                const errorEmbed = createErrorEmbed('权限不足', '只有管理员或指定身份组成员可以设置募选入口');
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            const guildId = interaction.guild.id;
            const registrationChannel = interaction.options.getChannel('报名频道');
            const votingChannel = interaction.options.getChannel('投票频道');

            // 获取当前活跃的募选
            const election = await ElectionData.getActiveElectionByGuild(guildId);
            if (!election) {
                const errorEmbed = createErrorEmbed('未找到募选', '请先使用 `/设置募选职位` 创建募选');
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            // 检查是否已设置职位和时间安排
            if (!election.positions || Object.keys(election.positions).length === 0) {
                const errorEmbed = createErrorEmbed('未设置职位', '请先使用 `/设置募选职位` 设置职位');
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            if (!election.schedule || !election.schedule.registrationStartTime || !election.schedule.registrationEndTime) {
                const errorEmbed = createErrorEmbed('未设置时间安排', '请先使用 `/设置募选时间安排` 设置时间安排');
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            // 检查频道权限
            const botMember = interaction.guild.members.me;
            const regPermissions = registrationChannel.permissionsFor(botMember);
            const votePermissions = votingChannel.permissionsFor(botMember);
            
            if (!regPermissions.has(['SendMessages', 'EmbedLinks', 'UseExternalEmojis'])) {
                const errorEmbed = createErrorEmbed('权限不足', `机器人在报名频道 ${registrationChannel} 中缺少必要权限`);
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            if (!votePermissions.has(['SendMessages', 'EmbedLinks', 'UseExternalEmojis'])) {
                const errorEmbed = createErrorEmbed('权限不足', `机器人在投票频道 ${votingChannel} 中缺少必要权限`);
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            // 创建报名入口消息
            const registrationMessage = createRegistrationEntryMessage(election);
            
            try {
                const sentMessage = await registrationChannel.send(registrationMessage);
                
                // 更新募选配置
                await ElectionData.update(election.electionId, {
                    channels: {
                        registrationChannelId: registrationChannel.id,
                        votingChannelId: votingChannel.id
                    },
                    messageIds: {
                        registrationEntryMessageId: sentMessage.id
                    }
                });

                const successEmbed = createSuccessEmbed(
                    '募选入口设置成功',
                    `**募选名称：** ${election.name}\n\n` +
                    `📝 **报名频道：** ${registrationChannel}\n` +
                    `🗳️ **投票频道：** ${votingChannel}\n\n` +
                    `✅ 报名入口已创建，用户现在可以开始报名\n` +
                    `⏰ 投票器将在投票时间开始时自动创建`
                );

                await interaction.editReply({ embeds: [successEmbed] });

            } catch (sendError) {
                console.error('发送报名入口消息失败:', sendError);
                const errorEmbed = createErrorEmbed('发送消息失败', '无法在指定频道发送报名入口消息，请检查频道权限');
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

        } catch (error) {
            console.error('设置募选入口时出错:', error);
            const errorEmbed = createErrorEmbed('系统错误', '处理命令时发生错误，请稍后重试');
            
            if (interaction.deferred) {
                await interaction.editReply({ embeds: [errorEmbed] });
            } else {
                await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            }
        }
    }
}; 