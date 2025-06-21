const { ElectionData, VoteData } = require('../data/electionDatabase');
const { logVoteRemoval } = require('../utils/voteLogger');

/**
 * 投票管理服务
 */
class VoteManagementService {
    /**
     * 清除用户在特定投票中的投票
     * @param {string} voteId - 投票ID
     * @param {string} userId - 用户ID
     * @param {object} operator - 操作者信息
     * @param {string} reason - 清除原因
     * @returns {object} 操作结果
     */
    async clearUserVote(voteId, userId, operator, reason = null) {
        try {
            // 获取投票信息
            const vote = await VoteData.getById(voteId);
            if (!vote) {
                throw new Error('投票不存在');
            }

            // 获取选举信息
            const election = await ElectionData.getById(vote.electionId);
            if (!election) {
                throw new Error('选举不存在');
            }

            // 验证选举状态
            if (!this.canModifyVotes(election.status)) {
                throw new Error(`选举状态为 ${election.status}，不允许清除投票`);
            }

            // 检查用户是否已投票
            const hasVoted = await VoteData.hasUserVoted(voteId, userId);
            if (!hasVoted) {
                throw new Error('该用户未在此投票中投票');
            }

            // 获取投票详情用于日志记录
            const userVotes = await VoteData.getUserVotesInElection(election.electionId, userId);
            const targetVote = userVotes.find(v => v.voteId === voteId);

            // 执行清除操作
            const removedVote = await VoteData.removeUserVote(voteId, userId);

            // 获取目标用户信息
            let targetUserTag = `<@${userId}>`;
            try {
                const targetUser = await operator.guild.members.fetch(userId);
                if (targetUser && targetUser.user) {
                    targetUserTag = targetUser.user.tag;
                }
            } catch (error) {
                console.log('无法获取目标用户信息，使用用户ID');
            }

            // 记录日志
            await logVoteRemoval({
                operator: {
                    id: operator.id,
                    tag: operator.user.tag
                },
                targetUser: {
                    id: userId,
                    tag: targetUserTag
                },
                election: {
                    electionId: election.electionId,
                    name: election.name
                },
                removedVotes: targetVote ? [targetVote] : [],
                reason: reason,
                success: true
            });

            return {
                success: true,
                message: `已成功清除用户 <@${userId}> 在 ${vote.positionName} 中的投票`,
                data: {
                    voteId: voteId,
                    positionName: vote.positionName,
                    removedCandidates: targetVote ? targetVote.candidates : []
                }
            };

        } catch (error) {
            console.error('清除用户投票时出错:', error);
            
            // 记录失败日志
            try {
                await logVoteRemoval({
                    operator: {
                        id: operator.id,
                        tag: operator.user.tag
                    },
                    targetUser: {
                        id: userId,
                        tag: `<@${userId}>`
                    },
                    election: {
                        electionId: 'unknown',
                        name: 'unknown'
                    },
                    removedVotes: [],
                    reason: reason,
                    success: false
                });
            } catch (logError) {
                console.error('记录失败日志时出错:', logError);
            }

            return {
                success: false,
                message: `清除投票失败: ${error.message}`,
                error: error.message
            };
        }
    }

    /**
     * 清除用户在选举中的所有投票
     * @param {string} electionId - 选举ID
     * @param {string} userId - 用户ID
     * @param {object} operator - 操作者信息
     * @param {string} reason - 清除原因
     * @returns {object} 操作结果
     */
    async clearUserVotesInElection(electionId, userId, operator, reason = null) {
        try {
            // 获取选举信息
            const election = await ElectionData.getById(electionId);
            if (!election) {
                throw new Error('选举不存在');
            }

            // 验证选举状态
            if (!this.canModifyVotes(election.status)) {
                throw new Error(`选举状态为 ${election.status}，不允许清除投票`);
            }

            // 获取用户在该选举中的所有投票
            const userVotes = await VoteData.getUserVotesInElection(electionId, userId);
            
            if (userVotes.length === 0) {
                throw new Error('该用户未在此选举中投票');
            }

            // 执行清除操作
            const removedVotes = await VoteData.removeUserVotesFromElection(electionId, userId);

            // 获取目标用户信息
            let targetUserTag = `<@${userId}>`;
            try {
                const targetUser = await operator.guild.members.fetch(userId);
                if (targetUser && targetUser.user) {
                    targetUserTag = targetUser.user.tag;
                }
            } catch (error) {
                console.log('无法获取目标用户信息，使用用户ID');
            }

            // 记录日志
            await logVoteRemoval({
                operator: {
                    id: operator.id,
                    tag: operator.user.tag
                },
                targetUser: {
                    id: userId,
                    tag: targetUserTag
                },
                election: {
                    electionId: election.electionId,
                    name: election.name
                },
                removedVotes: removedVotes,
                reason: reason,
                success: true
            });

            return {
                success: true,
                message: `已成功清除用户 <@${userId}> 在 ${election.name} 中的所有投票`,
                data: {
                    electionId: electionId,
                    electionName: election.name,
                    removedVotesCount: removedVotes.length,
                    removedVotes: removedVotes
                }
            };

        } catch (error) {
            console.error('清除用户在选举中的投票时出错:', error);
            
            // 记录失败日志
            try {
                await logVoteRemoval({
                    operator: {
                        id: operator.id,
                        tag: operator.user.tag
                    },
                    targetUser: {
                        id: userId,
                        tag: `<@${userId}>`
                    },
                    election: {
                        electionId: electionId || 'unknown',
                        name: 'unknown'
                    },
                    removedVotes: [],
                    reason: reason,
                    success: false
                });
            } catch (logError) {
                console.error('记录失败日志时出错:', logError);
            }

            return {
                success: false,
                message: `清除投票失败: ${error.message}`,
                error: error.message
            };
        }
    }

    /**
     * 获取用户在选举中的投票信息
     * @param {string} electionId - 选举ID
     * @param {string} userId - 用户ID
     * @returns {object} 投票信息
     */
    async getUserVotingInfo(electionId, userId) {
        try {
            const election = await ElectionData.getById(electionId);
            if (!election) {
                throw new Error('选举不存在');
            }

            const userVotes = await VoteData.getUserVotesInElection(electionId, userId);
            
            return {
                success: true,
                data: {
                    electionId: electionId,
                    electionName: election.name,
                    electionStatus: election.status,
                    votesCount: userVotes.length,
                    votes: userVotes
                }
            };

        } catch (error) {
            console.error('获取用户投票信息时出错:', error);
            return {
                success: false,
                message: `获取投票信息失败: ${error.message}`,
                error: error.message
            };
        }
    }

    /**
     * 检查是否可以修改投票
     * @param {string} electionStatus - 选举状态
     * @returns {boolean} 是否可以修改
     */
    canModifyVotes(electionStatus) {
        // 只有在投票阶段才允许清除投票
        return electionStatus === 'voting';
    }

    /**
     * 获取选举的所有投票统计
     * @param {string} electionId - 选举ID
     * @returns {object} 投票统计
     */
    async getElectionVotingStatistics(electionId) {
        try {
            const election = await ElectionData.getById(electionId);
            if (!election) {
                throw new Error('选举不存在');
            }

            const votes = await VoteData.getByElection(electionId);
            
            const statistics = {
                electionId: electionId,
                electionName: election.name,
                electionStatus: election.status,
                totalPositions: votes.length,
                positions: []
            };

            for (const vote of votes) {
                const voterCount = Object.keys(vote.votes || {}).length;
                statistics.positions.push({
                    positionId: vote.positionId,
                    positionName: vote.positionName,
                    voteId: vote.voteId,
                    voterCount: voterCount,
                    candidateCount: vote.candidates.length
                });
            }

            return {
                success: true,
                data: statistics
            };

        } catch (error) {
            console.error('获取选举投票统计时出错:', error);
            return {
                success: false,
                message: `获取统计失败: ${error.message}`,
                error: error.message
            };
        }
    }
}

module.exports = VoteManagementService; 