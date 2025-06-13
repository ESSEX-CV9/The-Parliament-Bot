const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

function createVotePanel(voteData) {
    const { title, options, endTime, isAnonymous, isRealTime, votes, voteId } = voteData;
    
    // 创建嵌入消息
    const embed = new EmbedBuilder()
        .setTitle(`📊 ${title}`)
        .setColor(0x0099FF)
        .setFooter({ 
            text: `投票ID: ${voteId} | ${isAnonymous ? '匿名投票' : '实名投票'}` 
        })
        .setTimestamp();

    // 计算投票结果
    const totalVotes = Object.values(votes).reduce((total, voters) => total + voters.length, 0);
    
    let description = '';
    
    if (isRealTime && totalVotes > 0) {
        // 实时显示票数
        description += '**当前投票结果：**\n';
        options.forEach((option, index) => {
            const voteCount = votes[option]?.length || 0;
            const percentage = totalVotes > 0 ? ((voteCount / totalVotes) * 100).toFixed(1) : 0;
            const progressBar = createProgressBar(voteCount, totalVotes);
            description += `${index + 1}️⃣ ${option}: ${voteCount}票 (${percentage}%)\n${progressBar}\n\n`;
        });
        description += `总票数: ${totalVotes}\n\n`;
    } else if (!isRealTime) {
        // 不实时显示
        description += '**投票选项：**\n';
        options.forEach((option, index) => {
            description += `${index + 1}️⃣ ${option}\n`;
        });
        description += `\n总参与人数: ${totalVotes}\n\n`;
    } else {
        // 还没有投票
        description += '**投票选项：**\n';
        options.forEach((option, index) => {
            description += `${index + 1}️⃣ ${option}\n`;
        });
        description += '\n';
    }

    // 添加结束时间
    description += `⏰ 投票截止: <t:${Math.floor(endTime.getTime() / 1000)}:F>\n`;
    description += `⏱️ 剩余时间: <t:${Math.floor(endTime.getTime() / 1000)}:R>`;

    embed.setDescription(description);

    // 创建投票按钮
    const components = [];
    const maxButtonsPerRow = 5;
    let currentRow = new ActionRowBuilder();
    
    options.forEach((option, index) => {
        if (index > 0 && index % maxButtonsPerRow === 0) {
            components.push(currentRow);
            currentRow = new ActionRowBuilder();
        }
        
        const button = new ButtonBuilder()
            .setCustomId(`vote_${voteId}_${index}`)
            .setLabel(`${index + 1}️⃣ ${option}`)
            .setStyle(ButtonStyle.Primary);
            
        currentRow.addComponents(button);
    });
    
    if (currentRow.components.length > 0) {
        components.push(currentRow);
    }

    // 添加查看结果按钮（如果不是实时显示）
    if (!isRealTime) {
        const resultButton = new ButtonBuilder()
            .setCustomId(`vote_result_${voteId}`)
            .setLabel('📈 查看当前结果')
            .setStyle(ButtonStyle.Secondary);
            
        const resultRow = new ActionRowBuilder().addComponents(resultButton);
        components.push(resultRow);
    }

    return { embed, components };
}

function createProgressBar(current, total, length = 10) {
    if (total === 0) return '▱'.repeat(length);
    
    const filled = Math.round((current / total) * length);
    const empty = length - filled;
    
    return '▰'.repeat(filled) + '▱'.repeat(empty);
}

function updateVotePanel(voteData) {
    return createVotePanel(voteData);
}

function createVoteResultEmbed(voteData) {
    const { title, options, votes, isAnonymous, voteId } = voteData;
    
    const embed = new EmbedBuilder()
        .setTitle(`📊 ${title} - 投票结果`)
        .setColor(0x00FF00)
        .setFooter({ 
            text: `投票ID: ${voteId} | ${isAnonymous ? '匿名投票' : '实名投票'}` 
        })
        .setTimestamp();

    const totalVotes = Object.values(votes).reduce((total, voters) => total + voters.length, 0);
    
    let description = '**最终投票结果：**\n\n';
    
    // 按票数排序
    const sortedOptions = options.map(option => ({
        option,
        count: votes[option]?.length || 0,
        voters: votes[option] || []
    })).sort((a, b) => b.count - a.count);
    
    sortedOptions.forEach((item, index) => {
        const percentage = totalVotes > 0 ? ((item.count / totalVotes) * 100).toFixed(1) : 0;
        const progressBar = createProgressBar(item.count, totalVotes, 15);
        
        let emoji = '';
        if (index === 0) emoji = '🥇';
        else if (index === 1) emoji = '🥈';
        else if (index === 2) emoji = '🥉';
        else emoji = `${index + 1}️⃣`;
        
        description += `${emoji} **${item.option}**\n`;
        description += `${progressBar} ${item.count}票 (${percentage}%)\n`;
        
        // 如果不是匿名投票，显示投票者
        if (!isAnonymous && item.voters.length > 0) {
            const voterList = item.voters.map(userId => `<@${userId}>`).join(', ');
            description += `👥 ${voterList}\n`;
        }
        
        description += '\n';
    });
    
    description += `🗳️ 总票数: ${totalVotes}`;
    
    embed.setDescription(description);
    
    return embed;
}

module.exports = {
    createVotePanel,
    updateVotePanel,
    createVoteResultEmbed
}; 