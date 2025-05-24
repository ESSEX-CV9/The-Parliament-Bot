// src/services/courtChecker.js
const { getAllCourtVotes, updateCourtVote } = require('../../../core/utils/database');
const { finalizeVote, updateVoteDisplay } = require('./courtVotingSystem');
const { startCourtApplicationChecker } = require('./courtApplicationChecker');
const { getCheckIntervals } = require('../../../core/config/timeconfig');

async function checkCourtVotes(client) {
    try {
        console.log('\n=== 开始检查法庭投票状态 ===');
        const now = new Date();
        const allVotes = await getAllCourtVotes();
        
        let totalChecked = 0;
        let publicUpdated = 0;
        let finalized = 0;
        
        for (const threadId in allVotes) {
            const voteData = allVotes[threadId];
            
            // 跳过已完成的投票
            if (voteData.status !== 'active') continue;
            
            totalChecked++;
            
            const endTime = new Date(voteData.voteEndTime);
            const publicTime = new Date(voteData.publicTime);
            
            // 检查是否需要公开票数
            if (!voteData.isPublic && now >= publicTime) {
                try {
                    // 模拟一个交互对象来更新显示
                    const mockInteraction = {
                        client: client,
                        replied: false,
                        deferred: false
                    };
                    
                    await updateVoteDisplay(mockInteraction, voteData, threadId);
                    await updateCourtVote(threadId, { isPublic: true });
                    publicUpdated++;
                    console.log(`投票 ${voteData.courtId} 票数已公开`);
                } catch (error) {
                    console.error(`公开投票 ${voteData.courtId} 票数时出错:`, error);
                }
            }
            
            // 检查是否投票结束
            if (now >= endTime) {
                try {
                    await finalizeVote(client, voteData);
                    finalized++;
                    console.log(`投票 ${voteData.courtId} 已结束并结算`);
                } catch (error) {
                    console.error(`结算投票 ${voteData.courtId} 时出错:`, error);
                }
            }
        }
        
        console.log(`总检查投票数: ${totalChecked}`);
        console.log(`公开票数: ${publicUpdated}`);
        console.log(`结算投票: ${finalized}`);
        console.log('=== 法庭投票状态检查完成 ===\n');
        
    } catch (error) {
        console.error('检查法庭投票状态时出错:', error);
    }
}

// 启动法庭检查器
function startCourtChecker(client) {
    console.log('启动法庭系统检查器...');
    
    // 启动投票检查器
    console.log('启动法庭投票检查器...');
    
    const intervals = getCheckIntervals();

    // 投票检查间隔
    setInterval(() => {
        checkCourtVotes(client);
    }, intervals.courtVoteCheck);
    
    // 启动申请检查器
    startCourtApplicationChecker(client);
}

module.exports = {
    startCourtChecker,
    checkCourtVotes
};