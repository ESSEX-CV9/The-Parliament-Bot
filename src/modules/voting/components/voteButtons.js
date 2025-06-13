const { getVoteData, saveVoteData } = require('../services/voteManager');
const { updateVotePanel, createVoteResultEmbed } = require('./votePanel');

async function handleVoteButton(interaction) {
    try {
        const customId = interaction.customId;
        
        if (customId.startsWith('vote_result_')) {
            await handleVoteResultButton(interaction);
        } else if (customId.startsWith('vote_')) {
            await handleVoteOptionButton(interaction);
        }
    } catch (error) {
        console.error('处理投票按钮错误:', error);
        await interaction.reply({
            content: '❌ 投票失败，请稍后重试',
            ephemeral: true
        });
    }
}

async function handleVoteOptionButton(interaction) {
    // 修复解析逻辑：考虑voteId本身包含下划线的情况
    // customId格式: vote_vote_mbuoia09_5d90e04b_0
    const customId = interaction.customId;
    
    // 找到最后一个下划线，分离选项索引
    const lastUnderscoreIndex = customId.lastIndexOf('_');
    const optionIndex = parseInt(customId.substring(lastUnderscoreIndex + 1));
    
    // 提取voteId（去除开头的'vote_'和结尾的'_选项索引'）
    const voteId = customId.substring(5, lastUnderscoreIndex); // 从第5位开始（跳过'vote_'）到最后一个下划线
    
    console.log(`投票按钮解析: customId=${customId}, voteId=${voteId}, optionIndex=${optionIndex}`);
    
    // 获取投票数据
    const voteData = await getVoteData(voteId);
    if (!voteData) {
        await interaction.reply({
            content: '❌ 投票不存在或已过期',
            ephemeral: true
        });
        return;
    }
    
    // 检查投票是否已结束
    if (new Date() > voteData.endTime) {
        await interaction.reply({
            content: '❌ 投票已结束',
            ephemeral: true
        });
        return;
    }
    
    // 检查用户权限
    if (voteData.allowedRoles.length > 0) {
        const member = interaction.member;
        const hasPermission = voteData.allowedRoles.some(roleId => 
            member.roles.cache.has(roleId)
        );
        
        if (!hasPermission) {
            await interaction.reply({
                content: '❌ 您没有权限参与此投票',
                ephemeral: true
            });
            return;
        }
    }
    
    // 检查选项是否有效
    if (optionIndex < 0 || optionIndex >= voteData.options.length) {
        await interaction.reply({
            content: '❌ 无效的投票选项',
            ephemeral: true
        });
        return;
    }
    
    const selectedOption = voteData.options[optionIndex];
    const userId = interaction.user.id;
    
    // 检查用户是否已经投过票
    let hasVoted = false;
    let previousOption = null;
    
    for (const [option, voters] of Object.entries(voteData.votes)) {
        const voterIndex = voters.indexOf(userId);
        if (voterIndex !== -1) {
            hasVoted = true;
            previousOption = option;
            // 移除之前的投票
            voters.splice(voterIndex, 1);
            break;
        }
    }
    
    // 如果投票同一个选项，则取消投票
    if (previousOption === selectedOption) {
        await saveVoteData(voteData);
        
        await interaction.reply({
            content: `✅ 已取消对"${selectedOption}"的投票`,
            ephemeral: true
        });
    } else {
        // 添加新投票
        if (!voteData.votes[selectedOption]) {
            voteData.votes[selectedOption] = [];
        }
        voteData.votes[selectedOption].push(userId);
        
        await saveVoteData(voteData);
        
        const message = hasVoted 
            ? `✅ 已将投票从"${previousOption}"更改为"${selectedOption}"`
            : `✅ 已投票给"${selectedOption}"`;
            
        await interaction.reply({
            content: message,
            ephemeral: true
        });
    }
    
    // 更新投票面板
    if (voteData.isRealTime) {
        const { embed, components } = updateVotePanel(voteData);
        await interaction.message.edit({
            embeds: [embed],
            components: components
        });
    }
}

async function handleVoteResultButton(interaction) {
    // 修复解析逻辑：customId格式为 vote_result_vote_mbuoia09_5d90e04b
    const voteId = interaction.customId.substring(12); // 去除开头的'vote_result_'
    
    console.log(`查看结果按钮解析: customId=${interaction.customId}, voteId=${voteId}`);
    
    // 获取投票数据
    const voteData = await getVoteData(voteId);
    if (!voteData) {
        await interaction.reply({
            content: '❌ 投票不存在或已过期',
            ephemeral: true
        });
        return;
    }
    
    // 创建结果嵌入消息
    const resultEmbed = createVoteResultEmbed(voteData);
    
    await interaction.reply({
        embeds: [resultEmbed],
        ephemeral: true
    });
}

module.exports = {
    handleVoteButton,
    handleVoteOptionButton,
    handleVoteResultButton
}; 