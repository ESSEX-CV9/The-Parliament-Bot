// src/modules/contest/services/displayService.js
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { 
    getContestChannel,
    updateContestChannel,
    getSubmissionsByChannel 
} = require('../utils/contestDatabase');
const { contestCacheManager } = require('../utils/cacheManager');
const { preprocessSubmissions, paginateData, generateSubmissionNumber } = require('../utils/dataProcessor');
const { safeDbOperation } = require('../utils/retryHelper');

class DisplayService {
    constructor() {
        // 按钮ID映射，使用更短的格式
        this.buttonIds = {
            refresh: 'c_ref',
            viewAll: 'c_all',
            itemsPerPage5: 'c_ipp5',
            itemsPerPage10: 'c_ipp10',
            itemsPerPage20: 'c_ipp20',
            fullRefresh: 'c_fref',
            fullFirst: 'c_ff',
            fullPrev: 'c_fp',
            fullNext: 'c_fn',
            fullLast: 'c_fl',
            fullPageJump: 'c_fpj'
        };
        
        // 添加用户选择状态存储
        this.userSelections = new Map();
    }

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
                
                // 新增：获奖信息显示
                if (submission.awardInfo && submission.awardInfo.awardName) {
                    description += `🏆 **获奖信息：** ${submission.awardInfo.awardName}\n`;
                    if (submission.awardInfo.awardMessage) {
                        description += `💬 ${submission.awardInfo.awardMessage}\n`;
                    }
                }
                
                description += `⚠️ : 此稿件为非本服务器投稿，BOT无法验证，如果有需要请联系赛事主办进行退稿处理\n`;
            } else {
                // 本服务器投稿的正常格式
                description += `${submissionNumber}.  ${workUrl}\n`;
                description += `👤作者：${authorMention}\n`;
                description += `📅发布时间：<t:${publishTime}:f>\n`;
                description += `📝作品介绍: ${content}\n`;
                description += `🆔投稿ID：\`${submission.contestSubmissionId}\`\n`;
                
                // 新增：获奖信息显示
                if (submission.awardInfo && submission.awardInfo.awardName) {
                    description += `🏆 **获奖信息：** ${submission.awardInfo.awardName}\n`;
                    if (submission.awardInfo.awardMessage) {
                        description += `💬 ${submission.awardInfo.awardMessage}\n`;
                    }
                }
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
                        .setCustomId(`${this.buttonIds.refresh}_${contestChannelId}`)
                            .setLabel('🔄 刷新展示')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId(`${this.buttonIds.viewAll}_${contestChannelId}`)
                        .setLabel('📋 查看所有投稿作品')
                        .setStyle(ButtonStyle.Primary)
                )
        ];
    }

    // 构建完整作品列表的嵌入消息
    async buildFullDisplayEmbed(processedSubmissions, paginationInfo, itemsPerPage) {
        const { pageData, currentPage, totalPages, totalItems } = paginationInfo;
        
        const embed = new EmbedBuilder()
            .setTitle('🎨 所有参赛作品')
            .setColor('#87CEEB')
            .setFooter({ 
                text: `第 ${currentPage} 页 / 共 ${totalPages} 页 | 共 ${totalItems} 个作品 | 每页 ${itemsPerPage} 个` 
            })
            .setTimestamp();
        
        if (pageData.length === 0) {
            embed.setDescription('暂无投稿作品\n\n快来成为第一个投稿的参赛者吧！');
            return embed;
        }
        
        let description = '';
        
        for (let i = 0; i < pageData.length; i++) {
            const submission = pageData[i];
            const submissionNumber = generateSubmissionNumber(i, currentPage, itemsPerPage);
            
            // 使用预处理的数据
            const { workUrl, publishTime, authorMention, truncatedDescription } = submission;
            
            // 检查是否为外部服务器投稿
            if (submission.isExternal) {
                // 外部服务器投稿的特殊格式
                description += `${submissionNumber}. ${workUrl}\n`;
                description += `👤投稿者: ${authorMention}\n`;
                description += `📅投稿时间：<t:${publishTime}:f>\n`;
                description += `📝作品介绍: ${truncatedDescription}\n`;
                description += `🆔投稿ID：\`${submission.contestSubmissionId}\`\n`;
                
                // 新增：获奖信息显示
                if (submission.awardInfo && submission.awardInfo.awardName) {
                    description += `🏆 **获奖信息：** ${submission.awardInfo.awardName}\n`;
                    if (submission.awardInfo.awardMessage) {
                        description += `💬 ${submission.awardInfo.awardMessage}\n`;
                    }
                }
                
                description += `⚠️ : 此稿件为非本服务器投稿，BOT无法验证，如果有需要请联系赛事主办进行退稿处理\n`;
            } else {
                // 本服务器投稿的正常格式
                description += `${submissionNumber}.  ${workUrl}\n`;
                description += `👤作者：${authorMention}\n`;
                description += `📅发布时间：<t:${publishTime}:f>\n`;
                description += `📝作品介绍: ${truncatedDescription}\n`;
                description += `🆔投稿ID：\`${submission.contestSubmissionId}\`\n`;
                
                // 新增：获奖信息显示
                if (submission.awardInfo && submission.awardInfo.awardName) {
                    description += `🏆 **获奖信息：** ${submission.awardInfo.awardName}\n`;
                    if (submission.awardInfo.awardMessage) {
                        description += `💬 ${submission.awardInfo.awardMessage}\n`;
                    }
                }
            }
            
            if (i < pageData.length - 1) {
                description += '\n';
            }
        }
         
        embed.setDescription(description);
        
        return embed;
    }
    
    // 构建完整作品列表的组件，根据用户权限显示不同界面
    buildFullDisplayComponents(currentPage, totalPages, contestChannelId, itemsPerPage = 5, isOrganizer = false, currentPageSubmissions = []) {
        const components = [];
        
        // 第一行：每页显示数量设置按钮
        const itemsPerPageRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`${this.buttonIds.itemsPerPage5}_${contestChannelId}`)
                    .setLabel('5/页')
                    .setStyle(itemsPerPage === 5 ? ButtonStyle.Success : ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`${this.buttonIds.itemsPerPage10}_${contestChannelId}`)
                    .setLabel('10/页')
                    .setStyle(itemsPerPage === 10 ? ButtonStyle.Success : ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`${this.buttonIds.itemsPerPage20}_${contestChannelId}`)
                    .setLabel('20/页')
                    .setStyle(itemsPerPage === 20 ? ButtonStyle.Success : ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`${this.buttonIds.fullRefresh}_${contestChannelId}`)
                    .setLabel('🔄 刷新')
                    .setStyle(ButtonStyle.Secondary)
            );
        
        components.push(itemsPerPageRow);
        
        if (totalPages > 1) {
            // 第二行：页面导航按钮（只有多页时显示）
            const navigationRow = new ActionRowBuilder();
            
            navigationRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`${this.buttonIds.fullFirst}_${contestChannelId}`)
                    .setLabel('⏮️ 首页')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(currentPage <= 1),
                new ButtonBuilder()
                    .setCustomId(`${this.buttonIds.fullPrev}_${contestChannelId}`)
                    .setLabel('◀️ 上一页')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(currentPage <= 1),
                new ButtonBuilder()
                    .setCustomId(`${this.buttonIds.fullPageJump}_${contestChannelId}`)
                    .setLabel(`${currentPage} / ${totalPages}`)
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`${this.buttonIds.fullNext}_${contestChannelId}`)
                    .setLabel('下一页 ▶️')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(currentPage >= totalPages),
                new ButtonBuilder()
                    .setCustomId(`${this.buttonIds.fullLast}_${contestChannelId}`)
                    .setLabel('尾页 ⏭️')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(currentPage >= totalPages)
            );
            
            components.push(navigationRow);
        }
        
        // 主办人额外功能
        if (isOrganizer && currentPageSubmissions.length > 0) {
            // 第三行：投稿选择下拉菜单
            const submissionSelectMenu = new StringSelectMenuBuilder()
                .setCustomId(`manage_select_submission_${contestChannelId}`)
                .setPlaceholder('选择要操作的投稿作品...')
                .setMinValues(1)
                .setMaxValues(1);
            
            // 添加当前页面的投稿选项
            currentPageSubmissions.forEach((submission, index) => {
                const submissionNumber = ((currentPage - 1) * itemsPerPage) + index + 1;
                
                // 修复：使用正确的字段名
                const authorName = submission.cachedPreview.authorName || '未知作者';
                
                // 使用投稿链接而不是作者名
                const workUrl = submission.workUrl || `https://discord.com/channels/${submission.parsedInfo.guildId}/${submission.parsedInfo.channelId}/${submission.parsedInfo.messageId}`;
                
                // 创建选项标签：显示编号、作者和投稿ID
                const optionLabel = `${submissionNumber}. ${authorName} - ID:${submission.contestSubmissionId}`;
                
                // 创建选项描述：显示投稿链接
                const linkText = workUrl.length > 80 ? workUrl.substring(0, 77) + '...' : workUrl;
                
                submissionSelectMenu.addOptions({
                    label: optionLabel.length > 100 ? optionLabel.substring(0, 97) + '...' : optionLabel,
                    description: linkText,
                    value: submission.globalId.toString()
                });
            });
            
            const selectMenuRow = new ActionRowBuilder().addComponents(submissionSelectMenu);
            components.push(selectMenuRow);
            
            // 第四行：管理操作按钮
            const managementRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`manage_quick_delete_${contestChannelId}`)
                        .setLabel('🗑️ 直接拒稿')
                        .setStyle(ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId(`manage_delete_with_reason_${contestChannelId}`)
                        .setLabel('📝 拒稿并说明理由')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId(`manage_delete_page_${contestChannelId}`)
                        .setLabel('🗂️ 拒稿整页稿件')
                        .setStyle(ButtonStyle.Danger)
                );
            
            components.push(managementRow);
            
            // 第五行：新增的获奖管理按钮
            const awardManagementRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`award_set_${contestChannelId}`)
                        .setLabel('🏆 设置获奖作品')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`award_remove_${contestChannelId}`)
                        .setLabel('❌ 移除获奖作品')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId(`contest_finish_${contestChannelId}`)
                        .setLabel('🏁 完赛')
                        .setStyle(ButtonStyle.Primary)
                );
            
            components.push(awardManagementRow);
        }
        
        return components;
    }
    
    // 从交互消息中提取当前的每页显示数量
    extractItemsPerPageFromMessage(interaction) {
        try {
            const footerText = interaction.message.embeds[0].footer.text;
            const itemsMatch = footerText.match(/每页 (\d+) 个/);
            return itemsMatch ? parseInt(itemsMatch[1]) : 5; // 默认5个
        } catch (error) {
            console.error('提取每页显示数量时出错:', error);
            return 5; // 默认5个
        }
    }

    // 获取投稿数据（带缓存和重试）
    async getSubmissionsData(contestChannelId) {
        return safeDbOperation(
            () => contestCacheManager.getSubmissionsWithCache(contestChannelId, getSubmissionsByChannel),
            '获取投稿数据'
        );
    }

    // 获取赛事频道数据（带缓存和重试）
    async getContestChannelData(contestChannelId) {
        return safeDbOperation(
            () => contestCacheManager.getContestChannelWithCache(contestChannelId, getContestChannel),
            '获取赛事频道数据'
        );
    }

    // 处理每页显示数量变更
    async handleItemsPerPageChange(interaction) {
        try {
            await interaction.deferUpdate();
            
            const customId = interaction.customId;
            const contestChannelId = customId.split('_').slice(-1)[0];
            
            // 从按钮ID中提取每页显示数量
            let newItemsPerPage = 5;
            if (customId.includes(this.buttonIds.itemsPerPage10)) {
                newItemsPerPage = 10;
            } else if (customId.includes(this.buttonIds.itemsPerPage20)) {
                newItemsPerPage = 20;
            }
            
            const contestChannelData = await this.getContestChannelData(contestChannelId);
            if (!contestChannelData) {
                return;
            }
            
            // 添加权限检查
            const isOrganizer = contestChannelData.applicantId === interaction.user.id;
            
            // 获取所有有效投稿
            const submissions = await this.getSubmissionsData(contestChannelId);
            const processedSubmissions = preprocessSubmissions(submissions);
            
            const paginationInfo = paginateData(processedSubmissions, 1, newItemsPerPage);
            
            // 构建展示内容
            const embed = await this.buildFullDisplayEmbed(processedSubmissions, paginationInfo, newItemsPerPage);
            const components = this.buildFullDisplayComponents(
                paginationInfo.currentPage, 
                paginationInfo.totalPages, 
                contestChannelId, 
                newItemsPerPage,
                isOrganizer,          // 添加权限参数
                paginationInfo.pageData  // 添加当前页面数据
            );
            
            await interaction.editReply({
                embeds: [embed],
                components: components
            });
            
            console.log(`每页显示数量已更改 - 频道: ${contestChannelId}, 新数量: ${newItemsPerPage}, 用户: ${interaction.user.tag}`);
            
        } catch (error) {
            console.error('处理每页显示数量变更时出错:', error);
            try {
                await interaction.followUp({
                    content: '❌ 更改每页显示数量时出现错误，请稍后重试。',
                    ephemeral: true
                });
            } catch (replyError) {
                console.error('回复错误信息失败:', replyError);
            }
        }
    }

    // 处理页面跳转按钮
    async handlePageJumpButton(interaction) {
        try {
            const customId = interaction.customId;
            const contestChannelId = customId.split('_').slice(-1)[0];
            
            // 从交互消息中获取当前页码和总页数
            const footerText = interaction.message.embeds[0].footer.text;
            const pageMatch = footerText.match(/第 (\d+) 页 \/ 共 (\d+) 页/);
            
            if (!pageMatch) {
                return interaction.reply({
                    content: '❌ 无法获取页面信息。',
                    ephemeral: true
                });
            }
            
            const currentPage = parseInt(pageMatch[1]);
            const totalPages = parseInt(pageMatch[2]);
            
            const { createPageJumpModal } = require('../components/pageJumpModal');
            const modal = createPageJumpModal(contestChannelId, currentPage, totalPages);
            
            await interaction.showModal(modal);
            
        } catch (error) {
            console.error('处理页面跳转按钮时出错:', error);
            try {
                await interaction.reply({
                    content: '❌ 处理页面跳转时出现错误。',
                    ephemeral: true
                });
            } catch (replyError) {
                console.error('回复错误信息失败:', replyError);
            }
        }
    }

    // 处理页面跳转模态框提交
    async handlePageJumpSubmission(interaction) {
        try {
            await interaction.deferUpdate();
            
            const customId = interaction.customId;
            const contestChannelId = customId.replace('contest_page_jump_', '');
            
            const targetPageInput = interaction.fields.getTextInputValue('target_page').trim();
            const targetPage = parseInt(targetPageInput);
            
            // 验证输入
            if (isNaN(targetPage) || targetPage < 1) {
                return interaction.followUp({
                    content: '❌ 请输入有效的页码（大于0的数字）。',
                    ephemeral: true
                });
            }
            
            const contestChannelData = await this.getContestChannelData(contestChannelId);
            if (!contestChannelData) {
                return interaction.followUp({
                    content: '❌ 找不到比赛数据。',
                    ephemeral: true
                });
            }
            
            // 添加权限检查
            const isOrganizer = contestChannelData.applicantId === interaction.user.id;
            
            // 获取当前的每页显示数量
            const itemsPerPage = this.extractItemsPerPageFromMessage(interaction);
            
            // 获取所有有效投稿
            const submissions = await this.getSubmissionsData(contestChannelId);
            const processedSubmissions = preprocessSubmissions(submissions);
            
            const paginationInfo = paginateData(processedSubmissions, targetPage, itemsPerPage);
            
            // 验证页码范围
            if (targetPage > paginationInfo.totalPages) {
                return interaction.followUp({
                    content: `❌ 页码超出范围。总共只有 ${paginationInfo.totalPages} 页。`,
                    ephemeral: true
                });
            }
            
            // 构建展示内容
            const embed = await this.buildFullDisplayEmbed(processedSubmissions, paginationInfo, itemsPerPage);
            const components = this.buildFullDisplayComponents(
                paginationInfo.currentPage, 
                paginationInfo.totalPages, 
                contestChannelId, 
                itemsPerPage,
                isOrganizer,          // 添加权限参数
                paginationInfo.pageData  // 添加当前页面数据
            );
            
            await interaction.editReply({
                embeds: [embed],
                components: components
            });
            
            console.log(`页面跳转完成 - 频道: ${contestChannelId}, 跳转到页码: ${targetPage}, 用户: ${interaction.user.tag}`);
            
        } catch (error) {
            console.error('处理页面跳转提交时出错:', error);
            try {
                await interaction.followUp({
                    content: '❌ 页面跳转时出现错误，请稍后重试。',
                    ephemeral: true
                });
            } catch (replyError) {
                console.error('回复错误信息失败:', replyError);
            }
        }
    }

    // 处理查看所有作品按钮
    async handleViewAllSubmissions(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });
            
            const customId = interaction.customId;
            const contestChannelId = customId.split('_').slice(-1)[0];
            
            const contestChannelData = await this.getContestChannelData(contestChannelId);
            if (!contestChannelData) {
                return interaction.editReply({
                    content: '❌ 找不到比赛数据。'
                });
            }
            
            // 检查用户权限
            const isOrganizer = contestChannelData.applicantId === interaction.user.id;
            
            // 获取所有有效投稿
            const submissions = await this.getSubmissionsData(contestChannelId);
            const processedSubmissions = preprocessSubmissions(submissions);
            
            if (processedSubmissions.length === 0) {
                return interaction.editReply({
                    content: '📝 当前没有任何投稿作品。'
                });
            }
            
            const itemsPerPage = 5; // 默认每页5个
            const paginationInfo = paginateData(processedSubmissions, 1, itemsPerPage);
            
            // 构建展示内容
            const embed = await this.buildFullDisplayEmbed(processedSubmissions, paginationInfo, itemsPerPage);
            
            // 根据权限构建不同的组件
            const components = this.buildFullDisplayComponents(
                paginationInfo.currentPage, 
                paginationInfo.totalPages, 
                contestChannelId, 
                itemsPerPage,
                isOrganizer,
                paginationInfo.pageData  // 传递当前页面的投稿数据
            );
            
            await interaction.editReply({
                embeds: [embed],
                components: components
            });
            
            console.log(`用户查看所有作品 - 频道: ${contestChannelId}, 用户: ${interaction.user.tag}, 权限: ${isOrganizer ? '主办人' : '普通用户'}`);
            
        } catch (error) {
            console.error('处理查看所有作品时出错:', error);
            try {
                await interaction.editReply({
                    content: '❌ 获取作品列表时出现错误，请稍后重试。如果问题持续存在，请联系管理员。'
                });
            } catch (replyError) {
                console.error('回复错误信息失败:', replyError);
            }
        }
    }

    // 处理完整作品列表的页面导航
    async handleFullPageNavigation(interaction) {
        try {
            await interaction.deferUpdate();
            
            const customId = interaction.customId;
            const contestChannelId = customId.split('_').slice(-1)[0];
            
            const contestChannelData = await this.getContestChannelData(contestChannelId);
            if (!contestChannelData) {
                return;
            }
            
            // 添加权限检查
            const isOrganizer = contestChannelData.applicantId === interaction.user.id;
            
            // 获取当前的每页显示数量
            const itemsPerPage = this.extractItemsPerPageFromMessage(interaction);
            
            // 获取所有有效投稿
            const submissions = await this.getSubmissionsData(contestChannelId);
            const processedSubmissions = preprocessSubmissions(submissions);
            
            // 从交互消息中获取当前页码
            const currentPageMatch = interaction.message.embeds[0].footer.text.match(/第 (\d+) 页/);
            let currentPage = currentPageMatch ? parseInt(currentPageMatch[1]) : 1;
            
            const totalPages = Math.max(1, Math.ceil(processedSubmissions.length / itemsPerPage));
            
            // 根据按钮类型调整页码
            if (customId.includes(this.buttonIds.fullFirst)) {
                currentPage = 1;
            } else if (customId.includes(this.buttonIds.fullPrev)) {
                currentPage = Math.max(1, currentPage - 1);
            } else if (customId.includes(this.buttonIds.fullNext)) {
                currentPage = Math.min(totalPages, currentPage + 1);
            } else if (customId.includes(this.buttonIds.fullLast)) {
                currentPage = totalPages;
            } else if (customId.includes(this.buttonIds.fullRefresh)) {
                // 刷新当前页，不改变页码，但清除缓存
                contestCacheManager.clearSubmissionCache(contestChannelId);
                contestCacheManager.clearContestChannelCache(contestChannelId);
            }
            
            const paginationInfo = paginateData(processedSubmissions, currentPage, itemsPerPage);
            
            // 构建展示内容
            const embed = await this.buildFullDisplayEmbed(processedSubmissions, paginationInfo, itemsPerPage);
            const components = this.buildFullDisplayComponents(
                paginationInfo.currentPage, 
                paginationInfo.totalPages, 
                contestChannelId, 
                itemsPerPage,
                isOrganizer,          // 添加权限参数
                paginationInfo.pageData  // 添加当前页面数据
            );
            
            await interaction.editReply({
                embeds: [embed],
                components: components
            });
            
            console.log(`完整作品列表页面导航完成 - 频道: ${contestChannelId}, 页码: ${paginationInfo.currentPage}`);
            
        } catch (error) {
            console.error('处理完整作品列表页面导航时出错:', error);
            try {
                await interaction.followUp({
                    content: '❌ 页面导航时出现错误，请稍后重试。',
                    ephemeral: true
                });
            } catch (replyError) {
                console.error('回复错误信息失败:', replyError);
            }
        }
    }
    
    async handlePageNavigation(interaction) {
        try {
            await interaction.deferUpdate();
            
            const customId = interaction.customId;
            const contestChannelId = customId.split('_').slice(-1)[0];
            
            const contestChannelData = await this.getContestChannelData(contestChannelId);
            if (!contestChannelData) {
                return;
            }
            
            // 如果是刷新操作，清除缓存
            if (customId.includes(this.buttonIds.refresh)) {
                contestCacheManager.clearSubmissionCache(contestChannelId);
            }
            
            // 重新获取和显示数据（最近5个作品）
            const submissions = await this.getSubmissionsData(contestChannelId);
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
            try {
                await interaction.followUp({
                    content: '❌ 刷新展示时出现错误，请稍后重试。',
                    ephemeral: true
                });
            } catch (replyError) {
                console.error('回复错误信息失败:', replyError);
            }
        }
    }

    // 清除指定频道的缓存（当有新投稿时调用）
    clearCache(contestChannelId) {
        contestCacheManager.clearSubmissionCache(contestChannelId);
        contestCacheManager.clearContestChannelCache(contestChannelId);
    }

    // 获取缓存统计信息（用于调试）
    getCacheStats() {
        return contestCacheManager.getCacheStats();
    }

    // 处理投稿选择下拉菜单（修改版）
    async handleSubmissionSelect(interaction) {
        try {
            await interaction.deferUpdate();
            
            const selectedGlobalId = interaction.values[0];
            const contestChannelId = interaction.customId.replace('manage_select_submission_', '');
            
            // 存储用户的选择（使用用户ID + 频道ID作为键）
            if (!this.userSelections) {
                this.userSelections = new Map();
            }
            
            const selectionKey = `${interaction.user.id}_${contestChannelId}`;
            this.userSelections.set(selectionKey, {
                globalId: selectedGlobalId,
                timestamp: Date.now(),
                userId: interaction.user.id,
                contestChannelId: contestChannelId
            });
            
            // 设置5分钟过期时间
            setTimeout(() => {
                this.userSelections.delete(selectionKey);
                console.log(`清除过期的用户选择 - 用户: ${interaction.user.id}, 频道: ${contestChannelId}`);
            }, 5 * 60 * 1000); // 5分钟
            
            console.log(`主办人选择了投稿 - 全局ID: ${selectedGlobalId}, 频道: ${contestChannelId}, 用户: ${interaction.user.tag}`);
            
        } catch (error) {
            console.error('处理投稿选择时出错:', error);
        }
    }

    // 处理管理操作按钮
    async handleManagementAction(interaction) {
        try {
            const customId = interaction.customId;
            const contestChannelId = customId.split('_').slice(-1)[0];
            
            // 检查权限
            const contestChannelData = await this.getContestChannelData(contestChannelId);
            if (!contestChannelData || contestChannelData.applicantId !== interaction.user.id) {
                return interaction.reply({
                    content: '❌ 您没有权限执行此操作。',
                    ephemeral: true
                });
            }
            
            if (customId.includes('manage_quick_delete_')) {
                await this.handleQuickDelete(interaction, contestChannelId);
            } else if (customId.includes('manage_delete_with_reason_')) {
                await this.handleDeleteWithReason(interaction, contestChannelId);
            } else if (customId.includes('manage_delete_page_')) {
                await this.handleDeletePage(interaction, contestChannelId);
            }
            
        } catch (error) {
            console.error('处理管理操作时出错:', error);
            try {
                await interaction.reply({
                    content: '❌ 操作执行时出现错误，请稍后重试。',
                    ephemeral: true
                });
            } catch (replyError) {
                console.error('回复错误信息失败:', replyError);
            }
        }
    }

    // 快速拒稿投稿
    async handleQuickDelete(interaction, contestChannelId) {
        // 获取用户选择的投稿
        const selectedGlobalId = await this.getSelectedSubmissionFromMessage(interaction);
        if (!selectedGlobalId) {
            return interaction.reply({
                content: '❌ 请先从下拉菜单中选择要拒稿的投稿作品，然后再点击拒稿按钮。',
                ephemeral: true
            });
        }
        
        await interaction.deferReply({ ephemeral: true });
        
        try {
            const { deleteSubmissionWithReason } = require('./submissionManagementService');
            await deleteSubmissionWithReason(interaction, selectedGlobalId, contestChannelId, '主办人拒稿退回了您的投稿');
            
            // 清除用户选择
            this.clearUserSelection(interaction.user.id, contestChannelId);
            
            console.log(`投稿拒稿成功 - 全局ID: ${selectedGlobalId}, 用户: ${interaction.user.tag}`);
            
        } catch (error) {
            console.error('拒稿投稿时出错:', error);
            await interaction.editReply({
                content: '❌ 拒稿投稿时出现错误，请稍后重试。'
            });
        }
    }

    // 拒稿并提供理由
    async handleDeleteWithReason(interaction, contestChannelId) {
        const selectedGlobalId = await this.getSelectedSubmissionFromMessage(interaction);
        if (!selectedGlobalId) {
            return interaction.reply({
                content: '❌ 请先从下拉菜单中选择要拒稿的投稿作品，然后再点击拒稿按钮。',
                ephemeral: true
            });
        }
        
        const { createRejectionModal } = require('../components/rejectionModal');
        const modal = createRejectionModal(selectedGlobalId, contestChannelId);
        await interaction.showModal(modal);
        
        // 注意：这里不清除选择，因为用户还需要在模态框中完成操作
    }

    // 拒稿整页稿件
    async handleDeletePage(interaction, contestChannelId) {
        await interaction.deferReply({ ephemeral: true });
        
        // 获取当前页面的所有投稿
        const currentPageSubmissions = await this.getCurrentPageSubmissions(interaction);
        if (!currentPageSubmissions || currentPageSubmissions.length === 0) {
            return interaction.editReply({
                content: '❌ 当前页面没有投稿作品。'
            });
        }
        
        try {
            const { deleteSubmissionWithReason } = require('./submissionManagementService');
            let rejectedCount = 0;
            
            for (const submission of currentPageSubmissions) {
                try {
                    await deleteSubmissionWithReason(interaction, submission.globalId, contestChannelId, '主办人批量拒稿退回了投稿');
                    rejectedCount++;
                } catch (error) {
                    console.error(`拒稿投稿失败 - ID: ${submission.globalId}`, error);
                }
            }
            
            // 清除用户选择
            this.clearUserSelection(interaction.user.id, contestChannelId);
            
            await interaction.editReply({
                content: `✅ **批量拒稿成功！**\n\n📊 **拒稿统计：** 已成功拒稿退回 ${rejectedCount} 个投稿作品\n\n💡 **提示：** 请点击界面上的 🔄 刷新按钮来查看最新的投稿列表。`
            });
            
            console.log(`批量拒稿成功 - 拒稿数量: ${rejectedCount}, 用户: ${interaction.user.tag}`);
            
        } catch (error) {
            console.error('批量拒稿投稿时出错:', error);
            await interaction.editReply({
                content: '❌ 批量拒稿时出现错误，请稍后重试。'
            });
        }
    }

    // 从状态存储中获取用户选择
    async getSelectedSubmissionFromMessage(interaction) {
        if (!this.userSelections) {
            this.userSelections = new Map();
        }
        
        const contestChannelId = interaction.customId.split('_').slice(-1)[0];
        const selectionKey = `${interaction.user.id}_${contestChannelId}`;
        
        const selection = this.userSelections.get(selectionKey);
        if (!selection) {
            return null;
        }
        
        // 检查是否过期（10分钟）
        const isExpired = Date.now() - selection.timestamp > 10 * 60 * 1000;
        if (isExpired) {
            this.userSelections.delete(selectionKey);
            return null;
        }
        
        return selection.globalId;
    }

    // 清除用户选择
    clearUserSelection(userId, contestChannelId) {
        if (!this.userSelections) {
            this.userSelections = new Map();
            return;
        }
        
        const selectionKey = `${userId}_${contestChannelId}`;
        this.userSelections.delete(selectionKey);
    }

    // 辅助方法：获取当前页面的投稿
    async getCurrentPageSubmissions(interaction) {
        try {
            // 从embed的footer中解析当前页码，然后重新获取数据
            const footerText = interaction.message.embeds[0].footer.text;
            const pageMatch = footerText.match(/第 (\d+) 页/);
            const itemsMatch = footerText.match(/每页 (\d+) 个/);
            
            if (!pageMatch || !itemsMatch) return null;
            
            const currentPage = parseInt(pageMatch[1]);
            const itemsPerPage = parseInt(itemsMatch[1]);
            
            const contestChannelId = interaction.customId.split('_').slice(-1)[0];
            const submissions = await this.getSubmissionsData(contestChannelId);
            const processedSubmissions = preprocessSubmissions(submissions);
            const paginationInfo = paginateData(processedSubmissions, currentPage, itemsPerPage);
            
            return paginationInfo.pageData;
        } catch (error) {
            console.error('获取当前页面投稿时出错:', error);
            return null;
        }
    }

    // 删除 refreshSubmissionList 方法，或者改为一个简单的缓存清理方法
    clearSubmissionCache(contestChannelId) {
        // 只清理缓存，不尝试刷新界面
        this.clearCache(contestChannelId);
        console.log(`已清理投稿缓存 - 频道: ${contestChannelId}`);
    }

    // 获取状态存储统计信息（用于调试）
    getSelectionStats() {
        const stats = {
            totalSelections: this.userSelections.size,
            selections: []
        };
        
        for (const [key, value] of this.userSelections.entries()) {
            stats.selections.push({
                key,
                age: Date.now() - value.timestamp,
                userId: value.userId,
                contestChannelId: value.contestChannelId
            });
        }
        
        return stats;
    }

    // 新增：处理设置获奖作品
    async handleSetAward(interaction, contestChannelId) {
        // 获取用户选择的投稿
        const selectedGlobalId = await this.getSelectedSubmissionFromMessage(interaction);
        if (!selectedGlobalId) {
            return interaction.reply({
                content: '❌ 请先从下拉菜单中选择要设置获奖的投稿作品，然后再点击设置获奖作品按钮。',
                ephemeral: true
            });
        }
        
        try {
            const { createAwardModal } = require('../components/awardModal');
            const modal = createAwardModal(contestChannelId, selectedGlobalId);
            await interaction.showModal(modal);
            
            // 清除用户选择
            this.clearUserSelection(interaction.user.id, contestChannelId);
            
        } catch (error) {
            console.error('处理设置获奖作品时出错:', error);
            await interaction.reply({
                content: '❌ 设置获奖作品时出现错误，请稍后重试。',
                ephemeral: true
            });
        }
    }

    // 新增：处理获奖模态框提交
    async handleAwardModalSubmission(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });
            
            const customId = interaction.customId;
            const parts = customId.replace('award_modal_', '').split('_');
            const contestChannelId = parts[0];
            const submissionGlobalId = parts[1];
            
            const awardName = interaction.fields.getTextInputValue('award_name').trim();
            const awardMessage = interaction.fields.getTextInputValue('award_message').trim();
            
            const { setSubmissionAward, getContestSubmissionByGlobalId } = require('../utils/contestDatabase');
            
            // 设置获奖信息
            const updatedSubmission = await setSubmissionAward(submissionGlobalId, awardName, awardMessage);
            if (!updatedSubmission) {
                return interaction.editReply({
                    content: '❌ 找不到指定的投稿作品。'
                });
            }
            
            // 获取作品信息用于确认消息
            const submission = await getContestSubmissionByGlobalId(submissionGlobalId);
            const workUrl = `https://discord.com/channels/${submission.parsedInfo.guildId}/${submission.parsedInfo.channelId}/${submission.parsedInfo.messageId}`;
            
            const confirmMessage = `✅ **获奖作品设置成功！**\n\n🏆 **奖项：** ${awardName}\n📝 **作品：** ${workUrl}\n🆔 **投稿ID：** \`${submission.contestSubmissionId}\`${awardMessage ? `\n💬 **备注：** ${awardMessage}` : ''}`;
            
            await interaction.editReply({
                content: confirmMessage
            });
            
            console.log(`设置获奖作品成功 - 全局ID: ${submissionGlobalId}, 奖项: ${awardName}, 用户: ${interaction.user.tag}`);
            
        } catch (error) {
            console.error('处理获奖模态框提交时出错:', error);
            try {
                await interaction.editReply({
                    content: '❌ 设置获奖作品时出现错误，请稍后重试。'
                });
            } catch (replyError) {
                console.error('回复错误信息失败:', replyError);
            }
        }
    }

    // 修复：处理移除获奖作品
    async handleRemoveAward(interaction, contestChannelId) {
        // 获取用户选择的投稿
        const selectedGlobalId = await this.getSelectedSubmissionFromMessage(interaction);
        if (!selectedGlobalId) {
            return interaction.reply({
                content: '❌ 请先从下拉菜单中选择要移除获奖的投稿作品，然后再点击移除获奖作品按钮。',
                ephemeral: true
            });
        }
        
        // 确保只在有选择的情况下才 defer reply
        await interaction.deferReply({ ephemeral: true });
        
        try {
            const { removeSubmissionAward, getContestSubmissionByGlobalId } = require('../utils/contestDatabase');
            
            // 检查作品是否已设置获奖
            const submission = await getContestSubmissionByGlobalId(selectedGlobalId);
            if (!submission) {
                return interaction.editReply({
                    content: '❌ 找不到指定的投稿作品。'
                });
            }
            
            if (!submission.awardInfo || !submission.awardInfo.awardName) {
                return interaction.editReply({
                    content: '❌ 该作品尚未设置获奖信息，无需移除。'
                });
            }
            
            const oldAwardName = submission.awardInfo.awardName;
            
            // 移除获奖信息
            const updatedSubmission = await removeSubmissionAward(selectedGlobalId);
            if (!updatedSubmission) {
                return interaction.editReply({
                    content: '❌ 移除获奖信息失败。'
                });
            }
            
            const workUrl = `https://discord.com/channels/${submission.parsedInfo.guildId}/${submission.parsedInfo.channelId}/${submission.parsedInfo.messageId}`;
            
            await interaction.editReply({
                content: `✅ **获奖信息移除成功！**\n\n📝 **作品：** ${workUrl}\n🆔 **投稿ID：** \`${submission.contestSubmissionId}\`\n🏆 **已移除奖项：** ${oldAwardName}`
            });
            
            // 清除用户选择
            this.clearUserSelection(interaction.user.id, contestChannelId);
            
            console.log(`移除获奖信息成功 - 全局ID: ${selectedGlobalId}, 原奖项: ${oldAwardName}, 用户: ${interaction.user.tag}`);
            
        } catch (error) {
            console.error('移除获奖作品时出错:', error);
            try {
                await interaction.editReply({
                    content: '❌ 移除获奖作品时出现错误，请稍后重试。'
                });
            } catch (replyError) {
                console.error('回复错误信息失败:', replyError);
            }
        }
    }

    // 新增：处理完赛按钮（第一次点击完赛按钮，显示获奖清单）
    async handleFinishContest(interaction, contestChannelId) {
        await interaction.deferReply({ ephemeral: true });
        
        try {
            const { getAwardedSubmissions } = require('../utils/contestDatabase');
            
            // 获取所有获奖作品
            const awardedSubmissions = await getAwardedSubmissions(contestChannelId);
            
            const { createFinishContestConfirmation } = require('../components/finishContestModal');
            const { embed, components } = createFinishContestConfirmation(contestChannelId, awardedSubmissions);
            
            await interaction.editReply({
                embeds: [embed],
                components: components
            });
            
            console.log(`显示完赛确认 - 频道: ${contestChannelId}, 获奖作品数: ${awardedSubmissions.length}, 用户: ${interaction.user.tag}`);
            
        } catch (error) {
            console.error('处理完赛按钮时出错:', error);
            await interaction.editReply({
                content: '❌ 处理完赛时出现错误，请稍后重试。'
            });
        }
    }

    // 修改：处理完赛确认（第一次确认，现在改为显示二次确认）
    async handleFinishContestConfirm(interaction, contestChannelId) {
        await interaction.deferReply({ ephemeral: true });
        
        try {
            const { getAwardedSubmissions } = require('../utils/contestDatabase');
            
            // 获取获奖作品数量
            const awardedSubmissions = await getAwardedSubmissions(contestChannelId);
            
            const { createFinalConfirmation } = require('../components/finalConfirmModal');
            const { embed, components } = createFinalConfirmation(contestChannelId, awardedSubmissions.length);
            
            await interaction.editReply({
                embeds: [embed],
                components: components
            });
            
            console.log(`显示最终确认 - 频道: ${contestChannelId}, 获奖作品数: ${awardedSubmissions.length}, 用户: ${interaction.user.tag}`);
            
        } catch (error) {
            console.error('显示最终确认时出错:', error);
            await interaction.editReply({
                content: '❌ 显示确认界面时出现错误，请稍后重试。'
            });
        }
    }

    // 新增：处理最终完赛确认（真正的完赛操作）
    async handleFinalConfirmProceed(interaction, contestChannelId) {
        await interaction.deferReply({ ephemeral: true });
        
        try {
            const { 
                getAwardedSubmissions, 
                setContestFinished, 
                getContestChannel,
                updateContestChannel 
            } = require('../utils/contestDatabase');
            
            // 设置比赛为完赛状态
            await setContestFinished(contestChannelId, true);
            
            // 获取获奖作品
            const awardedSubmissions = await getAwardedSubmissions(contestChannelId);
            
            // 获取比赛频道
            const contestChannel = await interaction.client.channels.fetch(contestChannelId);
            const contestChannelData = await getContestChannel(contestChannelId);
            
            if (contestChannel && contestChannelData) {
                // 禁用投稿入口按钮
                await this.disableSubmissionEntry(contestChannel, contestChannelData);
                
                // 如果有获奖作品，发布获奖清单
                if (awardedSubmissions.length > 0) {
                    await this.publishAwardList(contestChannel, awardedSubmissions, contestChannelData);
                }
            }
            
            await interaction.editReply({
                content: `🎉 **比赛已成功完赛！**\n\n📊 **最终统计：**\n• 🏆 获奖作品数量：${awardedSubmissions.length}\n• 🚫 投稿入口已永久关闭\n${awardedSubmissions.length > 0 ? '• 📌 获奖清单已发布并置顶' : ''}\n• ⏰ 完赛时间：<t:${Math.floor(Date.now() / 1000)}:f>\n\n🎊 感谢所有参赛者的精彩参与！比赛圆满结束！`
            });
            
            console.log(`比赛最终完赛成功 - 频道: ${contestChannelId}, 获奖作品数: ${awardedSubmissions.length}, 用户: ${interaction.user.tag}`);
            
        } catch (error) {
            console.error('处理最终完赛确认时出错:', error);
            await interaction.editReply({
                content: '❌ 完赛处理时出现错误，请稍后重试。如果问题持续存在，请联系管理员。'
            });
        }
    }

    // 新增：处理取消最终确认
    async handleFinalConfirmCancel(interaction, contestChannelId) {
        await interaction.update({
            embeds: [{
                title: '✅ 操作已取消',
                description: '完赛操作已取消，比赛继续进行中。\n\n您可以继续管理投稿作品，或稍后再进行完赛操作。',
                color: 0x00FF00,
                timestamp: new Date().toISOString()
            }],
            components: []
        });
        
        console.log(`完赛操作已取消 - 频道: ${contestChannelId}, 用户: ${interaction.user.tag}`);
    }

    // 新增：禁用投稿入口
    async disableSubmissionEntry(contestChannel, contestChannelData) {
        try {
            const submissionMessage = await contestChannel.messages.fetch(contestChannelData.submissionEntry);
            
            if (submissionMessage) {
                // 更新嵌入消息
                const embed = submissionMessage.embeds[0];
                const updatedEmbed = new EmbedBuilder(embed.toJSON())
                    .setTitle('📝 作品投稿入口（已关闭）')
                    .setDescription('本次比赛已结束，投稿入口已关闭。\n\n感谢所有参赛者的参与！')
                    .setColor('#808080'); // 灰色表示已关闭
                
                // 禁用按钮
                const disabledButton = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`contest_submit_disabled_${contestChannel.id}`)
                            .setLabel('📝 投稿已结束')
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(true)
                    );
                
                await submissionMessage.edit({
                    embeds: [updatedEmbed],
                    components: [disabledButton]
                });
                
                console.log(`投稿入口已禁用 - 频道: ${contestChannel.id}`);
            }
            
        } catch (error) {
            console.error('禁用投稿入口时出错:', error);
        }
    }

    // 新增：发布获奖清单
    async publishAwardList(contestChannel, awardedSubmissions, contestChannelData) {
        try {
            const embed = new EmbedBuilder()
                .setTitle('🏆 获奖作品清单')
                .setDescription('恭喜以下获奖作品和参赛者！')
                .setColor('#FFD700')
                .setTimestamp();
            
            let awardList = '';
            awardedSubmissions.forEach((submission, index) => {
                const workUrl = `https://discord.com/channels/${submission.parsedInfo.guildId}/${submission.parsedInfo.channelId}/${submission.parsedInfo.messageId}`;
                const authorMention = `<@${submission.submitterId}>`;
                
                awardList += `${index + 1}. **${submission.awardInfo.awardName}**\n`;
                awardList += `${workUrl}\n`;
                awardList += `${authorMention}\n`;
                if (submission.awardInfo.awardMessage) {
                    awardList += `   ${submission.awardInfo.awardMessage}\n`;
                }
                awardList += '\n';
            });
            
            embed.setDescription(`恭喜以下获奖作品和参赛者！\n\n${awardList}感谢所有参赛者的精彩作品！`);
            
            const awardMessage = await contestChannel.send({
                embeds: [embed]
            });
            
            // 置顶获奖清单
            await awardMessage.pin();
            
            console.log(`获奖清单已发布 - 频道: ${contestChannel.id}, 消息ID: ${awardMessage.id}`);
            
        } catch (error) {
            console.error('发布获奖清单时出错:', error);
        }
    }
}

const displayService = new DisplayService();

module.exports = { displayService };