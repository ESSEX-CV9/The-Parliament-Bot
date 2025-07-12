/**
 * 并列处理工具模块
 * 处理选举中的并列票数情况和连锁影响分析
 */

/**
 * 候选人状态常量
 */
const CANDIDATE_STATUS = {
    CONFIRMED_WINNER: 'confirmed_winner',      // 确定当选
    TIED_PENDING: 'tied_pending',              // 并列，待处理
    CONDITIONAL_WINNER: 'conditional_winner',   // 条件当选
    POTENTIAL_REPLACEMENT: 'potential_replacement', // 可能递补
    CONFIRMED_LOSER: 'confirmed_loser'         // 确定落选
};

/**
 * 状态配置
 */
const STATUS_CONFIG = {
    [CANDIDATE_STATUS.CONFIRMED_WINNER]: {
        icon: '✅',
        label: '确定当选',
        priority: 1,
        color: '#2ecc71'
    },
    [CANDIDATE_STATUS.TIED_PENDING]: {
        icon: '⚠️',
        label: '并列，待处理',
        priority: 2,
        color: '#f39c12'
    },
    [CANDIDATE_STATUS.CONDITIONAL_WINNER]: {
        icon: '⚡',
        label: '条件当选',
        priority: 3,
        color: '#3498db'
    },
    [CANDIDATE_STATUS.POTENTIAL_REPLACEMENT]: {
        icon: '🔄',
        label: '可能递补',
        priority: 4,
        color: '#9b59b6'
    },
    [CANDIDATE_STATUS.CONFIRMED_LOSER]: {
        icon: '❌',
        label: '确定落选',
        priority: 5,
        color: '#95a5a6'
    }
};

/**
 * 检测边界并列情况
 * @param {Array} candidates - 候选人列表（已排序）
 * @param {number} maxWinners - 最大当选人数
 * @returns {object} 并列分析结果
 */
function detectBoundaryTies(candidates, maxWinners) {
    if (candidates.length === 0 || maxWinners === 0) {
        return { hasTies: false, tieGroups: [] };
    }

    const tieGroups = [];
    let tieGroupId = 1;

    // 寻找在当选边界附近的并列情况
    for (let i = 0; i < candidates.length; i++) {
        const currentCandidate = candidates[i];
        const currentRank = i + 1;
        
        // 找到相同票数和志愿类型的候选人组
        const tieGroup = [currentCandidate];
        let j = i + 1;
        
        while (j < candidates.length && 
               candidates[j].votes === currentCandidate.votes &&
               candidates[j].choiceType === currentCandidate.choiceType) {
            tieGroup.push(candidates[j]);
            j++;
        }
        
        // 只关心跨越当选边界的并列组
        if (tieGroup.length > 1) {
            const groupStartRank = currentRank;
            const groupEndRank = currentRank + tieGroup.length - 1;
            
            // 检查是否跨越当选边界（maxWinners）
            if (groupStartRank <= maxWinners && groupEndRank > maxWinners) {
                tieGroups.push({
                    id: `tie_group_${tieGroupId++}`,
                    candidates: tieGroup,
                    votes: currentCandidate.votes,
                    choiceType: currentCandidate.choiceType,
                    startRank: groupStartRank,
                    endRank: groupEndRank,
                    crossesBoundary: true,
                    slotsInGroup: maxWinners - groupStartRank + 1 // 组内可当选的名额数
                });
            }
        }
        
        // 跳过已处理的候选人
        i = j - 1;
    }

    return {
        hasTies: tieGroups.length > 0,
        tieGroups: tieGroups
    };
}

/**
 * 分析并列对其他职位的连锁影响
 * @param {object} allResults - 所有职位的选举结果
 * @param {Array} registrations - 报名数据
 * @returns {object} 连锁影响分析
 */
function analyzeChainEffects(allResults, registrations) {
    const chainEffects = {
        affectedPositions: new Set(),
        scenarios: {},
        impactedCandidates: new Map()
    };

    // 收集所有并列组
    const allTieGroups = [];
    for (const [positionId, result] of Object.entries(allResults)) {
        if (result.tieAnalysis?.hasTies) {
            result.tieAnalysis.tieGroups.forEach(group => {
                allTieGroups.push({
                    ...group,
                    positionId
                });
            });
        }
    }

    if (allTieGroups.length === 0) {
        return chainEffects;
    }

    // 为每个并列组分析不同的解决方案
    allTieGroups.forEach(tieGroup => {
        const { positionId, candidates } = tieGroup;
        
        // 生成可能的解决方案
        const scenarios = generateTieResolutionScenarios(tieGroup);
        
        scenarios.forEach((scenario, scenarioIndex) => {
            const scenarioKey = `${tieGroup.id}_scenario_${scenarioIndex}`;
            chainEffects.scenarios[scenarioKey] = {
                tieGroupId: tieGroup.id,
                positionId,
                description: scenario.description,
                winners: scenario.winners,
                losers: scenario.losers,
                impacts: analyzeScenarioImpacts(scenario, allResults, registrations)
            };
        });
    });

    return chainEffects;
}

/**
 * 生成并列解决方案
 * @param {object} tieGroup - 并列组
 * @returns {Array} 可能的解决方案
 */
function generateTieResolutionScenarios(tieGroup) {
    const { candidates, slotsInGroup } = tieGroup;
    const scenarios = [];

    // 方案1：每个候选人单独当选的情况
    candidates.forEach((candidate, index) => {
        if (index < slotsInGroup) {
            const winners = [candidate];
            const losers = candidates.filter(c => c.userId !== candidate.userId);
            
            scenarios.push({
                type: 'individual_winner',
                description: `${candidate.displayName}当选，其他人落选`,
                winners,
                losers
            });
        }
    });

    // 方案2：如果可能，所有人都当选（扩招）
    if (candidates.length <= 2) { // 只对小规模并列考虑扩招
        scenarios.push({
            type: 'expand_positions',
            description: '扩招，所有并列候选人都当选',
            winners: candidates,
            losers: []
        });
    }

    return scenarios;
}

/**
 * 分析特定方案的影响
 * @param {object} scenario - 解决方案
 * @param {object} allResults - 所有职位结果
 * @param {Array} registrations - 报名数据
 * @returns {object} 影响分析
 */
function analyzeScenarioImpacts(scenario, allResults, registrations) {
    const impacts = {
        affectedPositions: [],
        candidateChanges: []
    };

    // 分析并列候选人的第二志愿影响
    scenario.winners.forEach(winner => {
        const registration = registrations.find(r => r.userId === winner.userId);
        if (registration?.secondChoicePosition && winner.choiceType === 'first') {
            // 如果第一志愿当选，第二志愿就不再竞争
            const secondPosition = registration.secondChoicePosition;
            impacts.affectedPositions.push({
                positionId: secondPosition,
                effect: `${winner.displayName}不再竞争此职位的第二志愿`
            });

            // 检查该人在第二志愿是否已经被标记为当选，如果是则状态会受影响
            const secondPositionResult = allResults[secondPosition];
            if (secondPositionResult && !secondPositionResult.isVoid) {
                const candidateInSecond = secondPositionResult.candidates.find(c => c.userId === winner.userId);
                if (candidateInSecond && candidateInSecond.isWinner) {
                    impacts.candidateChanges.push({
                        candidateId: winner.userId,
                        positionId: secondPosition,
                        mayLose: true, // 第一志愿当选会导致第二志愿失去资格
                        reason: '第一志愿当选后失去第二志愿资格'
                    });
                }
            }
        }
    });

    scenario.losers.forEach(loser => {
        const registration = registrations.find(r => r.userId === loser.userId);
        if (registration?.secondChoicePosition && loser.choiceType === 'first') {
            // 如果第一志愿落选，可能转到第二志愿
            const secondPosition = registration.secondChoicePosition;
            impacts.affectedPositions.push({
                positionId: secondPosition,
                effect: `${loser.displayName}可能在此职位的第二志愿中当选`
            });

            // 检查该人在第二志愿的当选状态是否会受影响
            const secondPositionResult = allResults[secondPosition];
            if (secondPositionResult && !secondPositionResult.isVoid) {
                const candidateInSecond = secondPositionResult.candidates.find(c => c.userId === loser.userId);
                if (candidateInSecond && candidateInSecond.isWinner) {
                    impacts.candidateChanges.push({
                        candidateId: loser.userId,
                        positionId: secondPosition,
                        mayLose: false, // 不会失去，但状态不确定
                        reason: '第一志愿结果影响第二志愿当选确定性'
                    });
                }
            }
        }
    });

    return impacts;
}

/**
 * 为候选人分配状态
 * @param {object} results - 选举结果
 * @param {object} chainEffects - 连锁影响分析
 * @returns {object} 带状态的结果
 */
function assignCandidateStatuses(results, chainEffects) {
    const statusResults = JSON.parse(JSON.stringify(results));

    for (const [positionId, result] of Object.entries(statusResults)) {
        if (result.isVoid) continue;

        result.candidates.forEach(candidate => {
            // 初始化状态信息
            candidate.statusInfo = {
                status: CANDIDATE_STATUS.CONFIRMED_LOSER,
                tieGroup: null,
                conditions: [],
                notes: ''
            };

            // 检查是否在并列组中
            if (result.tieAnalysis?.hasTies) {
                const tieGroup = result.tieAnalysis.tieGroups.find(group => 
                    group.candidates.some(c => c.userId === candidate.userId)
                );
                
                if (tieGroup) {
                    candidate.statusInfo.status = CANDIDATE_STATUS.TIED_PENDING;
                    candidate.statusInfo.tieGroup = tieGroup.id;
                    candidate.statusInfo.notes = `与${tieGroup.candidates.length - 1}人并列第${tieGroup.startRank}名`;
                    return;
                }
            }

            // 检查是否确定当选
            if (candidate.isWinner) {
                // 检查是否受其他并列影响
                const isAffected = isAffectedByOtherTies(candidate, chainEffects, positionId);
                if (isAffected) {
                    candidate.statusInfo.status = CANDIDATE_STATUS.CONDITIONAL_WINNER;
                    candidate.statusInfo.notes = '当选状态受其他职位并列影响';
                } else {
                    candidate.statusInfo.status = CANDIDATE_STATUS.CONFIRMED_WINNER;
                }
                return;
            }

            // 检查是否有递补机会
            const hasReplacementChance = checkReplacementChance(candidate, result, chainEffects, positionId);
            if (hasReplacementChance) {
                candidate.statusInfo.status = CANDIDATE_STATUS.POTENTIAL_REPLACEMENT;
                candidate.statusInfo.notes = hasReplacementChance.reason;
            }
        });
    }

    return statusResults;
}

/**
 * 检查候选人是否受其他并列影响
 * @param {object} candidate - 候选人
 * @param {object} chainEffects - 连锁影响
 * @param {string} currentPositionId - 当前检查的职位ID
 * @returns {boolean} 是否受影响
 */
function isAffectedByOtherTies(candidate, chainEffects, currentPositionId) {
    // 检查候选人在当前职位是否受其他职位并列影响
    for (const scenario of Object.values(chainEffects.scenarios)) {
        // 只关心其他职位的并列对当前职位的影响
        if (scenario.positionId !== currentPositionId) {
            if (scenario.impacts.candidateChanges.some(change => 
                change.candidateId === candidate.userId && 
                change.positionId === currentPositionId
            )) {
                return true;
            }
        }
    }
    return false;
}

/**
 * 检查候选人是否有递补机会
 * @param {object} candidate - 候选人
 * @param {object} positionResult - 职位结果
 * @param {object} chainEffects - 连锁影响
 * @param {string} positionId - 职位ID
 * @returns {object|null} 递补机会信息
 */
function checkReplacementChance(candidate, positionResult, chainEffects, positionId) {
    // 检查是否是当选边界附近的候选人
    const candidateIndex = positionResult.candidates.findIndex(c => c.userId === candidate.userId);
    const winnerCount = positionResult.candidates.filter(c => c.isWinner).length;
    
    // 检查是否因为其他职位的并列影响而有递补机会
    for (const scenario of Object.values(chainEffects.scenarios)) {
        const relevantChange = scenario.impacts.candidateChanges.find(change => 
            change.positionId === positionId && 
            change.mayLose === true
        );
        if (relevantChange && candidateIndex < winnerCount + 3) {
            return {
                reason: '其他职位并列处理可能产生递补机会'
            };
        }
    }
    
    // 如果是紧跟在当选者后面的候选人，可能有递补机会
    if (candidateIndex >= winnerCount && candidateIndex <= winnerCount + 2) {
        return {
            reason: '排名靠前，如有并列处理或当选者退出可能递补'
        };
    }

    return null;
}

/**
 * 分析跨职位依赖关系
 * @param {object} allResults - 所有职位的选举结果
 * @param {Array} registrations - 报名数据
 * @returns {object} 依赖关系分析结果
 */
function analyzeCrossPositionDependencies(allResults, registrations) {
    const dependencies = {
        conditionalCandidates: new Map(), // 条件候选人
        affectedPositions: new Set(),
        dependencyChains: []
    };

    // 找出所有有第一志愿在其他职位并列的候选人
    for (const [positionId, result] of Object.entries(allResults)) {
        if (result.isVoid) continue;

        result.candidates.forEach(candidate => {
            if (candidate.choiceType === 'second') {
                // 这是第二志愿候选人，需要检查其第一志愿状态
                const firstChoicePosition = findFirstChoicePosition(candidate.userId, registrations);
                if (firstChoicePosition && allResults[firstChoicePosition]) {
                    const firstChoiceResult = allResults[firstChoicePosition];
                    const firstChoiceCandidate = firstChoiceResult.candidates.find(c => c.userId === candidate.userId);
                    
                    if (firstChoiceCandidate && isInTieOrBoundary(firstChoiceCandidate, firstChoiceResult)) {
                        // 这个候选人在第一志愿职位存在不确定性
                        dependencies.conditionalCandidates.set(candidate.userId, {
                            firstChoicePosition,
                            secondChoicePosition: positionId,
                            firstChoiceRank: getEffectiveRank(firstChoiceCandidate, firstChoiceResult),
                            secondChoiceRank: getEffectiveRank(candidate, result),
                            status: 'conditional'
                        });
                        
                        dependencies.affectedPositions.add(positionId);
                        dependencies.affectedPositions.add(firstChoicePosition);
                    }
                }
            }
        });
    }

    return dependencies;
}

/**
 * 重新计算考虑跨职位依赖的候选人状态
 * @param {object} allResults - 所有职位的选举结果
 * @param {object} dependencies - 依赖关系分析
 * @returns {object} 更新后的结果
 */
function recalculateWithDependencies(allResults, dependencies) {
    const updatedResults = JSON.parse(JSON.stringify(allResults));

    // 为每个职位重新计算状态
    for (const [positionId, result] of Object.entries(updatedResults)) {
        if (result.isVoid) continue;

        const position = result.position;
        const maxWinners = position.maxWinners;

        // 重新分析当选情况
        result.candidates.forEach(candidate => {
            const newStatus = calculateAdvancedStatus(
                candidate, 
                result, 
                maxWinners,
                dependencies,
                positionId,
                updatedResults
            );
            
            candidate.statusInfo = newStatus;
        });
    }

    return updatedResults;
}

/**
 * 计算高级候选人状态（考虑跨职位依赖）
 */
function calculateAdvancedStatus(candidate, positionResult, maxWinners, dependencies, positionId, allResults) {
    const rank = getEffectiveRank(candidate, positionResult);
    const isConditional = dependencies.conditionalCandidates.has(candidate.userId);
    
    // 确定当选：排名在前且无依赖问题
    if (rank <= maxWinners && !hasBlockingDependencies(candidate, dependencies, allResults)) {
        return {
            status: CANDIDATE_STATUS.CONFIRMED_WINNER,
            notes: null
        };
    }
    
    // 条件当选：取决于其他候选人在其他职位的结果
    if (rank <= maxWinners && hasBlockingDependencies(candidate, dependencies, allResults)) {
        const blockingInfo = getBlockingInfo(candidate, dependencies, allResults);
        return {
            status: CANDIDATE_STATUS.CONDITIONAL_WINNER,
            notes: `取决于${blockingInfo}的结果`
        };
    }
    
    // 并列待处理
    if (isInTieAtBoundary(candidate, positionResult, maxWinners)) {
        return {
            status: CANDIDATE_STATUS.TIED_PENDING,
            notes: `与${getTieGroupSize(candidate, positionResult) - 1}人并列第${rank}名`
        };
    }
    
    // 可能递补
    if (rank === maxWinners + 1 || hasReplacementChance(candidate, dependencies, allResults)) {
        return {
            status: CANDIDATE_STATUS.POTENTIAL_REPLACEMENT,
            notes: '排名靠前，如有并列处理或当选者退出可能递补'
        };
    }
    
    // 确定落选
    return {
        status: CANDIDATE_STATUS.CONFIRMED_LOSER,
        notes: null
    };
}

/**
 * 查找候选人的第一志愿职位
 * @param {string} userId - 用户ID
 * @param {Array} registrations - 报名数据
 * @returns {string|null} 第一志愿职位ID
 */
function findFirstChoicePosition(userId, registrations) {
    const registration = registrations.find(reg => reg.userId === userId);
    return registration ? registration.firstChoicePosition : null;
}

/**
 * 检查候选人是否在并列或边界状态
 * @param {object} candidate - 候选人
 * @param {object} positionResult - 职位结果
 * @returns {boolean} 是否在并列或边界状态
 */
function isInTieOrBoundary(candidate, positionResult) {
    const maxWinners = positionResult.position.maxWinners;
    const rank = getEffectiveRank(candidate, positionResult);
    
    // 检查是否在当选边界附近
    if (rank <= maxWinners + 2) {
        // 检查是否有并列情况
        const sameVoteCandidates = positionResult.candidates.filter(c => 
            c.votes === candidate.votes && c.choiceType === candidate.choiceType
        );
        return sameVoteCandidates.length > 1;
    }
    
    return false;
}

/**
 * 获取候选人的有效排名
 * @param {object} candidate - 候选人
 * @param {object} positionResult - 职位结果
 * @returns {number} 有效排名
 */
function getEffectiveRank(candidate, positionResult) {
    const sortedCandidates = positionResult.candidates.slice().sort((a, b) => {
        if (b.votes !== a.votes) {
            return b.votes - a.votes;
        }
        if (a.choiceType === 'first' && b.choiceType === 'second') {
            return -1;
        }
        if (a.choiceType === 'second' && b.choiceType === 'first') {
            return 1;
        }
        return 0;
    });
    
    const index = sortedCandidates.findIndex(c => c.userId === candidate.userId);
    return index + 1;
}

/**
 * 检查候选人是否有阻塞性依赖
 * @param {object} candidate - 候选人
 * @param {object} dependencies - 依赖关系
 * @param {object} allResults - 所有结果
 * @returns {boolean} 是否有阻塞性依赖
 */
function hasBlockingDependencies(candidate, dependencies, allResults) {
    // 检查是否有其他候选人的状态会影响当前候选人
    if (candidate.choiceType === 'first') {
        // 第一志愿候选人，检查是否有第二志愿候选人可能影响他
        return false; // 简化处理，第一志愿通常不受阻塞
    } else {
        // 第二志愿候选人，检查第一志愿是否确定
        const dependency = dependencies.conditionalCandidates.get(candidate.userId);
        return dependency ? true : false;
    }
}

/**
 * 获取阻塞信息
 * @param {object} candidate - 候选人
 * @param {object} dependencies - 依赖关系
 * @param {object} allResults - 所有结果
 * @returns {string} 阻塞信息描述
 */
function getBlockingInfo(candidate, dependencies, allResults) {
    const dependency = dependencies.conditionalCandidates.get(candidate.userId);
    if (dependency) {
        return `在${dependency.firstChoicePosition}的结果`;
    }
    return '其他职位的并列结果';
}

/**
 * 检查是否在边界并列
 * @param {object} candidate - 候选人
 * @param {object} positionResult - 职位结果
 * @param {number} maxWinners - 最大当选人数
 * @returns {boolean} 是否在边界并列
 */
function isInTieAtBoundary(candidate, positionResult, maxWinners) {
    const rank = getEffectiveRank(candidate, positionResult);
    const sameVoteCandidates = positionResult.candidates.filter(c => 
        c.votes === candidate.votes && c.choiceType === candidate.choiceType
    );
    
    return sameVoteCandidates.length > 1 && 
           rank <= maxWinners + 1 && 
           rank >= maxWinners - 1;
}

/**
 * 获取并列组大小
 * @param {object} candidate - 候选人
 * @param {object} positionResult - 职位结果
 * @returns {number} 并列组大小
 */
function getTieGroupSize(candidate, positionResult) {
    const sameVoteCandidates = positionResult.candidates.filter(c => 
        c.votes === candidate.votes && c.choiceType === candidate.choiceType
    );
    return sameVoteCandidates.length;
}

/**
 * 检查是否有递补机会
 * @param {object} candidate - 候选人
 * @param {object} dependencies - 依赖关系
 * @param {object} allResults - 所有结果
 * @returns {boolean} 是否有递补机会
 */
function hasReplacementChance(candidate, dependencies, allResults) {
    // 检查是否受其他职位并列影响而有递补机会
    return dependencies.conditionalCandidates.has(candidate.userId) ||
           dependencies.affectedPositions.size > 0;
}

module.exports = {
    CANDIDATE_STATUS,
    STATUS_CONFIG,
    detectBoundaryTies,
    analyzeChainEffects,
    assignCandidateStatuses,
    generateTieResolutionScenarios,
    analyzeCrossPositionDependencies,
    recalculateWithDependencies,
    calculateAdvancedStatus,
    findFirstChoicePosition,
    isInTieOrBoundary,
    getEffectiveRank,
    hasBlockingDependencies,
    getBlockingInfo,
    isInTieAtBoundary,
    getTieGroupSize,
    hasReplacementChance
}; 