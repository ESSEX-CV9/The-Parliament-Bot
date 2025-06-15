const { ElectionData, RegistrationData, VoteData } = require('../data/electionDatabase');

/**
 * 计算选举结果
 * @param {string} electionId - 选举ID
 * @returns {object} 选举结果
 */
async function calculateElectionResults(electionId) {
    try {
        // 获取选举信息
        const election = await ElectionData.getById(electionId);
        if (!election) {
            throw new Error('选举不存在');
        }

        // 获取所有投票
        const votes = await VoteData.getByElection(electionId);
        const registrations = await RegistrationData.getByElection(electionId);

        const results = {};

        // 为每个职位计算结果
        for (const [positionId, position] of Object.entries(election.positions)) {
            results[positionId] = await calculatePositionResults(
                positionId, 
                position, 
                votes, 
                registrations
            );
        }

        // 处理第二志愿逻辑
        const finalResults = await processSecondChoiceLogic(results, election.positions, registrations);

        return finalResults;

    } catch (error) {
        console.error('计算选举结果时出错:', error);
        throw error;
    }
}

/**
 * 计算单个职位的结果
 * @param {string} positionId - 职位ID
 * @param {object} position - 职位信息
 * @param {Array} votes - 投票数据
 * @param {Array} registrations - 报名数据
 * @returns {object} 职位结果
 */
async function calculatePositionResults(positionId, position, votes, registrations) {
    // 找到该职位的投票数据
    const positionVote = votes.find(vote => vote.positionId === positionId);
    
    if (!positionVote || !positionVote.votes) {
        return {
            position: position,
            candidates: [],
            winners: [],
            totalVotes: 0
        };
    }

    // 统计每个候选人的票数
    const candidateVotes = {};
    let totalVotes = 0;

    // 初始化候选人票数
    for (const candidate of positionVote.candidates) {
        candidateVotes[candidate.userId] = {
            userId: candidate.userId,
            displayName: candidate.displayName,
            choiceType: candidate.choiceType,
            selfIntroduction: candidate.selfIntroduction,
            votes: 0
        };
    }

    // 计算票数
    for (const [voterId, candidateIds] of Object.entries(positionVote.votes)) {
        if (Array.isArray(candidateIds)) {
            for (const candidateId of candidateIds) {
                if (candidateVotes[candidateId]) {
                    candidateVotes[candidateId].votes++;
                }
            }
            totalVotes++;
        }
    }

    // 转换为数组并按票数排序
    const candidateList = Object.values(candidateVotes)
        .sort((a, b) => b.votes - a.votes);

    // 确定获胜者
    const winners = candidateList.slice(0, position.maxWinners);

    return {
        position: position,
        candidates: candidateList,
        winners: winners,
        totalVotes: totalVotes
    };
}

/**
 * 处理第二志愿逻辑
 * @param {object} preliminaryResults - 初步结果
 * @param {object} positions - 职位配置
 * @param {Array} registrations - 报名数据
 * @returns {object} 最终结果
 */
async function processSecondChoiceLogic(preliminaryResults, positions, registrations) {
    const finalResults = JSON.parse(JSON.stringify(preliminaryResults));
    const winners = new Set(); // 记录已当选的用户

    // 第一轮：处理第一志愿当选者
    for (const [positionId, result] of Object.entries(finalResults)) {
        for (const winner of result.winners) {
            winners.add(winner.userId);
        }
    }

    // 第二轮：处理第二志愿
    for (const [positionId, result] of Object.entries(finalResults)) {
        // 移除已在第一志愿当选的候选人
        result.candidates = result.candidates.filter(candidate => {
            // 如果是第二志愿且已在第一志愿当选，则移除
            if (candidate.choiceType === 'second' && winners.has(candidate.userId)) {
                return false;
            }
            return true;
        });

        // 重新计算获胜者（排除已当选的人）
        const availableCandidates = result.candidates.filter(candidate => 
            !winners.has(candidate.userId)
        );

        // 按票数重新排序并选出获胜者
        const newWinners = availableCandidates
            .sort((a, b) => b.votes - a.votes)
            .slice(0, positions[positionId].maxWinners);

        result.winners = newWinners;

        // 更新获胜者列表
        for (const winner of newWinners) {
            winners.add(winner.userId);
        }
    }

    // 第三轮：为第一志愿落选者在第二志愿中补充机会
    await processSecondChoiceOpportunities(finalResults, positions, registrations, winners);

    return finalResults;
}

/**
 * 为第一志愿落选者在第二志愿中提供机会
 * @param {object} results - 当前结果
 * @param {object} positions - 职位配置
 * @param {Array} registrations - 报名数据
 * @param {Set} winners - 已当选者集合
 */
async function processSecondChoiceOpportunities(results, positions, registrations, winners) {
    // 找出第一志愿落选但有第二志愿的候选人
    const secondChoiceCandidates = registrations.filter(reg => 
        reg.secondChoicePosition && 
        !winners.has(reg.userId)
    );

    for (const candidate of secondChoiceCandidates) {
        const secondChoicePositionId = candidate.secondChoicePosition;
        const secondChoiceResult = results[secondChoicePositionId];
        
        if (!secondChoiceResult) continue;

        // 检查第二志愿职位是否还有空位
        const maxWinners = positions[secondChoicePositionId].maxWinners;
        const currentWinners = secondChoiceResult.winners.length;
        
        if (currentWinners < maxWinners) {
            // 检查该候选人是否在第二志愿的候选人列表中但未当选
            const candidateInSecondChoice = secondChoiceResult.candidates.find(
                c => c.userId === candidate.userId
            );
            
            if (candidateInSecondChoice && !winners.has(candidate.userId)) {
                // 将候选人添加到获胜者列表
                secondChoiceResult.winners.push(candidateInSecondChoice);
                winners.add(candidate.userId);
                
                // 如果达到最大人数就停止
                if (secondChoiceResult.winners.length >= maxWinners) {
                    continue;
                }
            }
        }
    }
}

/**
 * 获取选举统计信息
 * @param {string} electionId - 选举ID
 * @returns {object} 统计信息
 */
async function getElectionStatistics(electionId) {
    try {
        const election = await ElectionData.getById(electionId);
        const registrations = await RegistrationData.getByElection(electionId);
        const votes = await VoteData.getByElection(electionId);

        const stats = {
            election: {
                name: election.name,
                status: election.status,
                positionCount: Object.keys(election.positions).length
            },
            registration: {
                total: registrations.length,
                byPosition: {}
            },
            voting: {
                totalVoters: 0,
                byPosition: {}
            }
        };

        // 统计各职位报名人数
        for (const [positionId, position] of Object.entries(election.positions)) {
            const firstChoiceCount = registrations.filter(
                reg => reg.firstChoicePosition === positionId
            ).length;
            const secondChoiceCount = registrations.filter(
                reg => reg.secondChoicePosition === positionId
            ).length;

            stats.registration.byPosition[positionId] = {
                positionName: position.name,
                firstChoice: firstChoiceCount,
                secondChoice: secondChoiceCount,
                total: firstChoiceCount + secondChoiceCount
            };
        }

        // 统计投票情况
        for (const vote of votes) {
            const voterCount = Object.keys(vote.votes || {}).length;
            stats.voting.byPosition[vote.positionId] = {
                positionName: election.positions[vote.positionId]?.name || '未知职位',
                voterCount: voterCount,
                candidateCount: vote.candidates?.length || 0
            };
            stats.voting.totalVoters = Math.max(stats.voting.totalVoters, voterCount);
        }

        return stats;

    } catch (error) {
        console.error('获取选举统计信息时出错:', error);
        throw error;
    }
}

/**
 * 生成选举报告
 * @param {string} electionId - 选举ID
 * @returns {object} 选举报告
 */
async function generateElectionReport(electionId) {
    try {
        const results = await calculateElectionResults(electionId);
        const statistics = await getElectionStatistics(electionId);
        const election = await ElectionData.getById(electionId);

        return {
            election: {
                id: electionId,
                name: election.name,
                status: election.status,
                schedule: election.schedule
            },
            statistics: statistics,
            results: results,
            generatedAt: new Date().toISOString()
        };

    } catch (error) {
        console.error('生成选举报告时出错:', error);
        throw error;
    }
}

module.exports = {
    calculateElectionResults,
    calculatePositionResults,
    processSecondChoiceLogic,
    getElectionStatistics,
    generateElectionReport
}; 