const fs = require('fs').promises;
const path = require('path');

class ContentFilter {
    constructor() {
        this.configPath = path.resolve(process.cwd(), 'data/rebuild/content-filter.json');
        this.enabled = false;
        this.defaultReplacement = '[数据删除]';
        this.keywords = [];
        this.patterns = [];
        this.configLoaded = false;
        
        console.log(`内容过滤器初始化，配置文件路径: ${this.configPath}`);
    }
    
    /**
     * 加载过滤配置
     */
    async loadConfig() {
        try {
            console.log('正在加载内容过滤配置...');
            
            // 检查配置文件是否存在
            try {
                await fs.access(this.configPath);
            } catch (error) {
                console.log('内容过滤配置文件不存在，创建默认配置文件...');
                await this.createDefaultConfig();
            }
            
            const configContent = await fs.readFile(this.configPath, 'utf8');
            const config = JSON.parse(configContent);
            
            this.enabled = config.enabled !== false; // 默认启用
            this.defaultReplacement = config.defaultReplacement || '[数据删除]';
            this.keywords = config.keywords || [];
            this.patterns = config.patterns || [];
            
            console.log(`内容过滤配置加载完成:`);
            console.log(`- 启用状态: ${this.enabled}`);
            console.log(`- 默认替换词: ${this.defaultReplacement}`);
            console.log(`- 关键词数量: ${this.keywords.length}`);
            console.log(`- 正则模式数量: ${this.patterns.length}`);
            
            this.configLoaded = true;
            
        } catch (error) {
            console.warn('加载内容过滤配置失败:', error);
            this.enabled = false;
            this.configLoaded = false;
        }
    }
    
    /**
     * 创建默认配置文件
     */
    async createDefaultConfig() {
        const defaultConfig = {
            enabled: true,
            defaultReplacement: "[数据删除]",
            keywords: [
                {
                    "keyword": "萝莉",
                    "replacement": "[数据删除_L]",
                    "caseSensitive": false
                },
                {
                    "keyword": "蘿莉",
                    "replacement": "[数据删除_L]",
                    "caseSensitive": true
                },
                {
                    "keyword": "幼女",
                    "replacement": "[数据删除_L]",
                    "caseSensitive": false
                },
                {
                    "keyword": "小女孩",
                    "replacement": "[数据删除_L]",
                    "caseSensitive": false
                },
                {
                    "keyword": "小女儿",
                    "replacement": "[数据删除_L]",
                    "caseSensitive": false
                },
                {
                    "keyword": "正太",
                    "replacement": "[数据删除_S]",
                    "caseSensitive": false
                },
                {
                    "keyword": "小男孩",
                    "replacement": "[数据删除_S]",
                    "caseSensitive": false
                },
                {
                    "keyword": "炼铜",
                    "replacement": "[数据删除]",
                    "caseSensitive": false
                }
            ],
            patterns: [
                {
                    pattern: "\\b[A-Za-z0-9._%+-]+####[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b",
                    replacement: "[邮箱地址]",
                    description: "邮箱地址模式"
                }
            ]
        };
        
        await fs.writeFile(this.configPath, JSON.stringify(defaultConfig, null, 2), 'utf8');
        console.log('默认内容过滤配置文件已创建');
    }
    
    /**
     * 过滤文本内容
     */
    filterText(text) {
        if (!this.enabled || !this.configLoaded || !text || typeof text !== 'string') {
            return text;
        }
        
        let filteredText = text;
        let replacementCount = 0;
        
        // 处理关键词过滤
        for (const keywordConfig of this.keywords) {
            const keyword = keywordConfig.keyword;
            const replacement = keywordConfig.replacement || this.defaultReplacement;
            const caseSensitive = keywordConfig.caseSensitive !== false; // 默认区分大小写
            
            let regex;
            if (caseSensitive) {
                regex = new RegExp(this.escapeRegex(keyword), 'g');
            } else {
                regex = new RegExp(this.escapeRegex(keyword), 'gi');
            }
            
            const matches = filteredText.match(regex);
            if (matches) {
                filteredText = filteredText.replace(regex, replacement);
                replacementCount += matches.length;
                console.log(`替换关键词 "${keyword}" ${matches.length} 次 -> "${replacement}"`);
            }
        }
        
        // 处理正则模式过滤
        for (const patternConfig of this.patterns) {
            try {
                const regex = new RegExp(patternConfig.pattern, 'g');
                const replacement = patternConfig.replacement || this.defaultReplacement;
                
                const matches = filteredText.match(regex);
                if (matches) {
                    filteredText = filteredText.replace(regex, replacement);
                    replacementCount += matches.length;
                    console.log(`应用模式 "${patternConfig.description || patternConfig.pattern}" ${matches.length} 次 -> "${replacement}"`);
                }
            } catch (error) {
                console.warn(`正则模式错误: ${patternConfig.pattern}`, error);
            }
        }
        
        if (replacementCount > 0) {
            console.log(`文本过滤完成，共进行 ${replacementCount} 次替换`);
        }
        
        return filteredText;
    }
    
    /**
     * 过滤帖子数据
     */
    filterThreadData(threadData) {
        if (!this.enabled || !this.configLoaded) {
            return threadData;
        }
        
        console.log('开始过滤帖子内容...');
        let totalReplacements = 0;
        
        // 过滤帖子标题
        const originalTitle = threadData.threadInfo.title;
        const filteredTitle = this.filterText(originalTitle);
        if (filteredTitle !== originalTitle) {
            threadData.threadInfo.title = filteredTitle;
            console.log(`帖子标题已过滤: "${originalTitle}" -> "${filteredTitle}"`);
            totalReplacements++;
        }
        
        // 过滤消息内容
        for (let i = 0; i < threadData.messages.length; i++) {
            const message = threadData.messages[i];
            
            // 过滤消息文本内容
            if (message.content.text) {
                const originalText = message.content.text;
                const filteredText = this.filterText(originalText);
                if (filteredText !== originalText) {
                    message.content.text = filteredText;
                    totalReplacements++;
                }
            }
            
            // 过滤消息markdown内容
            if (message.content.markdown) {
                const originalMarkdown = message.content.markdown;
                const filteredMarkdown = this.filterText(originalMarkdown);
                if (filteredMarkdown !== originalMarkdown) {
                    message.content.markdown = filteredMarkdown;
                    totalReplacements++;
                }
            }
            
            // 过滤系统消息的特殊字段
            if (message.content.systemAction) {
                message.content.systemAction = this.filterText(message.content.systemAction);
            }
            if (message.content.newName) {
                message.content.newName = this.filterText(message.content.newName);
            }
            if (message.content.oldName) {
                message.content.oldName = this.filterText(message.content.oldName);
            }
            if (message.content.newTitle) {
                message.content.newTitle = this.filterText(message.content.newTitle);
            }
            if (message.content.oldTitle) {
                message.content.oldTitle = this.filterText(message.content.oldTitle);
            }
        }
        
        if (totalReplacements > 0) {
            console.log(`帖子内容过滤完成，共过滤 ${totalReplacements} 处内容`);
        } else {
            console.log('帖子内容无需过滤');
        }
        
        return threadData;
    }
    
    /**
     * 转义正则表达式特殊字符
     */
    escapeRegex(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    
    /**
     * 获取过滤统计信息
     */
    getFilterStats() {
        return {
            enabled: this.enabled,
            configLoaded: this.configLoaded,
            keywordCount: this.keywords.length,
            patternCount: this.patterns.length
        };
    }
}

module.exports = ContentFilter; 