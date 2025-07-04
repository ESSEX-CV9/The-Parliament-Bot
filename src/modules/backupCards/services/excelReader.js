const xlsx = require('xlsx');
const path = require('path');
const config = require('../config/backupConfig');

class ExcelReader {
    constructor(filePath = null) {
        this.filePath = filePath || path.resolve(process.cwd(), config.excel.filePath);
        this.workbook = null;
        this.worksheet = null;
        this.data = [];
        console.log(`Excel读取器初始化完成`);
    }

    /**
     * 读取并解析Excel文件
     */
    async loadExcelData() {
        try {
            console.log('正在读取补卡Excel文件...');
            
            // 读取Excel文件
            this.workbook = xlsx.readFile(this.filePath);
            
            if (!this.workbook.SheetNames || this.workbook.SheetNames.length === 0) {
                throw new Error('Excel文件中没有工作表');
            }
            
            // 获取第一个工作表
            this.worksheet = this.workbook.Sheets[this.workbook.SheetNames[0]];
            console.log(`✅ 成功读取工作表: ${this.workbook.SheetNames[0]}`);
            
            // 将Excel数据转换为JSON（保留原始行号）
            const rawData = xlsx.utils.sheet_to_json(this.worksheet, { 
                header: 1,  // 返回数组格式而非对象
                defval: ''  // 空单元格默认值
            });
            
            if (rawData.length === 0) {
                throw new Error('Excel文件为空');
            }
            
            console.log(`Excel文件读取成功，共 ${rawData.length} 行数据`);
            
            // 跳过标题行，从第二行开始处理数据
            const dataRows = rawData.slice(1);
            
            // 解析每一行数据
            this.data = dataRows.map((row, index) => {
                return this.parseRow(row, index + 2); // +2因为跳过了标题行且Excel行号从1开始
            }).filter(item => item !== null); // 过滤掉无效行
            
            console.log(`成功解析 ${this.data.length} 条有效补卡记录`);
            
            return this.data;
            
        } catch (error) {
            console.error('读取Excel文件失败:', error);
            throw new Error(`Excel文件读取失败: ${error.message}`);
        }
    }

    /**
     * 解析单行数据
     */
    parseRow(row, rowNumber) {
        try {
            // 检查是否有帖子ID
            if (!row[1]) { // B列：帖子ID
                return null;
            }

            const backupItem = {
                rowNumber: rowNumber,
                title: row[0] || '',           // A列：帖子标题
                threadId: String(row[1]),      // B列：帖子ID
                originalThreadId: row[2] || '', // C列：原帖子ID
                authorId: String(row[3] || ''), // D列：发帖人数字id
                claimStatus: row[4] || '',      // E列：认领状态
                claimerId: String(row[5] || ''), // F列：认领者数字id
                completionStatus: row[6] || '', // G列：完成状态
                
                // H列到AL列的补卡内容
                cardContents: []
            };

            // 从H列开始提取补卡内容（H列是第8列，索引为7）
            const startColumnIndex = 7; // H列
            const endColumnIndex = this.getColumnIndex('AL'); // AL列
            
            for (let i = startColumnIndex; i <= endColumnIndex; i++) {
                const content = row[i];
                if (content && content.toString().trim()) {
                    backupItem.cardContents.push({
                        columnIndex: i,
                        columnName: this.getColumnName(i),
                        content: content.toString().trim()
                    });
                }
            }

            // 调试信息（只显示前几条）
            if (rowNumber <= 5) {
                console.log(`解析行 ${rowNumber}: threadId="${backupItem.threadId}", title="${backupItem.title}", 补卡内容数量=${backupItem.cardContents.length}`);
            }

            return backupItem;
            
        } catch (error) {
            console.error(`解析第 ${rowNumber} 行数据失败:`, error);
            return null;
        }
    }

    /**
     * 将列名转换为索引（如AL -> 37）
     */
    getColumnIndex(columnName) {
        let result = 0;
        for (let i = 0; i < columnName.length; i++) {
            result = result * 26 + (columnName.charCodeAt(i) - 'A'.charCodeAt(0) + 1);
        }
        return result - 1; // 转换为0基索引
    }

    /**
     * 将索引转换为列名（如37 -> AL）
     */
    getColumnName(index) {
        let result = '';
        while (index >= 0) {
            result = String.fromCharCode((index % 26) + 'A'.charCodeAt(0)) + result;
            index = Math.floor(index / 26) - 1;
        }
        return result;
    }

    /**
     * 获取所有补卡数据
     */
    getAllBackupItems() {
        return this.data;
    }

    /**
     * 根据帖子ID获取补卡项目
     */
    getBackupItemByThreadId(threadId) {
        const stringThreadId = String(threadId);
        return this.data.find(item => item.threadId === stringThreadId);
    }

    /**
     * 获取指定范围的补卡项目
     */
    getBackupItemsInRange(startIndex, count) {
        const start = Math.max(0, startIndex);
        const end = count ? Math.min(this.data.length, start + count) : this.data.length;
        return this.data.slice(start, end);
    }

    /**
     * 获取统计信息
     */
    getStats() {
        return {
            totalRows: this.data.length,
            totalCards: this.data.reduce((sum, item) => sum + item.cardContents.length, 0),
            threadsWithCards: this.data.filter(item => item.cardContents.length > 0).length
        };
    }
}

module.exports = ExcelReader; 