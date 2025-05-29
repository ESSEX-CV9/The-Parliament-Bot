const { 
    ModalBuilder,
    EmbedBuilder,
    ActionRowBuilder, 
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

function createFinishContestConfirmation(contestChannelId, awardedSubmissions) {
    const embed = new EmbedBuilder()
        .setTitle('🏁 确认完赛')
        .setDescription('以下是当前设置的获奖作品清单：')
        .setColor('#FFD700')
        .setTimestamp();

    if (awardedSubmissions.length === 0) {
        embed.setDescription('当前没有设置任何获奖作品。\n\n确认完赛后，将关闭投稿入口，但不会发布获奖清单。');
    } else {
        let awardList = '';
        awardedSubmissions.forEach((submission, index) => {
            const workUrl = `https://discord.com/channels/${submission.parsedInfo.guildId}/${submission.parsedInfo.channelId}/${submission.parsedInfo.messageId}`;
            const authorMention = `<@${submission.submitterId}>`;
            
            awardList += `${index + 1}. **${submission.awardInfo.awardName}**\n`;
            awardList += `   ${workUrl}\n`;
            awardList += `   ${authorMention}\n`;
            if (submission.awardInfo.awardMessage) {
                awardList += `   ${submission.awardInfo.awardMessage}\n`;
            }
            awardList += '\n';
        });
        
        embed.setDescription(`以下是当前设置的获奖作品清单：\n\n${awardList}`);
    }

    const components = [
        new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`finish_contest_close_${contestChannelId}`)
                    .setLabel('❌ 关闭清单')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`finish_contest_confirm_${contestChannelId}`)
                    .setLabel('✅ 确认完赛')
                    .setStyle(ButtonStyle.Danger)
            )
    ];

    return { embed, components };
}

module.exports = {
    createFinishContestConfirmation
}; 