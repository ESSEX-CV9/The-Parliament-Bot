const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs').promises;

class ExcelWriter {
    constructor(originalFilePath) {
        this.originalFilePath = originalFilePath;
        this.workbook = null;
        this.worksheet = null;
    }
    
    async initialize() {
        try {
            console.log(`📝 初始化Excel写入器: ${this.originalFilePath}`);
            
            this.workbook = XLSX.readFile(this.originalFilePath);
            this.worksheet = this.workbook.Sheets[this.workbook.SheetNames[0]];
            
            this.addResultColumns();
            console.log('✅ Excel写入器初始化完成');
            
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
    
    updatePostResult(rowIndex, post) {
        try {
            const row = rowIndex + 2; // Excel行号从2开始（1为标题行）
            
            this.worksheet[`L${row}`] = { v: post.newForumId || '', t: 's' };
            this.worksheet[`M${row}`] = { v: post.newPostId || '', t: 's' };
            this.worksheet[`N${row}`] = { v: post.rebuildStatus, t: 's' };
            this.worksheet[`O${row}`] = { v: post.rebuildTime || '', t: 's' };
            this.worksheet[`P${row}`] = { v: post.errorMessage || '', t: 's' };
            
        } catch (error) {
            console.error(`更新第 ${rowIndex + 2} 行数据失败:`, error);
        }
    }
    
    async saveToFile(outputPath) {
        try {
            // 确保输出目录存在
            const outputDir = path.dirname(outputPath);
            await fs.mkdir(outputDir, { recursive: true });
            
            // 更新工作表范围到P列
            const range = XLSX.utils.decode_range(this.worksheet['!ref']);
            range.e.c = Math.max(range.e.c, 15); // 扩展到P列（索引15）
            this.worksheet['!ref'] = XLSX.utils.encode_range(range);
            
            // 保存Excel文件
            XLSX.writeFile(this.workbook, outputPath);
            
            console.log(`💾 结果已保存到: ${outputPath}`);
            return outputPath;
            
        } catch (error) {
            console.error('保存Excel文件失败:', error);
            throw new Error(`保存Excel文件失败: ${error.message}`);
        }
    }
    
    generateOutputFileName(originalFilePath, targetForumId) {
        const originalFileName = path.basename(originalFilePath, '.xlsx');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        return `${originalFileName}_重建结果_论坛${targetForumId}_${timestamp}.xlsx`;
    }
}

module.exports = ExcelWriter; 