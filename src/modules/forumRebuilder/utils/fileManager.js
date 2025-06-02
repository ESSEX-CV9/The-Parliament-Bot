const fs = require('fs').promises;
const path = require('path');

class FileManager {
    static async ensureDirectory(dirPath) {
        try {
            await fs.mkdir(dirPath, { recursive: true });
            return true;
        } catch (error) {
            console.error('创建目录失败:', error);
            return false;
        }
    }
    
    static async fileExists(filePath) {
        try {
            await fs.access(filePath, fs.constants.F_OK);
            return true;
        } catch (error) {
            return false;
        }
    }
    
    static async getFileStats(filePath) {
        try {
            return await fs.stat(filePath);
        } catch (error) {
            console.error('获取文件信息失败:', error);
            return null;
        }
    }
    
    static generateUniqueFileName(basePath, fileName) {
        const ext = path.extname(fileName);
        const name = path.basename(fileName, ext);
        const dir = path.dirname(basePath);
        
        let counter = 1;
        let newPath = path.join(dir, fileName);
        
        // 如果文件存在，添加数字后缀
        while (this.fileExistsSync(newPath)) {
            const newName = `${name}_${counter}${ext}`;
            newPath = path.join(dir, newName);
            counter++;
        }
        
        return newPath;
    }
    
    static fileExistsSync(filePath) {
        try {
            require('fs').accessSync(filePath, require('fs').constants.F_OK);
            return true;
        } catch (error) {
            return false;
        }
    }
    
    static async validateExcelFile(filePath) {
        try {
            // 检查文件是否存在
            if (!(await this.fileExists(filePath))) {
                throw new Error('Excel文件不存在');
            }
            
            // 检查文件扩展名
            const ext = path.extname(filePath).toLowerCase();
            if (!['.xlsx', '.xls'].includes(ext)) {
                throw new Error('文件不是有效的Excel格式');
            }
            
            // 检查文件大小
            const stats = await this.getFileStats(filePath);
            if (stats && stats.size > 50 * 1024 * 1024) { // 50MB限制
                throw new Error('Excel文件过大（超过50MB）');
            }
            
            return true;
            
        } catch (error) {
            console.error('验证Excel文件失败:', error);
            throw error;
        }
    }
    
    static getDataDirectory() {
        const dataDir = path.join(process.cwd(), 'data');
        return dataDir;
    }
    
    static getResultsDirectory() {
        const resultsDir = path.join(this.getDataDirectory(), 'results');
        return resultsDir;
    }
}

module.exports = FileManager; 