const xlsx = require('xlsx');
const path = require('path');

class ExcelReader {
    constructor() {
        this.excelPath = path.resolve(process.cwd(), 'data/rebuild/帖子信息汇总_short.xlsx');
        this.threadInfoMap = new Map(); // 存储thread_id -> 帖子信息的映射
        this.tagCountMap = new Map(); // 存储tag使用次数
        this.topTags = []; // 最常用的20个标签
        console.log(`Excel读取器初始化，文件路径: ${this.excelPath}`);
    }
    
    /**
     * 读取并解析Excel文件
     */
    async loadExcelData() {
        try {
            console.log('正在读取Excel文件...');
            const workbook = xlsx.readFile(this.excelPath);
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            
            // 将Excel数据转换为JSON
            const data = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
            
            if (data.length === 0) {
                throw new Error('Excel文件为空');
            }
            
            // 跳过标题行，从第二行开始处理数据
            const rows = data.slice(1);
            
            console.log(`Excel文件读取成功，共 ${rows.length} 行数据`);
            
            // 处理每一行数据
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                
                // 跳过空行
                if (!row || row.length === 0 || !row[0]) {
                    continue;
                }
                
                const threadId = String(row[0]); // A列：帖子数字ID
                const forumId = String(row[1] || ''); // B列：论坛数字ID
                const title = String(row[2] || ''); // C列：帖子标题
                const createdAt = row[3] || ''; // D列：帖子发布时间
                const lastReplyAt = row[4] || ''; // E列：帖子最后回复时间
                const authorId = String(row[5] || ''); // F列：发帖人数字id
                const totalMessages = Number(row[6]) || 0; // G列：总消息数
                const totalReactions = Number(row[7]) || 0; // H列：总反应数
                const tags = String(row[8] || ''); // I列：TAG
                const firstMessageContent = String(row[9] || ''); // J列：首条消息内容
                
                // 添加调试信息（只打印前几条）
                if (i < 3) {
                    console.log(`Excel行 ${i + 2}: threadId="${threadId}", title="${title}", authorId="${authorId}", tags="${tags}"`);
                }
                
                // 存储帖子信息
                this.threadInfoMap.set(threadId, {
                    threadId,
                    forumId,
                    title,
                    createdAt,
                    lastReplyAt,
                    authorId: authorId === '' ? '[数据缺失]' : authorId,
                    totalMessages,
                    totalReactions,
                    tags,
                    firstMessageContent
                });
                
                // 统计标签使用次数
                this.processTags(tags);
            }
            
            // 生成最常用的20个标签
            this.generateTopTags();
            
            console.log(`Excel数据加载完成:`);
            console.log(`- 总行数: ${rows.length}`);
            console.log(`- 有效数据: ${this.threadInfoMap.size}`);
            console.log(`- 示例thread_id:`, Array.from(this.threadInfoMap.keys()).slice(0, 5));
            
        } catch (error) {
            console.error('读取Excel文件失败:', error);
            throw new Error(`Excel文件读取失败: ${error.message}`);
        }
    }
    
    /**
     * 处理标签字符串并统计使用次数
     */
    processTags(tagsString) {
        if (!tagsString || tagsString.trim() === '') {
            return;
        }
        
        try {
            // 移除大括号并分割标签
            const cleanTags = tagsString.replace(/[{}]/g, '').trim();
            if (!cleanTags) {
                return;
            }
            
            const tags = cleanTags.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);
            
            // 统计每个标签的使用次数
            for (const tag of tags) {
                const currentCount = this.tagCountMap.get(tag) || 0;
                this.tagCountMap.set(tag, currentCount + 1);
            }
            
        } catch (error) {
            console.warn(`处理标签失败: ${tagsString}`, error);
        }
    }
    
    /**
     * 生成最常用的20个标签
     */
    generateTopTags() {
        // 将标签按使用次数排序
        const sortedTags = Array.from(this.tagCountMap.entries())
            .sort((a, b) => b[1] - a[1]) // 按使用次数降序排序
            .slice(0, 20); // 只取前20个
        
        this.topTags = sortedTags.map(([tag, count]) => ({ name: tag, count }));
        
        console.log('最常用的标签:');
        this.topTags.forEach((tag, index) => {
            console.log(`${index + 1}. ${tag.name} (使用 ${tag.count} 次)`);
        });
    }
    
    /**
     * 根据帖子ID获取帖子信息
     */
    getThreadInfo(threadId) {
        const stringThreadId = String(threadId);
        console.log(`Excel查询: 查找thread_id="${stringThreadId}"`);
        
        const result = this.threadInfoMap.get(stringThreadId);
        if (result) {
            console.log(`Excel查询成功: 找到数据`, {
                threadId: result.threadId,
                title: result.title,
                authorId: result.authorId,
                tags: result.tags
            });
        } else {
            console.log(`Excel查询失败: 未找到thread_id="${stringThreadId}"`);
            console.log(`可用的前10个thread_id:`, Array.from(this.threadInfoMap.keys()).slice(0, 10));
        }
        
        return result;
    }
    
    /**
     * 获取最常用的标签列表
     */
    getTopTags() {
        return this.topTags;
    }
    
    /**
     * 解析帖子的标签列表
     */
    getThreadTags(threadId) {
        console.log(`获取标签: thread_id="${threadId}"`);
        
        const threadInfo = this.getThreadInfo(threadId);
        if (!threadInfo || !threadInfo.tags) {
            console.log(`无标签数据: threadInfo存在=${!!threadInfo}, tags="${threadInfo?.tags}"`);
            return [];
        }
        
        try {
            const cleanTags = threadInfo.tags.replace(/[{}]/g, '').trim();
            console.log(`清理后的标签字符串: "${cleanTags}"`);
            
            if (!cleanTags) {
                console.log(`标签字符串为空`);
                return [];
            }
            
            const tags = cleanTags.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);
            console.log(`解析出的所有标签:`, tags);
            
            // 只返回在top20中的标签
            const topTagNames = this.topTags.map(t => t.name);
            const filteredTags = tags.filter(tag => topTagNames.includes(tag));
            
            console.log(`过滤后的标签（在top20中）:`, filteredTags);
            console.log(`Top20标签列表:`, topTagNames.slice(0, 5), '...(显示前5个)');
            
            return filteredTags;
            
        } catch (error) {
            console.warn(`解析帖子标签失败: ${threadId}`, error);
            return [];
        }
    }
    
    /**
     * 获取用户显示名称（目前返回ID，后续可扩展为真实用户名）
     */
    async getUserDisplayName(userId) {
        // 如果是数据缺失，直接返回
        if (userId === '[数据缺失]') {
            return '[数据缺失]';
        }
        
        // 这里可以扩展为通过Discord API获取真实用户名
        // 目前简单返回@用户ID的格式
        return `<@${userId}>`;
    }
}

module.exports = ExcelReader; 