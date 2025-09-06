const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { ElectionData } = require('../data/electionDatabase');
const { validatePositions, validatePermission, generateUniqueId } = require('../utils/validationUtils');
const { createSuccessEmbed, createErrorEmbed } = require('../utils/messageUtils');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('募选-设置募选职位')
        .setDescription('设置募选的职位和人数')
        .addStringOption(option =>
            option.setName('募选名称')
                .setDescription('募选的名称')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('职位配置')
                .setDescription('职位配置，格式：职位名1:人数1,职位名2:人数2 例：会长:1,副会长:2,秘书长:1')
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            // 验证权限
            if (!validatePermission(interaction.member, [])) {
                const errorEmbed = createErrorEmbed('权限不足', '只有管理员可以设置募选职位');
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            const electionName = interaction.options.getString('募选名称').trim();
            const positionConfig = interaction.options.getString('职位配置').trim();
            const guildId = interaction.guild.id;

            // 解析职位配置
            const positions = {};
            const positionPairs = positionConfig.split(',');
            
            for (let i = 0; i < positionPairs.length; i++) {
                const pair = positionPairs[i].trim();
                const [name, count] = pair.split(':').map(s => s.trim());
                
                if (!name || !count) {
                    const errorEmbed = createErrorEmbed('配置格式错误', `职位 ${i + 1}: 请使用正确的格式：职位名1:人数1,职位名2:人数2`);
                    return await interaction.editReply({ embeds: [errorEmbed] });
                }
                
                const maxWinners = parseInt(count);
                if (isNaN(maxWinners) || maxWinners < 1 || maxWinners > 10) {
                    const errorEmbed = createErrorEmbed('人数设置错误', `职位"${name}"的人数必须在1-10之间`);
                    return await interaction.editReply({ embeds: [errorEmbed] });
                }
                
                // 使用数字ID作为标识符
                const positionId = (i + 1).toString();
                
                positions[positionId] = {
                    id: positionId,
                    name: name,
                    maxWinners: maxWinners,
                    description: ''
                };
            }

            // 验证职位配置
            const validation = validatePositions(Object.values(positions));
            if (!validation.isValid) {
                const errorEmbed = createErrorEmbed('职位配置无效', validation.errors);
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            // 检查是否已存在活跃的募选
            const existingElection = await ElectionData.getActiveElectionByGuild(guildId);
            
            let election;
            if (existingElection) {
                // 更新现有募选的职位
                election = await ElectionData.update(existingElection.electionId, {
                    name: electionName,
                    positions: positions
                });
            } else {
                // 创建新募选
                const electionId = generateUniqueId('election_');
                election = await ElectionData.create({
                    electionId,
                    guildId,
                    name: electionName,
                    positions,
                    channels: {},
                    schedule: {},
                    status: 'setup',
                    messageIds: {},
                    createdBy: interaction.user.id
                });
            }

            if (!election) {
                const errorEmbed = createErrorEmbed('操作失败', '无法保存募选配置，请稍后重试');
                return await interaction.editReply({ embeds: [errorEmbed] });
            }

            // 生成职位列表显示
            const positionList = Object.values(positions)
                .map(pos => `• **${pos.name}** - ${pos.maxWinners}人`)
                .join('\n');

            const successEmbed = createSuccessEmbed(
                '募选职位设置成功',
                `募选名称：**${electionName}**\n\n**设置的职位：**\n${positionList}\n\n✅ 接下来请使用 \`/设置募选时间安排\` 设置时间安排`
            );

            await interaction.editReply({ embeds: [successEmbed] });

        } catch (error) {
            console.error('设置募选职位时出错:', error);
            const errorEmbed = createErrorEmbed('系统错误', '处理命令时发生错误，请稍后重试');
            
            if (interaction.deferred) {
                await interaction.editReply({ embeds: [errorEmbed] });
            } else {
                await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            }
        }
    }
};