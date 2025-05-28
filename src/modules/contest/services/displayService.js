// src/modules/contest/services/displayService.js
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { 
    getContestChannel,
    updateContestChannel,
    getSubmissionsByChannel 
} = require('../utils/contestDatabase');

class DisplayService {
    async updateDisplayMessage(displayMessage, submissions, currentPage, itemsPerPage, contestChannelId) {
        try {
            const totalSubmissions = submissions.length;
            const totalPages = Math.max(1, Math.ceil(totalSubmissions / itemsPerPage));
            
            // 确保当前页数在有效范围内
            currentPage = Math.max(1, Math.min(currentPage, totalPages));
            
            // 计算当前页的投稿范围
            const startIndex = (currentPage - 1) * itemsPerPage;
            const endIndex = Math.min(startIndex + itemsPerPage, totalSubmissions);
            const pageSubmissions = submissions.slice(startIndex, endIndex);
            
            // 构建展示内容
            const embed = await this.buildDisplayEmbed(pageSubmissions, currentPage, totalPages, totalSubmissions);
            const components = this.buildDisplayComponents(currentPage, totalPages, contestChannelId);
            
            await displayMessage.edit({
                embeds: [embed],
                components: components
            });
            
        } catch (error) {
            console.error('更新展示消息时出错:', error);
            throw error;
        }
    }
    
    async buildDisplayEmbed(submissions, currentPage, totalPages, totalSubmissions) {
        const embed = new EmbedBuilder()
            .setTitle('🎨 参赛作品展示')
            .setColor('#87CEEB')
            .setFooter({ 
                text: `第 ${currentPage} 页 / 共 ${totalPages} 页 | 共 ${totalSubmissions} 个作品` 
            })
            .setTimestamp();
        
        if (submissions.length === 0) {
            embed.setDescription('暂无投稿作品\n\n快来成为第一个投稿的参赛者吧！');
            return embed;
        }
        
        let description = '';
        
        for (let i = 0; i < submissions.length; i++) {
            const submission = submissions[i];
            const preview = submission.cachedPreview;
            const submissionNumber = ((currentPage - 1) * submissions.length) + i + 1;
            
            // 构建单个作品的展示
            const submittedTime = Math.floor(new Date(submission.submittedAt).getTime() / 1000);
            const workUrl = `https://discord.com/channels/${submission.parsedInfo.guildId}/${submission.parsedInfo.channelId}/${submission.parsedInfo.messageId}`;
            
            description += `**${submissionNumber}. ${preview.title}**\n`;
            description += `👤 作者：<@${submission.submitterId}>\n`;
            description += `📅 投稿时间：<t:${submittedTime}:R>\n`;
            description += `📝 ${preview.content.substring(0, 200)}${preview.content.length > 200 ? '...' : ''}\n`;
            description += `🔗 [查看完整作品](${workUrl})\n`;
            
            if (i < submissions.length - 1) {
                description += '\n---\n\n';
            }
        }
        
        embed.setDescription(description);
        
        // 如果有图片，设置缩略图为第一个作品的图片
        if (submissions.length > 0 && submissions[0].cachedPreview.imageUrl) {
            embed.setThumbnail(submissions[0].cachedPreview.imageUrl);
        }
        
        return embed;
    }
    
    buildDisplayComponents(currentPage, totalPages, contestChannelId) {
        if (totalPages <= 1) {
            // 只有一页，显示刷新按钮
            return [
                new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`contest_refresh_${contestChannelId}`)
                            .setLabel('🔄 刷新展示')
                            .setStyle(ButtonStyle.Secondary)
                    )
            ];
        }
        
        const components = [];
        const navigationRow = new ActionRowBuilder();
        
        // 上一页按钮
        navigationRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`contest_prev_${contestChannelId}`)
                .setLabel('◀️ 上一页')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(currentPage <= 1)
        );
        
        // 页码显示按钮
        navigationRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`contest_page_${contestChannelId}`)
                .setLabel(`${currentPage} / ${totalPages}`)
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true)
        );
        
        // 下一页按钮
        navigationRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`contest_next_${contestChannelId}`)
                .setLabel('下一页 ▶️')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(currentPage >= totalPages)
        );
        
        // 刷新按钮
        navigationRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`contest_refresh_${contestChannelId}`)
                .setLabel('🔄 刷新')
                .setStyle(ButtonStyle.Secondary)
        );
        
        components.push(navigationRow);
        
        return components;
    }
    
    async handlePageNavigation(interaction) {
        try {
            await interaction.deferUpdate();
            
            const customId = interaction.customId;
            const contestChannelId = customId.split('_').slice(-1)[0];
            
            const contestChannelData = await getContestChannel(contestChannelId);
            if (!contestChannelData) {
                return;
            }
            
            let newPage = contestChannelData.currentPage || 1;
            
            if (customId.includes('_prev_')) {
                newPage = Math.max(1, newPage - 1);
            } else if (customId.includes('_next_')) {
                const submissions = await getSubmissionsByChannel(contestChannelId);
                const validSubmissions = submissions.filter(sub => sub.isValid);
                const totalPages = Math.max(1, Math.ceil(validSubmissions.length / (contestChannelData.itemsPerPage || 6)));
                newPage = Math.min(totalPages, newPage + 1);
            } else if (customId.includes('_refresh_')) {
                // 刷新当前页，不改变页码
            }
            
            // 更新页码
            if (newPage !== contestChannelData.currentPage) {
                await updateContestChannel(contestChannelId, {
                    currentPage: newPage
                });
            }
            
            // 重新获取和显示数据
            const submissions = await getSubmissionsByChannel(contestChannelId);
            const validSubmissions = submissions.filter(sub => sub.isValid)
                .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
            
            await this.updateDisplayMessage(
                interaction.message,
                validSubmissions,
                newPage,
                contestChannelData.itemsPerPage || 6,
                contestChannelId
            );
            
            console.log(`页面导航完成 - 频道: ${contestChannelId}, 页码: ${newPage}`);
            
        } catch (error) {
            console.error('处理页面导航时出错:', error);
        }
    }
}

const displayService = new DisplayService();

module.exports = { displayService };