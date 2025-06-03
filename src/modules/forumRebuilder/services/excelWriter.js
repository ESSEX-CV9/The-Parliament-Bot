const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs').promises;

class ExcelWriter {
    constructor(originalFilePath, targetForumId) {
        this.originalFilePath = originalFilePath;
        this.targetForumId = targetForumId;
        this.workbook = null;
        this.worksheet = null;
        this.outputPath = null;
        this.isResuming = false;
    }
    
    // 生成输出文件路径
    generateOutputPath() {
        const originalFileName = path.basename(this.originalFilePath, '.xlsx');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const fileName = `${originalFileName}_重建进度_论坛${this.targetForumId}_${timestamp}.xlsx`;
        
        const FileManager = require('../utils/fileManager');
        const resultsDir = FileManager.getResultsDirectory();
        return path.join(resultsDir, fileName);
    }
    
    // 查找之前的进度文件
    async findExistingProgressFile() {
        try {
            const FileManager = require('../utils/fileManager');
            const resultsDir = FileManager.getResultsDirectory();
            
            if (!await FileManager.fileExists(resultsDir)) {
                return null;
            }
            
            const files = await fs.readdir(resultsDir);
            const originalFileName = path.basename(this.originalFilePath, '.xlsx');
            
            // 查找匹配的进度文件
            const progressFiles = files.filter(file => 
                file.startsWith(`${originalFileName}_重建进度_论坛${this.targetForumId}_`) && 
                file.endsWith('.xlsx')
            );
            
            if (progressFiles.length === 0) {
                return null;
            }
            
            // 返回最新的文件
            progressFiles.sort((a, b) => b.localeCompare(a));
            const latestFile = path.join(resultsDir, progressFiles[0]);
            
            console.log(`🔍 找到之前的进度文件: ${progressFiles[0]}`);
            return latestFile;
            
        } catch (error) {
            console.error('查找进度文件失败:', error);
            return null;
        }
    }
    
    async initialize() {
        try {
            const FileManager = require('../utils/fileManager');
            const resultsDir = FileManager.getResultsDirectory();
            await FileManager.ensureDirectory(resultsDir);
            
            // 首先尝试查找现有的进度文件
            const existingProgressFile = await this.findExistingProgressFile();
            
            if (existingProgressFile) {
                // 使用现有的进度文件
                console.log(`📂 使用现有进度文件: ${existingProgressFile}`);
                this.outputPath = existingProgressFile;
                this.workbook = XLSX.readFile(existingProgressFile);
                this.isResuming = true;
            } else {
                // 复制原始文件作为新的进度文件
                console.log(`📝 复制原始Excel文件创建新的进度文件`);
                this.outputPath = this.generateOutputPath();
                
                // 复制原始文件
                await fs.copyFile(this.originalFilePath, this.outputPath);
                this.workbook = XLSX.readFile(this.outputPath);
                this.isResuming = false;
            }
            
            this.worksheet = this.workbook.Sheets[this.workbook.SheetNames[0]];
            
            if (!this.isResuming) {
                this.addResultColumns();
            }
            
            console.log(`✅ Excel写入器初始化完成 - ${this.isResuming ? '继续模式' : '新建模式'}`);
            console.log(`📄 输出文件: ${this.outputPath}`);
            
        } catch (error) {
            console.error('初始化Excel写入器失败:', error);
            throw new Error(`初始化Excel写入器失败: ${error.message}`);
        }
    }
    
    addResultColumns() {
        try {
            // 添加新列标题
            this.worksheet['L1'] = { v: '新论坛ID', t: 's' };
            this.worksheet['M1'] = { v: '新帖子ID', t: 's' };
            this.worksheet['N1'] = { v: '重建状态', t: 's' };
            this.worksheet['O1'] = { v: '重建时间', t: 's' };
            this.worksheet['P1'] = { v: '错误信息', t: 's' };
            
            console.log('📋 已添加结果列标题');
            
        } catch (error) {
            console.error('添加结果列失败:', error);
            throw error;
        }
    }
    
    // 检查某一行是否已经处理过
    isRowProcessed(rowIndex) {
        try {
            const row = rowIndex + 2; // Excel行号从2开始（1为标题行）
            const statusCell = this.worksheet[`N${row}`];
            return statusCell && (statusCell.v === 'success' || statusCell.v === 'failed');
        } catch (error) {
            return false;
        }
    }
    
    updatePostResult(rowIndex, post) {
        try {
            const row = rowIndex + 2; // Excel行号从2开始（1为标题行）
            
            this.worksheet[`L${row}`] = { v: post.newForumId || '', t: 's' };
            this.worksheet[`M${row}`] = { v: post.newPostId || '', t: 's' };
            this.worksheet[`N${row}`] = { v: post.rebuildStatus, t: 's' };
            this.worksheet[`O${row}`] = { v: post.rebuildTime || new Date().toISOString(), t: 's' };
            this.worksheet[`P${row}`] = { v: post.errorMessage || '', t: 's' };
            
        } catch (error) {
            console.error(`更新第 ${rowIndex + 2} 行数据失败:`, error);
        }
    }
    
    // 实时保存到文件（每处理一批后调用）
    async saveProgress() {
        try {
            // 更新工作表范围到P列
            const range = XLSX.utils.decode_range(this.worksheet['!ref']);
            range.e.c = Math.max(range.e.c, 15); // 扩展到P列（索引15）
            this.worksheet['!ref'] = XLSX.utils.encode_range(range);
            
            // 保存Excel文件
            XLSX.writeFile(this.workbook, this.outputPath);
            
            console.log(`💾 进度已保存到: ${path.basename(this.outputPath)}`);
            
        } catch (error) {
            console.error('保存进度失败:', error);
            throw new Error(`保存进度失败: ${error.message}`);
        }
    }
    
    async saveToFile(outputPath) {
        // 如果指定了不同的输出路径，则复制到新位置
        if (outputPath && outputPath !== this.outputPath) {
            try {
                await fs.copyFile(this.outputPath, outputPath);
                console.log(`💾 结果已复制到: ${outputPath}`);
                return outputPath;
            } catch (error) {
                console.error('复制结果文件失败:', error);
                throw new Error(`复制结果文件失败: ${error.message}`);
            }
        }
        
        return this.outputPath;
    }
    
    getOutputPath() {
        return this.outputPath;
    }
    
    getOutputFileName() {
        return path.basename(this.outputPath);
    }
    
    generateOutputFileName(originalFilePath, targetForumId) {
        // 保持兼容性，但现在主要使用内部的输出路径
        return this.getOutputFileName();
    }
}

module.exports = ExcelWriter; 