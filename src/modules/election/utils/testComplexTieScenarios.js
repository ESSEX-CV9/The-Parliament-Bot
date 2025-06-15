/**
 * 复杂并列场景测试
 * 测试第一志愿并列且第二志愿高票当选的情况
 */

const { 
    detectBoundaryTies, 
    analyzeChainEffects, 
    assignCandidateStatuses, 
    CANDIDATE_STATUS 
} = require('./tieBreakingUtils');

/**
 * 测试复杂并列场景：
 * - 候选人A在职位1第一志愿并列，在职位2第二志愿高票当选
 * - 并列处理结果会影响A在职位2的状态
 */
function testComplexTieScenario() {
    console.log('=== 测试复杂并列场景 ===');
    
    // 模拟报名数据
    const registrations = [
        { userId: 'userA', firstChoicePosition: 'pos1', secondChoicePosition: 'pos2' },
        { userId: 'userB', firstChoicePosition: 'pos1', secondChoicePosition: null },
        { userId: 'userC', firstChoicePosition: 'pos2', secondChoicePosition: null },
        { userId: 'userD', firstChoicePosition: 'pos2', secondChoicePosition: null }
    ];
    
    // 模拟选举结果
    const mockResults = {
        'pos1': {
            position: { name: '职位1', maxWinners: 1 },
            candidates: [
                { userId: 'userA', displayName: '候选人A', votes: 3, isWinner: false, choiceType: 'first' },
                { userId: 'userB', displayName: '候选人B', votes: 3, isWinner: false, choiceType: 'first' } // 与A并列
            ],
            tieAnalysis: {
                hasTies: true,
                tieGroups: [{
                    id: 'tie_group_1',
                    candidates: [
                        { userId: 'userA', displayName: '候选人A', votes: 3, choiceType: 'first' },
                        { userId: 'userB', displayName: '候选人B', votes: 3, choiceType: 'first' }
                    ],
                    votes: 3,
                    choiceType: 'first',
                    startRank: 1,
                    endRank: 2,
                    crossesBoundary: true,
                    slotsInGroup: 1
                }]
            },
            isVoid: false
        },
        'pos2': {
            position: { name: '职位2', maxWinners: 2 },
            candidates: [
                { userId: 'userC', displayName: '候选人C', votes: 5, isWinner: true, choiceType: 'first' },
                { userId: 'userA', displayName: '候选人A', votes: 4, isWinner: true, choiceType: 'second' }, // A在第二志愿高票当选
                { userId: 'userD', displayName: '候选人D', votes: 2, isWinner: false, choiceType: 'first' }
            ],
            tieAnalysis: { hasTies: false, tieGroups: [] },
            isVoid: false
        }
    };
    
    console.log('场景描述：');
    console.log('- 候选人A：第一志愿职位1(3票，与B并列)，第二志愿职位2(4票，已当选)');
    console.log('- 候选人B：第一志愿职位1(3票，与A并列)');
    console.log('- 职位1招1人，A和B并列第1名');
    console.log('- 职位2招2人，A第二志愿高票当选');
    console.log('');
    
    // 分析连锁影响
    const chainEffects = analyzeChainEffects(mockResults, registrations);
    console.log('连锁影响分析：');
    console.log(JSON.stringify(chainEffects.scenarios, null, 2));
    
    // 分配候选人状态
    const finalResults = assignCandidateStatuses(mockResults, chainEffects);
    
    console.log('最终状态结果：');
    for (const [positionId, result] of Object.entries(finalResults)) {
        console.log(`${result.position.name}:`);
        result.candidates.forEach(candidate => {
            const status = candidate.statusInfo?.status || 'unknown';
            const notes = candidate.statusInfo?.notes || '无备注';
            console.log(`  ${candidate.displayName}: ${status} - ${notes}`);
        });
        console.log('');
    }
    
    // 验证关键点
    const userAInPos1 = finalResults.pos1.candidates.find(c => c.userId === 'userA');
    const userAInPos2 = finalResults.pos2.candidates.find(c => c.userId === 'userA');
    
    console.log('关键验证：');
    console.log(`候选人A在职位1状态: ${userAInPos1?.statusInfo?.status}`);
    console.log(`候选人A在职位2状态: ${userAInPos2?.statusInfo?.status}`);
    
    // 期望结果
    const expectedAInPos1 = CANDIDATE_STATUS.TIED_PENDING; // 第一志愿并列
    const expectedAInPos2 = CANDIDATE_STATUS.CONDITIONAL_WINNER; // 第二志愿条件当选
    
    console.log('');
    console.log('期望 vs 实际：');
    console.log(`A在职位1 - 期望: ${expectedAInPos1}, 实际: ${userAInPos1?.statusInfo?.status}`);
    console.log(`A在职位2 - 期望: ${expectedAInPos2}, 实际: ${userAInPos2?.statusInfo?.status}`);
    
    const isCorrect = userAInPos1?.statusInfo?.status === expectedAInPos1 && 
                     userAInPos2?.statusInfo?.status === expectedAInPos2;
    
    console.log(isCorrect ? '✅ 测试通过' : '❌ 测试失败');
    console.log('');
}

/**
 * 运行测试
 */
function runComplexTests() {
    console.log('开始复杂并列场景测试...\n');
    
    try {
        testComplexTieScenario();
        console.log('✅ 复杂场景测试完成！');
    } catch (error) {
        console.error('❌ 测试过程中出错:', error);
        console.error(error.stack);
    }
}

// 如果直接运行此文件，执行测试
if (require.main === module) {
    runComplexTests();
}

module.exports = {
    testComplexTieScenario,
    runComplexTests
}; 