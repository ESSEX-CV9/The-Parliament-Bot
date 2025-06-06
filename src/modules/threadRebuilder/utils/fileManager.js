const fs = require('fs').promises;
const path = require('path');

class FileManager {
    /**
     * 延迟函数
     */
    static delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    /**
     * 验证JSON文件
     */
    static async validateJsonFile(filePath) {
        try {
            const content = await fs.readFile(filePath, 'utf8');
            const data = JSON.parse(content);
            
            if (!data.thread_info || !data.messages) {
                throw new Error('JSON文件格式不正确');
            }
            
            return true;
        } catch (error) {
            throw new Error(`JSON文件验证失败: ${error.message}`);
        }
    }
    
    /**
     * 确保目录存在
     */
    static async ensureDir(dirPath) {
        try {
            await fs.access(dirPath);
        } catch (error) {
            await fs.mkdir(dirPath, { recursive: true });
        }
    }
}

// 导出延迟函数供其他模块使用
const delay = FileManager.delay;

module.exports = { FileManager, delay }; 