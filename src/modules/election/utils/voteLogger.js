const fs = require('fs').promises;
const path = require('path');

// 日志文件路径
const LOGS_DIR = path.join(__dirname, '..', 'logs');
const VOTE_REMOVAL_LOG_FILE = path.join(LOGS_DIR, 'vote_removal_logs.txt');

// 确保日志目录存在
async function ensureLogDirectory() {
    try {
        await fs.access(LOGS_DIR);
    } catch {
        await fs.mkdir(LOGS_DIR, { recursive: true });
    }
}

/**
 * 记录投票清除操作日志
 * @param {object} logData - 日志数据
 */
async function logVoteRemoval(logData) {
    try {
        await ensureLogDirectory();
        
        const timestamp = new Date().toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });

        const logEntry = formatLogEntry(timestamp, logData);
        
        // 追加到日志文件
        await fs.appendFile(VOTE_REMOVAL_LOG_FILE, logEntry + '\n', 'utf8');
        
        console.log(`投票清除日志已记录: ${logData.targetUser.tag} 在 ${logData.election.name} 中的投票`);
        
    } catch (error) {
        console.error('记录投票清除日志时出错:', error);
        // 即使日志记录失败，也不要影响主要操作
    }
}

/**
 * 格式化日志条目
 * @param {string} timestamp - 时间戳
 * @param {object} logData - 日志数据
 * @returns {string} 格式化的日志条目
 */
function formatLogEntry(timestamp, logData) {
    const {
        operator,
        targetUser,
        election,
        removedVotes,
        reason,
        success
    } = logData;

    let logEntry = `[${timestamp}] 清除投票操作\n`;
    logEntry += `操作者: ${operator.tag} (${operator.id})\n`;
    logEntry += `目标用户: ${targetUser.tag} (${targetUser.id})\n`;
    logEntry += `选举: ${election.name} (${election.electionId})\n`;
    
    if (removedVotes && removedVotes.length > 0) {
        logEntry += `清除的投票:\n`;
        for (const vote of removedVotes) {
            logEntry += `  • ${vote.positionName} (${vote.voteId}): `;
            const candidateNames = vote.candidates.map(c => c.displayName).join(', ');
            logEntry += `[${candidateNames}]\n`;
        }
    } else {
        logEntry += `清除的投票: 无\n`;
    }
    
    if (reason) {
        logEntry += `操作原因: ${reason}\n`;
    }
    
    logEntry += `结果: ${success ? '成功' : '失败'}\n`;
    logEntry += `${'='.repeat(60)}`;
    
    return logEntry;
}

/**
 * 读取投票清除日志
 * @param {number} lines - 读取的行数，默认100行
 * @returns {string} 日志内容
 */
async function readVoteRemovalLogs(lines = 100) {
    try {
        await ensureLogDirectory();
        
        // 检查文件是否存在
        try {
            await fs.access(VOTE_REMOVAL_LOG_FILE);
        } catch {
            return '暂无投票清除日志';
        }
        
        const content = await fs.readFile(VOTE_REMOVAL_LOG_FILE, 'utf8');
        const allLines = content.split('\n');
        
        // 获取最后指定行数
        const recentLines = allLines.slice(-lines).join('\n');
        
        return recentLines || '暂无投票清除日志';
        
    } catch (error) {
        console.error('读取投票清除日志时出错:', error);
        return '读取日志失败';
    }
}

/**
 * 清理旧日志（保留最近30天）
 */
async function cleanupOldLogs() {
    try {
        await ensureLogDirectory();
        
        // 检查文件是否存在
        try {
            await fs.access(VOTE_REMOVAL_LOG_FILE);
        } catch {
            return; // 文件不存在，无需清理
        }
        
        const content = await fs.readFile(VOTE_REMOVAL_LOG_FILE, 'utf8');
        const lines = content.split('\n');
        
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        
        // 过滤出30天内的日志
        const recentLines = lines.filter(line => {
            if (!line.startsWith('[')) return true; // 保留非时间戳行
            
            try {
                const timestampMatch = line.match(/^\[([^\]]+)\]/);
                if (!timestampMatch) return true;
                
                const logDate = new Date(timestampMatch[1].replace(/(\d{4})\/(\d{2})\/(\d{2})/, '$1-$2-$3'));
                return logDate >= thirtyDaysAgo;
            } catch {
                return true; // 如果解析失败，保留该行
            }
        });
        
        // 如果有变化，写回文件
        if (recentLines.length < lines.length) {
            await fs.writeFile(VOTE_REMOVAL_LOG_FILE, recentLines.join('\n'), 'utf8');
            console.log(`已清理 ${lines.length - recentLines.length} 行过期的投票清除日志`);
        }
        
    } catch (error) {
        console.error('清理旧日志时出错:', error);
    }
}

// 每天清理一次旧日志
setInterval(cleanupOldLogs, 24 * 60 * 60 * 1000);

module.exports = {
    logVoteRemoval,
    readVoteRemovalLogs,
    cleanupOldLogs
}; 