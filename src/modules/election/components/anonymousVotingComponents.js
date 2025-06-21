const { 
    ActionRowBuilder, 
    StringSelectMenuBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    EmbedBuilder
} = require('discord.js');
const { ElectionData, VoteData } = require('../data/electionDatabase');
const { getVotingPermissionDetails } = require('../utils/validationUtils');
const { createErrorEmbed, createSuccessEmbed } = require('../utils/messageUtils');

// === 修复CustomId长度限制：临时存储用户选择，避免customId过长 ===
const userSelections = new Map();
// 新增：跨页面选择状态管理
const userPageSelections = new Map();

// 清理过期的选择数据（10分钟过期）
setInterval(() => {
    const now = Date.now();
    for (const [key, data] of userSelections.entries()) {
        if (now - data.timestamp > 10 * 60 * 1000) { // 10分钟
            userSelections.delete(key);
        }
    }
    // 同时清理跨页面选择数据
    for (const [key, data] of userPageSelections.entries()) {
        if (now - data.timestamp > 10 * 60 * 1000) { // 10分钟
            userPageSelections.delete(key);
        }
    }
}, 5 * 60 * 1000); // 每5分钟清理一次

/**
 * 处理投票开始
 */
async function handleAnonymousVoteStart(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });

        const parts = interaction.customId.split('_');
        // customId格式: election_start_anonymous_vote_{electionId}_{positionId}
        // 考虑到electionId可能包含下划线，我们需要更精确的解析
        
        // 找到最后一个部分作为positionId
        const positionId = parts[parts.length - 1];
        // 将中间的部分重新组合作为electionId
        const electionId = parts.slice(4, -1).join('_');
        
        console.log(`解析得到 - 募选ID: ${electionId}, 职位ID: ${positionId}`);
        
        const userId = interaction.user.id;
        const guildId = interaction.guild.id;

        // ===== 详细权限验证 =====
        console.log(`检查用户 ${interaction.user.tag} (${userId}) 的投票权限...`);
        const permissionDetails = await getVotingPermissionDetails(interaction.member, guildId);
        
        if (!permissionDetails.hasPermission) {
            console.log(`用户 ${interaction.user.tag} 投票权限不足`);
            
            let errorMessage = '你缺少可以参与此募选投票的身份组。';
            
            if (permissionDetails.allowedRoles && permissionDetails.allowedRoles.length > 0) {
                const allowedRoleNames = permissionDetails.allowedRoles.map(role => `**${role.name}**`).join('、');
                errorMessage += `\n\n**允许投票的身份组：**\n${allowedRoleNames}`;
                
                if (permissionDetails.userRoles && permissionDetails.userRoles.length > 0) {
                    const userRoleNames = permissionDetails.userRoles.map(role => role.name).join('、');
                    errorMessage += `\n\n**你当前的身份组：**\n${userRoleNames}`;
                } else {
                    errorMessage += `\n\n**你当前的身份组：**\n无特殊身份组`;
                }
            }
            
            errorMessage += '\n\n请联系服务器管理员了解投票身份组要求。';
            
            const errorEmbed = createErrorEmbed('权限不足', errorMessage);
            return await interaction.editReply({ embeds: [errorEmbed] });
        }
        console.log(`用户 ${interaction.user.tag} 投票权限验证通过`);
        // ===== 权限验证结束 =====

        // 获取投票数据
        console.log(`查找投票数据 - 募选ID: ${electionId}, 职位ID: ${positionId}`);
        const votes = await VoteData.getByElection(electionId);
        console.log(`找到 ${votes.length} 个投票记录`);
        
        const vote = votes.find(v => v.positionId === positionId);
        console.log(`匹配的投票记录:`, vote ? `找到 (${vote.voteId})` : '未找到');

        if (!vote) {
            const errorEmbed = createErrorEmbed('投票不存在', `该投票可能已被删除或不存在\n\n调试信息：\n募选ID: ${electionId}\n职位ID: ${positionId}`);
            return await interaction.editReply({ embeds: [errorEmbed] });
        }

        // 检查用户是否已投票
        const hasVoted = await VoteData.hasUserVoted(vote.voteId, interaction.user.id);
        if (hasVoted) {
            const errorEmbed = createErrorEmbed('已投票', '你已经为这个职位投过票了，不能重复投票');
            return await interaction.editReply({ embeds: [errorEmbed] });
        }

        // 创建候选人选择菜单 - 分页处理
        const allOptions = vote.candidates.map((candidate) => ({
            label: candidate.displayName,
            value: candidate.userId,
            description: candidate.choiceType === 'second' ? '第二志愿候选人' : '第一志愿候选人',
            emoji: '👤'
        }));

        // Discord选择菜单最多支持25个选项
        const maxOptionsPerPage = 25;
        const totalPages = Math.ceil(allOptions.length / maxOptionsPerPage);
        
        if (totalPages === 1) {
            // 单页处理 - 原有逻辑
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`election_anonymous_vote_select_${vote.voteId}`)
                .setPlaceholder(`请选择候选人 (最多选择 ${vote.maxSelections} 人)`)
                .addOptions(allOptions)
                .setMaxValues(Math.min(vote.maxSelections, allOptions.length))
                .setMinValues(1);

            const row = new ActionRowBuilder().addComponents(selectMenu);

            const embed = new EmbedBuilder()
                .setTitle(`🗳️ ${vote.positionName} - 投票`)
                .setDescription(`请选择你支持的候选人 (最多选择 ${vote.maxSelections} 人)\n\n**候选人列表：**\n${vote.candidates.map(c => {
                    let candidateText = `<@${c.userId}> (${c.displayName})`;
                    if (c.choiceType === 'second') {
                        candidateText += ' (第二志愿)';
                    }
                    return candidateText;
                }).join('\n')}`)
                .setColor('#9b59b6');

            await interaction.editReply({
                embeds: [embed],
                components: [row]
            });
        } else {
            // 多页处理 - 显示第一页，使用空的选择集合初始化
            const emptySelections = new Set();
            await showVotingPageWithSelections(interaction, vote, 0, totalPages, allOptions, emptySelections);
        }

    } catch (error) {
        console.error('处理投票开始时出错:', error);
        const errorEmbed = createErrorEmbed('系统错误', '处理投票时发生错误，请稍后重试');
        
        if (interaction.deferred) {
            await interaction.editReply({ embeds: [errorEmbed] });
        } else {
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }
    }
}

/**
 * 显示投票页面（分页版本）
 */
async function showVotingPage(interaction, vote, currentPage, totalPages, allOptions) {
    const maxOptionsPerPage = 25;
    const startIndex = currentPage * maxOptionsPerPage;
    const endIndex = Math.min(startIndex + maxOptionsPerPage, allOptions.length);
    const pageOptions = allOptions.slice(startIndex, endIndex);

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`election_anonymous_vote_select_${vote.voteId}_page_${currentPage}`)
        .setPlaceholder(`选择候选人 (第${currentPage + 1}/${totalPages}页)`)
        .addOptions(pageOptions)
        .setMaxValues(Math.min(vote.maxSelections, pageOptions.length))
        .setMinValues(0); // 允许不选择（可能在其他页面选择）

    const components = [new ActionRowBuilder().addComponents(selectMenu)];

    // 添加分页按钮
    if (totalPages > 1) {
        const navigationButtons = [];
        
        if (currentPage > 0) {
            navigationButtons.push(
                new ButtonBuilder()
                    .setCustomId(`election_vote_prev_${vote.voteId}_${currentPage}`)
                    .setLabel('上一页')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('⬅️')
            );
        }
        
        if (currentPage < totalPages - 1) {
            navigationButtons.push(
                new ButtonBuilder()
                    .setCustomId(`election_vote_next_${vote.voteId}_${currentPage}`)
                    .setLabel('下一页')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('➡️')
            );
        }

        // 添加完成选择按钮
        navigationButtons.push(
            new ButtonBuilder()
                .setCustomId(`election_vote_complete_${vote.voteId}`)
                .setLabel('完成选择')
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅')
        );

        if (navigationButtons.length > 0) {
            components.push(new ActionRowBuilder().addComponents(navigationButtons));
        }
    }

    const embed = new EmbedBuilder()
        .setTitle(`🗳️ ${vote.positionName} - 投票 (第${currentPage + 1}/${totalPages}页)`)
        .setDescription(`**候选人总数：** ${allOptions.length} 人\n**当前页候选人：** ${startIndex + 1}-${endIndex}\n**最多选择：** ${vote.maxSelections} 人\n\n💡 可以在多个页面中选择候选人，选择完成后点击"完成选择"按钮`)
        .setColor('#9b59b6');

    if (totalPages === 1) {
        await interaction.editReply({
            embeds: [embed],
            components: components
        });
    } else {
        await interaction.editReply({
            embeds: [embed],
            components: components
        });
    }
}

/**
 * 处理投票选择
 */
async function handleAnonymousVoteSelect(interaction) {
    try {
        await interaction.deferUpdate();

        // 修复voteId提取逻辑，支持分页版本
        // customId格式可能是：
        // election_anonymous_vote_select_{voteId} (单页版本)
        // election_anonymous_vote_select_{voteId}_page_{currentPage} (分页版本)
        const parts = interaction.customId.split('_');
        let voteId;
        let isPagedVersion = false;
        let currentPage = 0;
        
        if (parts.includes('page')) {
            // 分页版本：找到page的位置，voteId在page之前
            const pageIndex = parts.indexOf('page');
            voteId = parts.slice(4, pageIndex).join('_');
            currentPage = parseInt(parts[pageIndex + 1]);
            isPagedVersion = true;
        } else {
            // 单页版本：从索引4开始的所有部分
            voteId = parts.slice(4).join('_');
        }

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

        if (isPagedVersion) {
            // === 分页模式：更新跨页面选择状态，不直接进入确认界面 ===
            const userKey = `${interaction.user.id}_${voteId}`;
            
            // 获取或创建用户的跨页面选择数据
            let userPageData = userPageSelections.get(userKey);
            if (!userPageData) {
                userPageData = {
                    voteId,
                    selectedCandidates: new Set(),
                    timestamp: Date.now()
                };
                userPageSelections.set(userKey, userPageData);
            }

            // 更新当前页面的选择（移除之前在此页面的选择，添加新选择）
            // 先移除当前页面之前的选择
            const currentPageCandidates = vote.candidates.slice(
                currentPage * 25, 
                Math.min((currentPage + 1) * 25, vote.candidates.length)
            ).map(c => c.userId);
            
            currentPageCandidates.forEach(candidateId => {
                userPageData.selectedCandidates.delete(candidateId);
            });

            // 添加新选择
            selectedCandidates.forEach(candidateId => {
                userPageData.selectedCandidates.add(candidateId);
            });

            // 更新时间戳
            userPageData.timestamp = Date.now();

            // 重新构建候选人选项
            const allOptions = vote.candidates.map((candidate) => ({
                label: candidate.displayName,
                value: candidate.userId,
                description: candidate.choiceType === 'second' ? '第二志愿候选人' : '第一志愿候选人',
                emoji: '👤'
            }));

            const maxOptionsPerPage = 25;
            const totalPages = Math.ceil(allOptions.length / maxOptionsPerPage);

            // 返回到分页界面，显示已选择的状态
            await showVotingPageWithSelections(interaction, vote, currentPage, totalPages, allOptions, userPageData.selectedCandidates);

        } else {
            // === 单页模式：保持原有逻辑，直接进入确认界面 ===
            const selectionKey = `${interaction.user.id}_${voteId}_${Date.now()}`;
            userSelections.set(selectionKey, {
                voteId,
                selectedCandidates,
                timestamp: Date.now()
            });

            // 创建确认按钮 - 使用短的selectionKey避免customId过长
            const confirmButton = new ButtonBuilder()
                .setCustomId(`election_anonymous_vote_confirm_${selectionKey}`)
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
        }

    } catch (error) {
        console.error('处理投票选择时出错:', error);
        const errorEmbed = createErrorEmbed('系统错误', '处理投票时发生错误，请稍后重试');
        await interaction.editReply({ embeds: [errorEmbed], components: [] });
    }
}

/**
 * 显示投票页面（分页版本，带选择状态）
 */
async function showVotingPageWithSelections(interaction, vote, currentPage, totalPages, allOptions, selectedCandidatesSet) {
    const maxOptionsPerPage = 25;
    const startIndex = currentPage * maxOptionsPerPage;
    const endIndex = Math.min(startIndex + maxOptionsPerPage, allOptions.length);
    const pageOptions = allOptions.slice(startIndex, endIndex);

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`election_anonymous_vote_select_${vote.voteId}_page_${currentPage}`)
        .setPlaceholder(`选择候选人 (第${currentPage + 1}/${totalPages}页)`)
        .addOptions(pageOptions)
        .setMaxValues(Math.min(vote.maxSelections, pageOptions.length))
        .setMinValues(0); // 允许不选择

    const components = [new ActionRowBuilder().addComponents(selectMenu)];

    // 添加分页按钮
    if (totalPages > 1) {
        const navigationButtons = [];
        
        if (currentPage > 0) {
            navigationButtons.push(
                new ButtonBuilder()
                    .setCustomId(`election_vote_prev_${vote.voteId}_${currentPage}`)
                    .setLabel('上一页')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('⬅️')
            );
        }
        
        if (currentPage < totalPages - 1) {
            navigationButtons.push(
                new ButtonBuilder()
                    .setCustomId(`election_vote_next_${vote.voteId}_${currentPage}`)
                    .setLabel('下一页')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('➡️')
            );
        }

        // 添加完成选择按钮
        navigationButtons.push(
            new ButtonBuilder()
                .setCustomId(`election_vote_complete_${vote.voteId}`)
                .setLabel('完成选择')
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅')
        );

        if (navigationButtons.length > 0) {
            components.push(new ActionRowBuilder().addComponents(navigationButtons));
        }
    }

    // 构建描述
    const totalSelected = selectedCandidatesSet.size;
    
    let description = `请选择你支持的候选人 (最多选择 ${vote.maxSelections} 人)\n\n`;
    
    // === 保留@所有候选人的功能，并添加displayName显示 ===
    description += `**候选人列表：**\n${vote.candidates.map(c => {
        let candidateText = `<@${c.userId}> (${c.displayName})`;
        if (c.choiceType === 'second') {
            candidateText += ' (第二志愿)';
        }
        return candidateText;
    }).join('\n')}\n\n`;
    
    // 分页信息
    description += `**候选人总数：** ${allOptions.length} 人\n`;
    description += `**当前页候选人：** ${startIndex + 1}-${endIndex} 人\n`;
    description += `**已选择：** ${totalSelected} 人`;
    
    // 如果有选择，显示已选择的候选人（使用displayName而不是@，避免重复@）
    if (totalSelected > 0) {
        const selectedList = Array.from(selectedCandidatesSet).map(candidateId => {
            const candidate = vote.candidates.find(c => c.userId === candidateId);
            return candidate ? candidate.displayName : '未知候选人';
        });
        description += `\n\n**已选择的候选人：**\n${selectedList.map((name, i) => `${i + 1}. ${name}`).join('\n')}`;
    }
    
    description += `\n\n💡 可以在多个页面中选择候选人，选择完成后点击"完成选择"按钮`;

    const embed = new EmbedBuilder()
        .setTitle(`🗳️ ${vote.positionName} - 投票 (第${currentPage + 1}/${totalPages}页)`)
        .setDescription(description)
        .setColor('#9b59b6');

    await interaction.editReply({
        embeds: [embed],
        components: components
    });
}

/**
 * 处理投票确认
 */
async function handleAnonymousVoteConfirm(interaction) {
    try {
        await interaction.deferUpdate();

        // === 修复CustomId长度限制：从缓存中获取选择数据 ===
        const parts = interaction.customId.split('_');
        const selectionKey = parts.slice(4).join('_');

        // 从缓存中获取选择数据
        const selectionData = userSelections.get(selectionKey);
        if (!selectionData) {
            const errorEmbed = createErrorEmbed('投票过期', '投票选择已过期，请重新选择候选人');
            return await interaction.editReply({ embeds: [errorEmbed], components: [] });
        }

        const { voteId, selectedCandidates } = selectionData;

        // 验证用户身份（确保selectionKey中的用户ID与当前用户匹配）
        if (!selectionKey.startsWith(interaction.user.id)) {
            const errorEmbed = createErrorEmbed('权限错误', '无法确认他人的投票');
            return await interaction.editReply({ embeds: [errorEmbed], components: [] });
        }

        // 记录投票
        await VoteData.addVote(voteId, interaction.user.id, selectedCandidates);

        // 清理缓存
        userSelections.delete(selectionKey);

        const successEmbed = createSuccessEmbed(
            '投票成功',
            '你的投票已记录，感谢参与！'
        );

        await interaction.editReply({
            embeds: [successEmbed],
            components: []
        });

    } catch (error) {
        console.error('处理投票确认时出错:', error);
        const errorEmbed = createErrorEmbed('系统错误', '记录投票时发生错误，请稍后重试');
        await interaction.editReply({ embeds: [errorEmbed], components: [] });
    }
}

/**
 * 处理投票取消
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
        console.error('处理投票取消时出错:', error);
    }
}

/**
 * 修改分页按钮处理，保持选择状态
 */
async function handleVotingPagination(interaction) {
    try {
        await interaction.deferUpdate();

        const parts = interaction.customId.split('_');
        // customId格式: election_vote_prev/next_{voteId}_{currentPage}
        const action = parts[2]; // prev 或 next
        const voteId = parts.slice(3, -1).join('_'); // 重新组合voteId
        const currentPage = parseInt(parts[parts.length - 1]);

        // 获取投票数据
        const vote = await VoteData.getById(voteId);
        if (!vote) {
            const errorEmbed = createErrorEmbed('投票不存在', '该投票可能已被删除或不存在');
            return await interaction.editReply({ embeds: [errorEmbed], components: [] });
        }

        // 获取用户的跨页面选择状态
        const userKey = `${interaction.user.id}_${voteId}`;
        let userPageData = userPageSelections.get(userKey);
        if (!userPageData) {
            userPageData = {
                voteId,
                selectedCandidates: new Set(),
                timestamp: Date.now()
            };
            userPageSelections.set(userKey, userPageData);
        }

        // 重新构建候选人选项
        const allOptions = vote.candidates.map((candidate) => ({
            label: candidate.displayName,
            value: candidate.userId,
            description: candidate.choiceType === 'second' ? '第二志愿候选人' : '第一志愿候选人',
            emoji: '👤'
        }));

        const maxOptionsPerPage = 25;
        const totalPages = Math.ceil(allOptions.length / maxOptionsPerPage);

        // 计算新页面
        let newPage;
        if (action === 'prev') {
            newPage = Math.max(0, currentPage - 1);
        } else if (action === 'next') {
            newPage = Math.min(totalPages - 1, currentPage + 1);
        }

        // 显示新页面，保持选择状态
        await showVotingPageWithSelections(interaction, vote, newPage, totalPages, allOptions, userPageData.selectedCandidates);

    } catch (error) {
        console.error('处理分页按钮时出错:', error);
        const errorEmbed = createErrorEmbed('系统错误', '处理分页时发生错误，请稍后重试');
        await interaction.editReply({ embeds: [errorEmbed], components: [] });
    }
}

/**
 * 修改完成选择按钮处理
 */
async function handleVoteComplete(interaction) {
    try {
        await interaction.deferUpdate();

        const parts = interaction.customId.split('_');
        const voteId = parts.slice(3).join('_'); // election_vote_complete_{voteId}

        // 获取用户的跨页面选择状态
        const userKey = `${interaction.user.id}_${voteId}`;
        const userPageData = userPageSelections.get(userKey);
        
        if (!userPageData || userPageData.selectedCandidates.size === 0) {
            const errorEmbed = createErrorEmbed('未选择候选人', '请先选择至少一个候选人');
            return await interaction.editReply({ embeds: [errorEmbed], components: [] });
        }

        // 获取投票数据进行验证
        const vote = await VoteData.getById(voteId);
        if (!vote) {
            const errorEmbed = createErrorEmbed('投票不存在', '该投票可能已被删除或不存在');
            return await interaction.editReply({ embeds: [errorEmbed], components: [] });
        }

        // 验证选择数量
        if (userPageData.selectedCandidates.size > vote.maxSelections) {
            const errorEmbed = createErrorEmbed('选择超限', `最多只能选择 ${vote.maxSelections} 个候选人，你选择了 ${userPageData.selectedCandidates.size} 个`);
            return await interaction.editReply({ embeds: [errorEmbed], components: [] });
        }

        const selectedCandidates = Array.from(userPageData.selectedCandidates);

        // 转移到确认流程
        const selectionKey = `${interaction.user.id}_${voteId}_${Date.now()}`;
        userSelections.set(selectionKey, {
            voteId,
            selectedCandidates,
            timestamp: Date.now()
        });

        // 清理跨页面选择数据
        userPageSelections.delete(userKey);

        // 创建确认按钮
        const confirmButton = new ButtonBuilder()
            .setCustomId(`election_anonymous_vote_confirm_${selectionKey}`)
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
        console.error('处理完成选择按钮时出错:', error);
        const errorEmbed = createErrorEmbed('系统错误', '处理完成选择时发生错误，请稍后重试');
        await interaction.editReply({ embeds: [errorEmbed], components: [] });
    }
}

module.exports = {
    handleAnonymousVoteStart,
    handleAnonymousVoteSelect,
    handleAnonymousVoteConfirm,
    handleAnonymousVoteCancel,
    handleVotingPagination,
    handleVoteComplete
}; 