class TimeParser {
    static parseExcelDate(excelDate) {
        try {
            // 如果已经是字符串格式的日期
            if (typeof excelDate === 'string') {
                const date = new Date(excelDate);
                if (!isNaN(date.getTime())) {
                    return date;
                }
            }
            
            // 如果是Excel的数字日期格式
            if (typeof excelDate === 'number') {
                // Excel日期是从1900年1月1日开始的天数
                const excelEpoch = new Date(1900, 0, 1);
                const date = new Date(excelEpoch.getTime() + (excelDate - 1) * 24 * 60 * 60 * 1000);
                return date;
            }
            
            // 默认返回当前时间
            return new Date();
            
        } catch (error) {
            console.error('解析时间失败:', error);
            return new Date();
        }
    }
    
    static formatForDiscord(date) {
        try {
            // 使用Discord时间戳格式
            const timestamp = Math.floor(date.getTime() / 1000);
            return `<t:${timestamp}:F>`; // 完整日期时间格式
        } catch (error) {
            return date.toLocaleString('zh-CN');
        }
    }
    
    static formatForExcel(date) {
        try {
            return date.toISOString();
        } catch (error) {
            return new Date().toISOString();
        }
    }
    
    static getRelativeTime(date) {
        try {
            const now = new Date();
            const diffMs = now.getTime() - date.getTime();
            const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            
            if (diffDays === 0) return '今天';
            if (diffDays === 1) return '昨天';
            if (diffDays < 7) return `${diffDays}天前`;
            if (diffDays < 30) return `${Math.floor(diffDays / 7)}周前`;
            if (diffDays < 365) return `${Math.floor(diffDays / 30)}个月前`;
            
            return `${Math.floor(diffDays / 365)}年前`;
            
        } catch (error) {
            return '未知时间';
        }
    }
}

module.exports = TimeParser; 