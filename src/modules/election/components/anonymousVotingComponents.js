const { 
    ActionRowBuilder, 
    StringSelectMenuBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    EmbedBuilder
} = require('discord.js');
const { ElectionData, VoteData } = require('../data/electionDatabase');
const { createErrorEmbed, createSuccessEmbed } = require('../utils/messageUtils');

/**
 * 处理匿名投票开始
 */
async function handleAnonymousVoteStart(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });

        const parts = interaction.customId.split('_');
        const electionId = parts.slice(4, -1).join('_');
        const positionId = parts[parts.length - 1];

        // 获取投票数据
        const votes = await VoteData.getByElection(electionId);
        const vote = votes.find(v => v.positionId === positionId);

        if (!vote) {
            const errorEmbed = createErrorEmbed('投票不存在', '该投票可能已被删除或不存在');
            return await interaction.editReply({ embeds: [errorEmbed] });
        }

        // 检查用户是否已投票
        const hasVoted = await VoteData.hasUserVoted(vote.voteId, interaction.user.id);
        if (hasVoted) {
            const errorEmbed = createErrorEmbed('已投票', '你已经为这个职位投过票了，不能重复投票');
            return await interaction.editReply({ embeds: [errorEmbed] });
        }

        // 创建候选人选择菜单
        const options = vote.candidates.map((candidate, index) => ({
            label: `${index + 1}. ${candidate.displayName}`,
            value: candidate.userId,
            description: candidate.choiceType === 'second' ? '第二志愿候选人' : '第一志愿候选人',
            emoji: '👤'
        }));

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`election_anonymous_vote_select_${vote.voteId}`)
            .setPlaceholder(`请选择候选人 (最多选择 ${vote.maxSelections} 人)`)
            .addOptions(options)
            .setMaxValues(Math.min(vote.maxSelections, options.length))
            .setMinValues(1);

        const row = new ActionRowBuilder().addComponents(selectMenu);

        const embed = new EmbedBuilder()
            .setTitle(`🗳️ ${vote.positionName} - 投票`)
            .setDescription(`请选择你支持的候选人 (最多选择 ${vote.maxSelections} 人)\n\n🔒 你的投票是匿名，不会被公开`)
            .setColor('#9b59b6');

        await interaction.editReply({
            embeds: [embed],
            components: [row]
        });

    } catch (error) {
        console.error('处理匿名投票开始时出错:', error);
        const errorEmbed = createErrorEmbed('系统错误', '处理投票时发生错误，请稍后重试');
        
        if (interaction.deferred) {
            await interaction.editReply({ embeds: [errorEmbed] });
        } else {
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }
    }
}

/**
 * 处理匿名投票选择
 */
async function handleAnonymousVoteSelect(interaction) {
    try {
        await interaction.deferUpdate();

        // 修复voteId提取逻辑
        // customId格式: election_anonymous_vote_select_vote_1749959096011_abc123
        const parts = interaction.customId.split('_');
        const voteId = parts.slice(4).join('_'); // 从索引4开始拼接所有部分作为voteId
        const selectedCandidates = interaction.values;

        // 获取投票数据
        const vote = await VoteData.getById(voteId);
        if (!vote) {
            const errorEmbed = createErrorEmbed('投票不存在', '该投票可能已被删除或不存在');
            return await interaction.editReply({ embeds: [errorEmbed], components: [] });
        }

        // 检查用户是否已投票
        const hasVoted = await VoteData.hasUserVoted(voteId, interaction.user.id);
        if (hasVoted) {
            const errorEmbed = createErrorEmbed('已投票', '你已经为这个职位投过票了，不能重复投票');
            return await interaction.editReply({ embeds: [errorEmbed], components: [] });
        }

        // 创建确认按钮
        const confirmButton = new ButtonBuilder()
            .setCustomId(`election_anonymous_vote_confirm_${voteId}_${selectedCandidates.join(',')}`)
            .setLabel('确认投票')
            .setStyle(ButtonStyle.Success)
            .setEmoji('✅');

        const cancelButton = new ButtonBuilder()
            .setCustomId(`election_anonymous_vote_cancel_${voteId}`)
            .setLabel('取消')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('❌');

        const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

        // 显示选择的候选人
        const selectedNames = selectedCandidates.map(candidateId => {
            const candidate = vote.candidates.find(c => c.userId === candidateId);
            return candidate ? candidate.displayName : '未知候选人';
        });

        const embed = new EmbedBuilder()
            .setTitle(`🗳️ ${vote.positionName} - 确认投票`)
            .setDescription(`你选择了以下候选人：\n\n${selectedNames.map((name, i) => `${i + 1}. **${name}**`).join('\n')}\n\n🔒 确认后你的投票将被确认归档，无法修改`)
            .setColor('#f39c12');

        await interaction.editReply({
            embeds: [embed],
            components: [row]
        });

    } catch (error) {
        console.error('处理匿名投票选择时出错:', error);
        const errorEmbed = createErrorEmbed('系统错误', '处理投票时发生错误，请稍后重试');
        await interaction.editReply({ embeds: [errorEmbed], components: [] });
    }
}

/**
 * 处理匿名投票确认
 */
async function handleAnonymousVoteConfirm(interaction) {
    try {
        await interaction.deferUpdate();

        // 修复voteId提取逻辑
        // customId格式: election_anonymous_vote_confirm_vote_1749959096011_abc123_userId1,userId2
        const parts = interaction.customId.split('_');
        // 找到最后一个包含逗号的部分（候选人列表）
        const lastPart = parts[parts.length - 1];
        const selectedCandidates = lastPart.split(',');
        
        // voteId是从索引4到倒数第二个部分
        const voteId = parts.slice(4, -1).join('_');

        // 记录匿名投票
        await VoteData.addVote(voteId, interaction.user.id, selectedCandidates);

        const successEmbed = createSuccessEmbed(
            '投票成功',
            '你的投票已记录，感谢参与选举！'
        );

        await interaction.editReply({
            embeds: [successEmbed],
            components: []
        });

    } catch (error) {
        console.error('处理匿名投票确认时出错:', error);
        const errorEmbed = createErrorEmbed('系统错误', '记录投票时发生错误，请稍后重试');
        await interaction.editReply({ embeds: [errorEmbed], components: [] });
    }
}

/**
 * 处理匿名投票取消
 */
async function handleAnonymousVoteCancel(interaction) {
    try {
        await interaction.deferUpdate();

        // 修复voteId提取逻辑
        // customId格式: election_anonymous_vote_cancel_vote_1749959096011_abc123
        const parts = interaction.customId.split('_');
        const voteId = parts.slice(4).join('_'); // 从索引4开始拼接所有部分作为voteId

        const embed = new EmbedBuilder()
            .setTitle('投票已取消')
            .setDescription('你可以重新点击投票按钮开始投票')
            .setColor('#95a5a6');

        await interaction.editReply({
            embeds: [embed],
            components: []
        });

    } catch (error) {
        console.error('处理匿名投票取消时出错:', error);
    }
}

module.exports = {
    handleAnonymousVoteStart,
    handleAnonymousVoteSelect,
    handleAnonymousVoteConfirm,
    handleAnonymousVoteCancel
}; 