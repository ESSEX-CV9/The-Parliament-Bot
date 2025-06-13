const fs = require('fs').promises;
const path = require('path');

// 投票数据存储路径
const VOTE_DATA_DIR = path.join(__dirname, '..', 'data');
const VOTE_DATA_FILE = path.join(VOTE_DATA_DIR, 'votes.json');

// 确保数据目录存在
async function ensureDataDir() {
    try {
        await fs.access(VOTE_DATA_DIR);
    } catch {
        await fs.mkdir(VOTE_DATA_DIR, { recursive: true });
    }
}

// 读取投票数据
async function loadVoteData() {
    try {
        await ensureDataDir();
        const data = await fs.readFile(VOTE_DATA_FILE, 'utf8');
        const votes = JSON.parse(data);
        
        // 转换日期字符串为Date对象
        Object.values(votes).forEach(vote => {
            vote.endTime = new Date(vote.endTime);
            vote.createdAt = new Date(vote.createdAt);
        });
        
        return votes;
    } catch (error) {
        if (error.code === 'ENOENT') {
            return {};
        }
        throw error;
    }
}

// 保存投票数据
async function saveAllVoteData(votes) {
    try {
        await ensureDataDir();
        await fs.writeFile(VOTE_DATA_FILE, JSON.stringify(votes, null, 2));
    } catch (error) {
        console.error('保存投票数据失败:', error);
        throw error;
    }
}

// 保存单个投票
async function saveVoteData(voteData) {
    try {
        const allVotes = await loadVoteData();
        allVotes[voteData.voteId] = voteData;
        await saveAllVoteData(allVotes);
    } catch (error) {
        console.error('保存投票失败:', error);
        throw error;
    }
}

// 获取单个投票
async function getVoteData(voteId) {
    try {
        const allVotes = await loadVoteData();
        return allVotes[voteId] || null;
    } catch (error) {
        console.error('获取投票数据失败:', error);
        return null;
    }
}

// 获取所有活跃投票
async function getActiveVotes() {
    try {
        const allVotes = await loadVoteData();
        const now = new Date();
        
        return Object.values(allVotes).filter(vote => vote.endTime > now);
    } catch (error) {
        console.error('获取活跃投票失败:', error);
        return [];
    }
}

// 获取已结束的投票
async function getExpiredVotes() {
    try {
        const allVotes = await loadVoteData();
        const now = new Date();
        
        return Object.values(allVotes).filter(vote => vote.endTime <= now);
    } catch (error) {
        console.error('获取过期投票失败:', error);
        return [];
    }
}

// 删除投票
async function deleteVoteData(voteId) {
    try {
        const allVotes = await loadVoteData();
        delete allVotes[voteId];
        await saveAllVoteData(allVotes);
        return true;
    } catch (error) {
        console.error('删除投票失败:', error);
        return false;
    }
}

// 清理过期投票
async function cleanupExpiredVotes(retentionDays = 7) {
    try {
        const allVotes = await loadVoteData();
        const cutoffDate = new Date(Date.now() - (retentionDays * 24 * 60 * 60 * 1000));
        
        const validVotes = {};
        let cleanedCount = 0;
        
        for (const [voteId, vote] of Object.entries(allVotes)) {
            if (vote.endTime > cutoffDate) {
                validVotes[voteId] = vote;
            } else {
                cleanedCount++;
            }
        }
        
        if (cleanedCount > 0) {
            await saveAllVoteData(validVotes);
            console.log(`已清理 ${cleanedCount} 个过期投票`);
        }
        
        return cleanedCount;
    } catch (error) {
        console.error('清理过期投票失败:', error);
        return 0;
    }
}

// 获取投票统计
async function getVoteStats() {
    try {
        const allVotes = await loadVoteData();
        const now = new Date();
        
        const stats = {
            total: Object.keys(allVotes).length,
            active: 0,
            expired: 0,
            totalVotes: 0
        };
        
        for (const vote of Object.values(allVotes)) {
            if (vote.endTime > now) {
                stats.active++;
            } else {
                stats.expired++;
            }
            
            stats.totalVotes += Object.values(vote.votes).reduce(
                (total, voters) => total + voters.length, 0
            );
        }
        
        return stats;
    } catch (error) {
        console.error('获取投票统计失败:', error);
        return { total: 0, active: 0, expired: 0, totalVotes: 0 };
    }
}

module.exports = {
    saveVoteData,
    getVoteData,
    getActiveVotes,
    getExpiredVotes,
    deleteVoteData,
    cleanupExpiredVotes,
    getVoteStats,
    loadVoteData,
    saveAllVoteData
}; 