const fs = require('fs').promises;
const path = require('path');

const stateFilePath = path.join(__dirname, '..', 'data', 'scanState.json');

async function ensureDataDirectory() {
    try {
        await fs.mkdir(path.dirname(stateFilePath), { recursive: true });
    } catch (error) {
        console.error('创建数据目录失败:', error);
        throw error;
    }
}

async function readState() {
    try {
        await ensureDataDirectory();
        const data = await fs.readFile(stateFilePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { lastProcessedThreadId: null, processedCount: 0, failedThreads: [] }; // 文件不存在，返回初始状态
        }
        console.error('读取扫描状态失败:', error);
        throw error;
    }
}

async function writeState(state) {
    try {
        await ensureDataDirectory();
        await fs.writeFile(stateFilePath, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
        console.error('写入扫描状态失败:', error);
        throw error;
    }
}

module.exports = {
    readState,
    writeState,
};