const XLSX = require('xlsx');
const { ForumPost } = require('../models/forumData');

class ExcelReader {
    constructor() {
        this.workbook = null;
        this.worksheet = null;
    }
    
    async readFile(filePath) {
        try {
            console.log(`📖 正在读取Excel文件: ${filePath}`);
            this.workbook = XLSX.readFile(filePath);
            
            if (!this.workbook.SheetNames || this.workbook.SheetNames.length === 0) {
                throw new Error('Excel文件中没有工作表');
            }
            
            this.worksheet = this.workbook.Sheets[this.workbook.SheetNames[0]];
            console.log(`✅ 成功读取工作表: ${this.workbook.SheetNames[0]}`);
            
        } catch (error) {
            console.error('读取Excel文件失败:', error);
            throw new Error(`读取Excel文件失败: ${error.message}`);
        }
    }
    
    parseData() {
        try {
            if (!this.worksheet) {
                throw new Error('没有可用的工作表数据');
            }
            
            const range = XLSX.utils.decode_range(this.worksheet['!ref']);
            const posts = [];
            
            console.log(`📊 检测到 ${range.e.r} 行数据（包含标题行）`);
            
            // 从第2行开始（跳过标题行）
            for (let rowNum = 1; rowNum <= range.e.r; rowNum++) { 
                const rowData = [];
                
                // 读取A到K列（0到10）
                for (let colNum = 0; colNum <= 10; colNum++) { 
                    const cellAddress = XLSX.utils.encode_cell({ r: rowNum, c: colNum });
                    const cell = this.worksheet[cellAddress];
                    rowData.push(cell ? cell.v : '');
                }
                
                // 如果帖子ID不为空，创建帖子对象
                if (rowData[0]) { 
                    try {
                        const post = new ForumPost(rowData);
                        posts.push(post);
                        console.log(`✓ 解析帖子: ${post.title} (ID: ${post.originalPostId})`);
                    } catch (error) {
                        console.error(`解析第 ${rowNum + 1} 行数据失败:`, error);
                    }
                }
            }
            
            console.log(`📈 成功解析 ${posts.length} 个帖子`);
            return posts;
            
        } catch (error) {
            console.error('解析Excel数据失败:', error);
            throw new Error(`解析Excel数据失败: ${error.message}`);
        }
    }
    
    async readPosts(filePath) {
        await this.readFile(filePath);
        return this.parseData();
    }
    
    // 验证Excel文件格式
    validateFormat() {
        try {
            if (!this.worksheet) {
                throw new Error('没有工作表数据');
            }
            
            const range = XLSX.utils.decode_range(this.worksheet['!ref']);
            
            // 检查是否至少有11列
            if (range.e.c < 10) { // 列索引从0开始，10代表K列
                throw new Error('Excel文件列数不足，至少需要11列（A到K）');
            }
            
            // 检查是否有数据行
            if (range.e.r < 1) {
                throw new Error('Excel文件没有数据行');
            }
            
            return true;
            
        } catch (error) {
            console.error('验证Excel格式失败:', error);
            throw error;
        }
    }
}

module.exports = ExcelReader; 