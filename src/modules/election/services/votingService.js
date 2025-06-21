const { ElectionData, RegistrationData, VoteData } = require('../data/electionDatabase');
const { generateUniqueId } = require('../utils/validationUtils');

/**
 * 为募选创建投票器
 * @param {Client} client - Discord客户端
 * @param {object} election - 募选数据
 */
async function createVotingPollsForElection(client, election) {
    try {
        console.log(`为募选 ${election.name} 创建投票器...`);

        // 获取所有报名
        const registrations = await RegistrationData.getByElection(election.electionId);
        
        if (registrations.length === 0) {
            console.log('没有候选人报名，跳过投票器创建');
            return;
        }

        const votingChannelId = election.channels?.votingChannelId || election.channels?.registrationChannelId;
        if (!votingChannelId) {
            console.error('未设置投票频道');
            return;
        }

        const channel = client.channels.cache.get(votingChannelId);
        if (!channel) {
            console.error(`找不到投票频道: ${votingChannelId}`);
            return;
        }

        // 为每个职位创建投票器
        for (const [positionId, position] of Object.entries(election.positions)) {
            await createPositionVotingPoll(channel, election, positionId, position, registrations);
            
            // 延迟避免API限制
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log(`募选 ${election.name} 的投票器创建完成`);

    } catch (error) {
        console.error('创建投票器时出错:', error);
        throw error;
    }
}

/**
 * 为单个职位创建投票器
 * @param {Channel} channel - 投票频道
 * @param {object} election - 募选数据
 * @param {string} positionId - 职位ID
 * @param {object} position - 职位信息
 * @param {Array} registrations - 所有报名记录
 */
async function createPositionVotingPoll(channel, election, positionId, position, registrations) {
    try {
        // 获取该职位的候选人
        const firstChoiceCandidates = registrations.filter(reg => 
            reg.firstChoicePosition === positionId
        ).map(reg => ({
            userId: reg.userId,
            displayName: reg.userDisplayName,
            choiceType: 'first',
            selfIntroduction: reg.selfIntroduction
        }));

        const secondChoiceCandidates = registrations.filter(reg => 
            reg.secondChoicePosition === positionId
        ).map(reg => ({
            userId: reg.userId,
            displayName: reg.userDisplayName,
            choiceType: 'second',
            selfIntroduction: reg.selfIntroduction
        }));

        // 合并候选人（去重）
        const allCandidates = [...firstChoiceCandidates];
        secondChoiceCandidates.forEach(secondCandidate => {
            if (!allCandidates.find(c => c.userId === secondCandidate.userId)) {
                allCandidates.push(secondCandidate);
            }
        });

        if (allCandidates.length === 0) {
            console.log(`职位 ${position.name} 没有候选人，跳过投票器创建`);
            return;
        }

        // 创建投票嵌入消息
        const { createCandidateListEmbed } = require('../utils/messageUtils');
        const embed = createCandidateListEmbed(position.name, allCandidates, position.maxWinners);

        // 创建投票按钮组件
        const components = createVotingComponents(election.electionId, positionId, allCandidates, position.maxWinners);

        // 发送投票消息
        const votingMessage = await channel.send({
            embeds: [embed],
            components: components
        });

        // 保存投票数据
        const voteId = generateUniqueId('vote_');
        await VoteData.create({
            voteId: voteId,
            electionId: election.electionId,
            positionId: positionId,
            positionName: position.name,
            maxSelections: position.maxWinners,
            candidates: allCandidates,
            messageId: votingMessage.id
        });

        console.log(`职位 ${position.name} 的投票器已创建`);

    } catch (error) {
        console.error(`创建职位 ${position.name} 投票器时出错:`, error);
        throw error;
    }
}

/**
 * 创建投票组件
 * @param {string} electionId - 募选ID
 * @param {string} positionId - 职位ID
 * @param {Array} candidates - 候选人列表
 * @param {number} maxSelections - 最大选择数
 * @returns {Array} 组件数组
 */
function createVotingComponents(electionId, positionId, candidates, maxSelections) {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    
    const components = [];
    const rows = [];
    let currentRow = new ActionRowBuilder();
    let buttonCount = 0;

    // 为每个候选人创建按钮
    candidates.forEach((candidate, index) => {
        const button = new ButtonBuilder()
            .setCustomId(`election_vote_${electionId}_${positionId}_${candidate.userId}`)
            .setLabel(`${index + 1}. ${candidate.displayName}`)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('✅');

        // 标记第二志愿候选人
        if (candidate.choiceType === 'second') {
            button.setLabel(`${index + 1}. ${candidate.displayName} (第二志愿)`);
        }

        currentRow.addComponents(button);
        buttonCount++;

        // 每行最多5个按钮
        if (buttonCount >= 5 || index === candidates.length - 1) {
            rows.push(currentRow);
            currentRow = new ActionRowBuilder();
            buttonCount = 0;
        }
    });

    // 添加确认投票按钮
    const confirmRow = new ActionRowBuilder();
    confirmRow.addComponents(
        new ButtonBuilder()
            .setCustomId(`election_confirm_vote_${electionId}_${positionId}`)
            .setLabel('确认投票')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🗳️')
    );

    rows.push(confirmRow);

    return rows.slice(0, 5); // Discord限制最多5行组件
}

/**
 * 处理投票按钮点击
 * @param {Interaction} interaction - Discord交互
 */
async function handleVotingButton(interaction) {
    try {
        // 这个函数会在votingComponents.js中实现
        // 这里只是占位符，实际处理逻辑在组件文件中
        console.log('投票按钮处理逻辑应在votingComponents.js中实现');
    } catch (error) {
        console.error('处理投票按钮时出错:', error);
    }
}

/**
 * 获取投票统计
 * @param {string} voteId - 投票ID
 * @returns {object} 投票统计
 */
async function getVotingStatistics(voteId) {
    try {
        const vote = await VoteData.getById(voteId);
        if (!vote) {
            throw new Error('投票不存在');
        }

        const stats = {
            totalVoters: Object.keys(vote.votes || {}).length,
            candidateStats: {},
            maxSelections: vote.maxSelections
        };

        // 统计每个候选人的得票数
        vote.candidates.forEach(candidate => {
            stats.candidateStats[candidate.userId] = {
                displayName: candidate.displayName,
                choiceType: candidate.choiceType,
                votes: 0
            };
        });

        // 计算得票数
        Object.values(vote.votes || {}).forEach(candidateIds => {
            if (Array.isArray(candidateIds)) {
                candidateIds.forEach(candidateId => {
                    if (stats.candidateStats[candidateId]) {
                        stats.candidateStats[candidateId].votes++;
                    }
                });
            }
        });

        return stats;

    } catch (error) {
        console.error('获取投票统计时出错:', error);
        throw error;
    }
}

/**
 * 检查用户是否已投票
 * @param {string} voteId - 投票ID
 * @param {string} userId - 用户ID
 * @returns {boolean} 是否已投票
 */
async function hasUserVoted(voteId, userId) {
    try {
        return await VoteData.hasUserVoted(voteId, userId);
    } catch (error) {
        console.error('检查用户投票状态时出错:', error);
        return false;
    }
}

/**
 * 记录用户投票
 * @param {string} voteId - 投票ID
 * @param {string} userId - 用户ID
 * @param {Array} candidateIds - 候选人ID数组
 */
async function recordVote(voteId, userId, candidateIds) {
    try {
        await VoteData.addVote(voteId, userId, candidateIds);
        console.log(`用户 ${userId} 在投票 ${voteId} 中的投票已记录`);
    } catch (error) {
        console.error('记录投票时出错:', error);
        throw error;
    }
}

/**
 * 为单个职位创建匿名投票器
 */
async function createPositionAnonymousVotingPoll(channel, election, positionId, position, registrations) {
    try {
        // 获取该职位的候选人
        const firstChoiceCandidates = registrations.filter(reg => 
            reg.firstChoicePosition === positionId
        ).map(reg => ({
            userId: reg.userId,
            displayName: reg.userDisplayName,
            choiceType: 'first',
            selfIntroduction: reg.selfIntroduction
        }));

        const secondChoiceCandidates = registrations.filter(reg => 
            reg.secondChoicePosition === positionId
        ).map(reg => ({
            userId: reg.userId,
            displayName: reg.userDisplayName,
            choiceType: 'second',
            selfIntroduction: reg.selfIntroduction
        }));

        // 合并候选人（去重）
        const allCandidates = [...firstChoiceCandidates];
        secondChoiceCandidates.forEach(secondCandidate => {
            if (!allCandidates.find(c => c.userId === secondCandidate.userId)) {
                allCandidates.push(secondCandidate);
            }
        });

        if (allCandidates.length === 0) {
            console.log(`职位 ${position.name} 没有候选人，跳过投票器创建`);
            return;
        }

        // 创建匿名投票嵌入消息
        const { EmbedBuilder } = require('discord.js');
        const embed = new EmbedBuilder()
            .setTitle(`🗳️ ${position.name} - 投票`)
            .setDescription(`请选择你支持的候选人 (最多选择 ${position.maxWinners} 人)`)
            .setColor('#9b59b6');

        // 显示候选人列表（不显示自我介绍，避免消息过长）
        const candidateList = allCandidates.map((candidate) => {
            let info = `<@${candidate.userId}>`;  // 修改：使用@提及替代序号+昵称
            if (candidate.choiceType === 'second') {
                info += ' (第二志愿)';
            }
            return info;
        }).join('\n');

        embed.addFields(
            { name: '候选人列表', value: candidateList, inline: false }
        );

        // 创建匿名投票按钮
        const components = createAnonymousVotingComponents(election.electionId, positionId, allCandidates, position.maxWinners);

        // 发送投票消息
        const votingMessage = await channel.send({
            embeds: [embed],
            components: components
        });

        // 保存投票数据
        const voteId = generateUniqueId('vote_');
        await VoteData.create({
            voteId: voteId,
            electionId: election.electionId,
            positionId: positionId,
            positionName: position.name,
            maxSelections: position.maxWinners,
            candidates: allCandidates,
            messageId: votingMessage.id,
            isAnonymous: true // 标记为匿名投票
        });

        console.log(`职位 ${position.name} 的匿名投票器已创建`);

    } catch (error) {
        console.error('创建匿名投票器时出错:', error);
    }
}

/**
 * 创建匿名投票组件
 */
function createAnonymousVotingComponents(electionId, positionId, candidates, maxSelections) {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    
    // 创建一个"开始投票"按钮，点击后显示候选人选择
    const voteButton = new ButtonBuilder()
        .setCustomId(`election_start_anonymous_vote_${electionId}_${positionId}`)
        .setLabel('🗳️ 开始投票')
        .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(voteButton);
    
    return [row];
}

/**
 * 更新单个投票器的候选人名单
 * @param {Client} client - Discord客户端
 * @param {object} election - 选举数据
 * @param {object} vote - 投票器数据
 * @param {Array} registrations - 最新的报名数据
 * @returns {object} 更新结果
 */
async function updateVotingPollCandidates(client, election, vote, registrations) {
    const result = {
        voteId: vote.voteId,
        positionId: vote.positionId,
        positionName: vote.positionName,
        updated: false,
        newCandidates: [],
        newCandidatesCount: 0,
        error: null
    };

    try {
        // 从报名数据中获取该职位的最新候选人
        const firstChoiceCandidates = registrations.filter(reg => 
            reg.firstChoicePosition === vote.positionId && reg.status === 'active'
        ).map(reg => ({
            userId: reg.userId,
            displayName: reg.userDisplayName,
            choiceType: 'first',
            selfIntroduction: reg.selfIntroduction
        }));

        const secondChoiceCandidates = registrations.filter(reg => 
            reg.secondChoicePosition === vote.positionId && reg.status === 'active'
        ).map(reg => ({
            userId: reg.userId,
            displayName: reg.userDisplayName,
            choiceType: 'second',
            selfIntroduction: reg.selfIntroduction
        }));

        // 合并候选人（去重）
        const latestCandidates = [...firstChoiceCandidates];
        secondChoiceCandidates.forEach(secondCandidate => {
            if (!latestCandidates.find(c => c.userId === secondCandidate.userId)) {
                latestCandidates.push(secondCandidate);
            }
        });

        // 获取当前投票器中的候选人ID列表
        const currentCandidateIds = vote.candidates.map(c => c.userId);
        
        // 找出新增的候选人
        const newCandidates = latestCandidates.filter(candidate => 
            !currentCandidateIds.includes(candidate.userId)
        );

        // 如果没有新候选人，直接返回
        if (newCandidates.length === 0) {
            result.updated = true; // 虽然没有变化，但操作成功
            return result;
        }

        // 更新候选人列表
        const updatedCandidates = [...vote.candidates, ...newCandidates];
        
        // 更新votes.json文件中的候选人数据
        const votes = await VoteData.getAll();
        if (votes[vote.voteId]) {
            votes[vote.voteId].candidates = updatedCandidates;
            
            // 直接写入文件更新数据
            const fs = require('fs').promises;
            const path = require('path');
            const VOTES_FILE = path.join(__dirname, '../data/votes.json');
            await fs.writeFile(VOTES_FILE, JSON.stringify(votes, null, 2), 'utf8');
        }

        // 更新Discord消息
        await updateDiscordVotingMessage(client, election, vote, updatedCandidates);

        // 设置返回结果
        result.updated = true;
        result.newCandidates = newCandidates;
        result.newCandidatesCount = newCandidates.length;

        console.log(`投票器 ${vote.positionName} 已更新，新增 ${newCandidates.length} 个候选人`);

    } catch (error) {
        console.error(`更新投票器 ${vote.positionName} 时出错:`, error);
        result.error = error.message;
    }

    return result;
}

/**
 * 更新Discord中的投票器消息
 * @param {Client} client - Discord客户端
 * @param {object} election - 选举数据
 * @param {object} vote - 投票器数据
 * @param {Array} updatedCandidates - 更新后的候选人列表
 */
async function updateDiscordVotingMessage(client, election, vote, updatedCandidates) {
    try {
        const votingChannelId = election.channels?.votingChannelId;
        if (!votingChannelId || !vote.messageId) {
            throw new Error('缺少频道ID或消息ID');
        }

        const channel = client.channels.cache.get(votingChannelId);
        if (!channel) {
            throw new Error(`找不到投票频道: ${votingChannelId}`);
        }

        const message = await channel.messages.fetch(vote.messageId);
        if (!message) {
            throw new Error(`找不到投票消息: ${vote.messageId}`);
        }

        // 判断是否为匿名投票
        if (vote.isAnonymous) {
            // 匿名投票：重新生成嵌入消息
            const { EmbedBuilder } = require('discord.js');
            const embed = new EmbedBuilder()
                .setTitle(`🗳️ ${vote.positionName} - 投票`)
                .setDescription(`请选择你支持的候选人 (最多选择 ${vote.maxSelections} 人)`)
                .setColor('#9b59b6');

            // 显示更新后的候选人列表
            const candidateList = updatedCandidates.map((candidate) => {
                let info = `<@${candidate.userId}>`;
                if (candidate.choiceType === 'second') {
                    info += ' (第二志愿)';
                }
                return info;
            }).join('\n');

            embed.addFields(
                { name: '候选人列表', value: candidateList, inline: false }
            );

            // 保持原有的按钮组件
            await message.edit({
                embeds: [embed],
                components: message.components
            });
        } else {
            // 实名投票：重新生成投票按钮和嵌入消息
            const { createCandidateListEmbed } = require('../utils/messageUtils');
            const embed = createCandidateListEmbed(vote.positionName, updatedCandidates, vote.maxSelections);
            
            // 重新生成投票按钮
            const components = createVotingComponents(election.electionId, vote.positionId, updatedCandidates, vote.maxSelections);

            await message.edit({
                embeds: [embed],
                components: components
            });
        }

        console.log(`Discord投票器消息已更新: ${vote.positionName}`);

    } catch (error) {
        console.error('更新Discord投票器消息时出错:', error);
        throw error;
    }
}

module.exports = {
    createVotingPollsForElection,
    createPositionVotingPoll,
    createVotingComponents,
    handleVotingButton,
    getVotingStatistics,
    hasUserVoted,
    recordVote,
    createPositionAnonymousVotingPoll,
    createAnonymousVotingComponents,
    updateVotingPollCandidates
}; 