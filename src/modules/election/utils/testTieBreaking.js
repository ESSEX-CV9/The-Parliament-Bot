/**
 * 并列处理功能测试
 * 用于验证并列检测和状态分配是否正常工作
 */

const { detectBoundaryTies, assignCandidateStatuses, CANDIDATE_STATUS } = require('./tieBreakingUtils');

/**
 * 测试边界并列检测
 */
function testBoundaryTieDetection() {
    console.log('=== 测试边界并列检测 ===');
    
    // 测试用例1：有并列的情况
    const candidates1 = [
        { userId: '1', displayName: '候选人A', votes: 5, choiceType: 'first' },
        { userId: '2', displayName: '候选人B', votes: 4, choiceType: 'first' },
        { userId: '3', displayName: '候选人C', votes: 3, choiceType: 'first' },
        { userId: '4', displayName: '候选人D', votes: 3, choiceType: 'first' }, // 与C并列
        { userId: '5', displayName: '候选人E', votes: 2, choiceType: 'first' }
    ];
    
    const result1 = detectBoundaryTies(candidates1, 4); // 招4人，第3、4名并列
    console.log('测试用例1 - 第3、4名并列:', result1);
    
    // 测试用例2：无并列的情况
    const candidates2 = [
        { userId: '1', displayName: '候选人A', votes: 5, choiceType: 'first' },
        { userId: '2', displayName: '候选人B', votes: 4, choiceType: 'first' },
        { userId: '3', displayName: '候选人C', votes: 3, choiceType: 'first' },
        { userId: '4', displayName: '候选人D', votes: 2, choiceType: 'first' }
    ];
    
    const result2 = detectBoundaryTies(candidates2, 4);
    console.log('测试用例2 - 无并列:', result2);
    
    // 测试用例3：边界外并列（不影响当选）
    const candidates3 = [
        { userId: '1', displayName: '候选人A', votes: 5, choiceType: 'first' },
        { userId: '2', displayName: '候选人B', votes: 4, choiceType: 'first' },
        { userId: '3', displayName: '候选人C', votes: 3, choiceType: 'first' },
        { userId: '4', displayName: '候选人D', votes: 2, choiceType: 'first' },
        { userId: '5', displayName: '候选人E', votes: 1, choiceType: 'first' },
        { userId: '6', displayName: '候选人F', votes: 1, choiceType: 'first' } // 与E并列，但都不当选
    ];
    
    const result3 = detectBoundaryTies(candidates3, 4);
    console.log('测试用例3 - 边界外并列:', result3);
    
    console.log('');
}

/**
 * 测试状态分配
 */
function testStatusAssignment() {
    console.log('=== 测试状态分配 ===');
    
    // 模拟选举结果
    const mockResults = {
        'position1': {
            position: { name: '职位A', maxWinners: 2 },
            candidates: [
                { userId: '1', displayName: '候选人A', votes: 5, isWinner: true, choiceType: 'first' },
                { userId: '2', displayName: '候选人B', votes: 3, isWinner: false, choiceType: 'first' },
                { userId: '3', displayName: '候选人C', votes: 3, isWinner: false, choiceType: 'first' }
            ],
            tieAnalysis: {
                hasTies: true,
                tieGroups: [{
                    id: 'tie_group_1',
                    candidates: [
                        { userId: '2', displayName: '候选人B', votes: 3, choiceType: 'first' },
                        { userId: '3', displayName: '候选人C', votes: 3, choiceType: 'first' }
                    ],
                    votes: 3,
                    choiceType: 'first',
                    startRank: 2,
                    endRank: 3,
                    crossesBoundary: true,
                    slotsInGroup: 1
                }]
            },
            isVoid: false
        }
    };
    
    const mockChainEffects = {
        scenarios: {},
        affectedPositions: new Set(),
        impactedCandidates: new Map()
    };
    
    const resultWithStatus = assignCandidateStatuses(mockResults, mockChainEffects);
    
    console.log('状态分配结果:');
    for (const [positionId, result] of Object.entries(resultWithStatus)) {
        console.log(`${result.position.name}:`);
        result.candidates.forEach(candidate => {
            console.log(`  ${candidate.displayName}: ${candidate.statusInfo?.status || 'unknown'} - ${candidate.statusInfo?.notes || '无备注'}`);
        });
    }
    
    console.log('');
}

/**
 * 运行所有测试
 */
function runTests() {
    console.log('开始并列处理功能测试...\n');
    
    try {
        testBoundaryTieDetection();
        testStatusAssignment();
        
        console.log('✅ 所有测试完成！');
    } catch (error) {
        console.error('❌ 测试过程中出错:', error);
    }
}

// 如果直接运行此文件，执行测试
if (require.main === module) {
    runTests();
}

module.exports = {
    testBoundaryTieDetection,
    testStatusAssignment,
    runTests
}; 