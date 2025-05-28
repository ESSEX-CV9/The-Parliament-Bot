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
            // 对于公开展示，只显示最近的5个作品
            const recentSubmissions = submissions
                .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt)) // 按时间倒序，最新的在前
                .slice(0, 5); // 只取最近的5个
            
            // 构建展示内容
            const embed = await this.buildRecentDisplayEmbed(recentSubmissions, submissions.length);
            const components = this.buildRecentDisplayComponents(contestChannelId);
            
            await displayMessage.edit({
                embeds: [embed],
                components: components
            });
            
        } catch (error) {
            console.error('更新展示消息时出错:', error);
            throw error;
        }
    }
    
    async buildRecentDisplayEmbed(recentSubmissions, totalSubmissions) {
        const embed = new EmbedBuilder()
            .setTitle('🎨 最近投稿作品展示')
            .setColor('#87CEEB')
            .setFooter({ 
                text: `显示最近 ${recentSubmissions.length} 个作品 | 共 ${totalSubmissions} 个作品` 
            })
            .setTimestamp();
        
        if (recentSubmissions.length === 0) {
            embed.setDescription('暂无投稿作品\n\n快来成为第一个投稿的参赛者吧！');
            return embed;
        }
        
        let description = '';
        
        for (let i = 0; i < recentSubmissions.length; i++) {
            const submission = recentSubmissions[i];
            const preview = submission.cachedPreview;
            const submissionNumber = i + 1;
            
            // 构建作品链接
            const workUrl = `https://discord.com/channels/${submission.parsedInfo.guildId}/${submission.parsedInfo.channelId}/${submission.parsedInfo.messageId}`;
            
            // 获取发布时间（使用帖子的原始发布时间）
            const publishTime = Math.floor(preview.timestamp / 1000);
            
            // 获取作者信息
            const authorMention = `<@${submission.submitterId}>`;
            
            // 使用稿件说明，如果没有则显示默认文本
            let content = submission.submissionDescription || '作者未提供稿件说明';
            // 确保内容不超过300字，超出部分用.....省略
            if (content.length > 300) {
                content = content.substring(0, 300) + '.....';
            }
            
            // 检查是否为外部服务器投稿
            if (submission.isExternal) {
                // 外部服务器投稿的特殊格式
                description += `${submissionNumber}. ${workUrl}\n`;
                description += `👤投稿者: ${authorMention}\n`;
                description += `📅投稿时间：<t:${publishTime}:f>\n`;
                description += `📝作品介绍: ${content}\n`;
                description += `🆔投稿ID：\`${submission.contestSubmissionId}\`\n`;
                description += `⚠️ : 此稿件为非本服务器投稿，BOT无法验证，如果有需要请联系赛事主办进行退稿处理\n`;
            } else {
                // 本服务器投稿的正常格式
                description += `${submissionNumber}.  ${workUrl}\n`;
                description += `👤作者：${authorMention}\n`;
                description += `📅发布时间：<t:${publishTime}:f>\n`;
                description += `📝作品介绍: ${content}\n`;
                description += `🆔投稿ID：\`${submission.contestSubmissionId}\`\n`;
            }
            
            if (i < recentSubmissions.length - 1) {
                description += '\n';
            }
        }
         
        embed.setDescription(description);
        
        return embed;
    }
    
    buildRecentDisplayComponents(contestChannelId) {
        return [
            new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`contest_refresh_${contestChannelId}`)
                        .setLabel('🔄 刷新展示')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId(`contest_view_all_${contestChannelId}`)
                        .setLabel('📋 查看所有投稿作品')
                        .setStyle(ButtonStyle.Primary)
                )
        ];
    }

    // 新增：构建完整作品列表的嵌入消息
    async buildFullDisplayEmbed(submissions, currentPage, totalPages, totalSubmissions) {
        const embed = new EmbedBuilder()
            .setTitle('🎨 所有参赛作品')
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
            
            // 构建作品链接
            const workUrl = `https://discord.com/channels/${submission.parsedInfo.guildId}/${submission.parsedInfo.channelId}/${submission.parsedInfo.messageId}`;
            
            // 获取发布时间（使用帖子的原始发布时间）
            const publishTime = Math.floor(preview.timestamp / 1000);
            
            // 获取作者信息
            const authorMention = `<@${submission.submitterId}>`;
            
            // 使用稿件说明，如果没有则显示默认文本
            let content = submission.submissionDescription || '作者未提供稿件说明';
            // 确保内容不超过300字，超出部分用.....省略
            if (content.length > 300) {
                content = content.substring(0, 300) + '.....';
            }
            
            // 检查是否为外部服务器投稿
            if (submission.isExternal) {
                // 外部服务器投稿的特殊格式
                description += `${submissionNumber}. ${workUrl}\n`;
                description += `👤投稿者: ${authorMention}\n`;
                description += `📅投稿时间：<t:${publishTime}:f>\n`;
                description += `📝作品介绍: ${content}\n`;
                description += `🆔投稿ID：\`${submission.contestSubmissionId}\`\n`;
                description += `⚠️ : 此稿件为非本服务器投稿，BOT无法验证，如果有需要请联系赛事主办进行退稿处理\n`;
            } else {
                // 本服务器投稿的正常格式
                description += `${submissionNumber}.  ${workUrl}\n`;
                description += `👤作者：${authorMention}\n`;
                description += `📅发布时间：<t:${publishTime}:f>\n`;
                description += `📝作品介绍: ${content}\n`;
                description += `🆔投稿ID：\`${submission.contestSubmissionId}\`\n`;
            }
            
            if (i < submissions.length - 1) {
                description += '\n';
            }
        }
         
        embed.setDescription(description);
        
        return embed;
    }
    
    // 新增：构建完整作品列表的组件
    buildFullDisplayComponents(currentPage, totalPages, contestChannelId) {
        if (totalPages <= 1) {
            // 只有一页，显示刷新按钮
            return [
                new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`contest_full_refresh_${contestChannelId}`)
                            .setLabel('🔄 刷新')
                            .setStyle(ButtonStyle.Secondary)
                    )
            ];
        }
        
        const components = [];
        const navigationRow = new ActionRowBuilder();
        
        // 上一页按钮
        navigationRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`contest_full_prev_${contestChannelId}`)
                .setLabel('◀️ 上一页')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(currentPage <= 1)
        );
        
        // 页码显示按钮
        navigationRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`contest_full_page_${contestChannelId}`)
                .setLabel(`${currentPage} / ${totalPages}`)
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true)
        );
        
        // 下一页按钮
        navigationRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`contest_full_next_${contestChannelId}`)
                .setLabel('下一页 ▶️')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(currentPage >= totalPages)
        );
        
        // 刷新按钮
        navigationRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`contest_full_refresh_${contestChannelId}`)
                .setLabel('🔄 刷新')
                .setStyle(ButtonStyle.Secondary)
        );
        
        components.push(navigationRow);
        
        return components;
    }

    // 新增：处理查看所有作品按钮
    async handleViewAllSubmissions(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });
            
            const customId = interaction.customId;
            const contestChannelId = customId.split('_').slice(-1)[0];
            
            const contestChannelData = await getContestChannel(contestChannelId);
            if (!contestChannelData) {
                return interaction.editReply({
                    content: '❌ 找不到比赛数据。'
                });
            }
            
            // 获取所有有效投稿
            const submissions = await getSubmissionsByChannel(contestChannelId);
            const validSubmissions = submissions.filter(sub => sub.isValid)
                .sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt)); // 按时间正序，先投稿的在前
            
            if (validSubmissions.length === 0) {
                return interaction.editReply({
                    content: '📝 当前没有任何投稿作品。'
                });
            }
            
            const itemsPerPage = 6;
            const totalPages = Math.max(1, Math.ceil(validSubmissions.length / itemsPerPage));
            const currentPage = 1;
            
            // 计算当前页的投稿范围
            const startIndex = (currentPage - 1) * itemsPerPage;
            const endIndex = Math.min(startIndex + itemsPerPage, validSubmissions.length);
            const pageSubmissions = validSubmissions.slice(startIndex, endIndex);
            
            // 构建展示内容
            const embed = await this.buildFullDisplayEmbed(pageSubmissions, currentPage, totalPages, validSubmissions.length);
            const components = this.buildFullDisplayComponents(currentPage, totalPages, contestChannelId);
            
            await interaction.editReply({
                embeds: [embed],
                components: components
            });
            
            console.log(`用户查看所有作品 - 频道: ${contestChannelId}, 用户: ${interaction.user.tag}`);
            
        } catch (error) {
            console.error('处理查看所有作品时出错:', error);
            try {
                await interaction.editReply({
                    content: '❌ 获取作品列表时出现错误。'
                });
            } catch (replyError) {
                console.error('回复错误信息失败:', replyError);
            }
        }
    }

    // 新增：处理完整作品列表的页面导航
    async handleFullPageNavigation(interaction) {
        try {
            await interaction.deferUpdate();
            
            const customId = interaction.customId;
            const contestChannelId = customId.split('_').slice(-1)[0];
            
            const contestChannelData = await getContestChannel(contestChannelId);
            if (!contestChannelData) {
                return;
            }
            
            // 获取所有有效投稿
            const submissions = await getSubmissionsByChannel(contestChannelId);
            const validSubmissions = submissions.filter(sub => sub.isValid)
                .sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt));
            
            const itemsPerPage = 6;
            const totalPages = Math.max(1, Math.ceil(validSubmissions.length / itemsPerPage));
            
            // 从交互消息中获取当前页码
            const currentPageMatch = interaction.message.embeds[0].footer.text.match(/第 (\d+) 页/);
            let currentPage = currentPageMatch ? parseInt(currentPageMatch[1]) : 1;
            
            if (customId.includes('_full_prev_')) {
                currentPage = Math.max(1, currentPage - 1);
            } else if (customId.includes('_full_next_')) {
                currentPage = Math.min(totalPages, currentPage + 1);
            } else if (customId.includes('_full_refresh_')) {
                // 刷新当前页，不改变页码
            }
            
            // 计算当前页的投稿范围
            const startIndex = (currentPage - 1) * itemsPerPage;
            const endIndex = Math.min(startIndex + itemsPerPage, validSubmissions.length);
            const pageSubmissions = validSubmissions.slice(startIndex, endIndex);
            
            // 构建展示内容
            const embed = await this.buildFullDisplayEmbed(pageSubmissions, currentPage, totalPages, validSubmissions.length);
            const components = this.buildFullDisplayComponents(currentPage, totalPages, contestChannelId);
            
            await interaction.editReply({
                embeds: [embed],
                components: components
            });
            
            console.log(`完整作品列表页面导航完成 - 频道: ${contestChannelId}, 页码: ${currentPage}`);
            
        } catch (error) {
            console.error('处理完整作品列表页面导航时出错:', error);
        }
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
            
            // 重新获取和显示数据（最近5个作品）
            const submissions = await getSubmissionsByChannel(contestChannelId);
            const validSubmissions = submissions.filter(sub => sub.isValid);
            
            await this.updateDisplayMessage(
                interaction.message,
                validSubmissions,
                1, // 不再需要页码，因为只显示最近5个
                5, // 固定显示5个
                contestChannelId
            );
            
            console.log(`最近作品展示刷新完成 - 频道: ${contestChannelId}`);
            
        } catch (error) {
            console.error('处理页面导航时出错:', error);
        }
    }
}

const displayService = new DisplayService();

module.exports = { displayService };