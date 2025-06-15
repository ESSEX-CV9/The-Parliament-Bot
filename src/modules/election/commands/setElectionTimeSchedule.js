const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { ElectionData } = require('../data/electionDatabase');
const { validatePermission } = require('../utils/validationUtils');
const { parseElectionTime, validateTimeRange } = require('../utils/timeUtils');
const { createSuccessEmbed, createErrorEmbed } = require('../utils/messageUtils');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('设置选举时间安排')
        .setDescription('设置选举的时间安排')
        .addStringOption(option =>
            option.setName('报名开始时间')
                .setDescription('报名开始时间 (格式: YYYY-MM-DD HH:mm)')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('报名结束时间')
                .setDescription('报名结束时间 (格式: YYYY-MM-DD HH:mm)')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('投票开始时间')
                .setDescription('投票开始时间 (格式: YYYY-MM-DD HH:mm，默认为报名结束时间)')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('投票结束时间')
                .setDescription('投票结束时间 (格式: YYYY-MM-DD HH:mm)')
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            // 验证权限
            if (!validatePermission(interaction.member, [])) {
                const errorEmbed = createErrorEmbed('权限不足', '只有管理员可以设置选举时间安排');
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            const guildId = interaction.guild.id;

            // 获取当前活跃的选举
            const election = await ElectionData.getActiveElectionByGuild(guildId);
            if (!election) {
                const errorEmbed = createErrorEmbed('未找到选举', '请先使用 `/设置选举职位` 创建选举');
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            // 解析时间参数
            const regStartStr = interaction.options.getString('报名开始时间');
            const regEndStr = interaction.options.getString('报名结束时间');
            const voteStartStr = interaction.options.getString('投票开始时间') || regEndStr;
            const voteEndStr = interaction.options.getString('投票结束时间');

            // 解析时间
            const registrationStartTime = parseElectionTime(regStartStr);
            const registrationEndTime = parseElectionTime(regEndStr);
            const votingStartTime = parseElectionTime(voteStartStr);
            const votingEndTime = parseElectionTime(voteEndStr);

            // 验证时间解析结果
            if (!registrationStartTime || !registrationEndTime || !votingStartTime || !votingEndTime) {
                const errorEmbed = createErrorEmbed('时间格式错误', '请使用正确的时间格式：YYYY-MM-DD HH:mm');
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            // 验证报名时间范围
            const regTimeValidation = validateTimeRange(registrationStartTime, registrationEndTime);
            if (!regTimeValidation.isValid) {
                const errorEmbed = createErrorEmbed('报名时间设置错误', regTimeValidation.errors);
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            // 验证投票时间范围
            const voteTimeValidation = validateTimeRange(votingStartTime, votingEndTime);
            if (!voteTimeValidation.isValid) {
                const errorEmbed = createErrorEmbed('投票时间设置错误', voteTimeValidation.errors);
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            // 验证时间逻辑
            const errors = [];
            
            if (registrationEndTime > votingStartTime) {
                errors.push('报名结束时间不能晚于投票开始时间');
            }
            
            if (votingStartTime < registrationEndTime) {
                errors.push('投票开始时间不能早于报名结束时间');
            }

            if (errors.length > 0) {
                const errorEmbed = createErrorEmbed('时间逻辑错误', errors);
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            // 更新选举时间安排
            const schedule = {
                registrationStartTime: registrationStartTime.toISOString(),
                registrationEndTime: registrationEndTime.toISOString(),
                votingStartTime: votingStartTime.toISOString(),
                votingEndTime: votingEndTime.toISOString()
            };

            const updatedElection = await ElectionData.update(election.electionId, {
                schedule
            });

            if (!updatedElection) {
                const errorEmbed = createErrorEmbed('操作失败', '无法保存时间安排，请稍后重试');
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            // 生成时间安排显示
            const { formatChineseTime } = require('../utils/timeUtils');
            const timeInfo = [
                `📝 **报名时间**`,
                `开始：${formatChineseTime(registrationStartTime)}`,
                `结束：${formatChineseTime(registrationEndTime)}`,
                '',
                `🗳️ **投票时间**`,
                `开始：${formatChineseTime(votingStartTime)}`,
                `结束：${formatChineseTime(votingEndTime)}`
            ].join('\n');

            const successEmbed = createSuccessEmbed(
                '选举时间安排设置成功',
                `**${election.name}**\n\n${timeInfo}\n\n✅ 接下来可以使用 \`/设置报名入口\` 创建报名入口`
            );

            await interaction.editReply({ embeds: [successEmbed] });

        } catch (error) {
            console.error('设置选举时间安排时出错:', error);
            const errorEmbed = createErrorEmbed('系统错误', '处理命令时发生错误，请稍后重试');
            
            if (interaction.deferred) {
                await interaction.editReply({ embeds: [errorEmbed] });
            } else {
                await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            }
        }
    }
}; 