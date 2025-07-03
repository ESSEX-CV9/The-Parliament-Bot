const path = require('path');
const config = require('../config/backupConfig');

class ContentAnalyzer {
    constructor() {
        this.supportedImageFormats = config.processing.supportedImageFormats;
        this.supportedFileFormats = config.processing.supportedFileFormats;
        this.textDescriptions = config.content.textDescriptions;
        this.discordLinkPattern = config.content.discordLinkPattern;
    }

    /**
     * 分析内容类型
     * @param {string} content - 要分析的内容
     * @returns {Object} 分析结果
     */
    analyzeContent(content) {
        if (!content || typeof content !== 'string') {
            return {
                type: 'empty',
                originalContent: content,
                description: '空内容'
            };
        }

        const trimmedContent = content.trim();

        // 1. 检查是否是Discord链接
        const discordLinks = this.extractDiscordLinks(trimmedContent);
        if (discordLinks.length > 0) {
            return {
                type: 'discord_link',
                originalContent: content,
                links: discordLinks,
                description: '包含Discord链接',
                hasAdditionalText: trimmedContent.replace(this.discordLinkPattern, '').trim().length > 0
            };
        }

        // 2. 检查是否是文字描述
        if (this.isTextDescription(trimmedContent)) {
            return {
                type: 'text_description',
                originalContent: content,
                description: '文字描述',
                category: this.getTextDescriptionCategory(trimmedContent)
            };
        }

        // 3. 检查是否是文件路径
        const fileAnalysis = this.analyzeFilePath(trimmedContent);
        if (fileAnalysis.isFile) {
            return {
                type: 'file',
                originalContent: content,
                fileType: fileAnalysis.fileType,
                fileName: fileAnalysis.fileName,
                hasPath: fileAnalysis.hasPath,
                pathPrefix: fileAnalysis.pathPrefix,
                extension: fileAnalysis.extension,
                description: `${fileAnalysis.fileType}文件`
            };
        }

        // 4. 默认为未知类型
        return {
            type: 'unknown',
            originalContent: content,
            description: '未识别的内容类型'
        };
    }

    /**
     * 提取Discord链接
     */
    extractDiscordLinks(content) {
        const matches = content.match(this.discordLinkPattern);
        return matches || [];
    }

    /**
     * 检查是否是文字描述
     */
    isTextDescription(content) {
        const lowerContent = content.toLowerCase();
        return this.textDescriptions.some(desc => 
            lowerContent.includes(desc.toLowerCase())
        );
    }

    /**
     * 获取文字描述的类别
     */
    getTextDescriptionCategory(content) {
        const lowerContent = content.toLowerCase();
        
        if (lowerContent.includes('作者自补') || lowerContent.includes('作者已经自补')) {
            return 'author_self_backup';
        }
        if (lowerContent.includes('网盘')) {
            return 'cloud_storage';
        }
        if (lowerContent.includes('无需匹配')) {
            return 'no_match_needed';
        }
        if (lowerContent.includes('源文档匹配失败')) {
            return 'source_match_failed';
        }
        
        return 'other';
    }

    /**
     * 分析文件路径
     */
    analyzeFilePath(content) {
        // 检查是否包含文件扩展名
        const extension = path.extname(content).toLowerCase();
        
        if (!extension) {
            return { isFile: false };
        }

        const fileName = path.basename(content);
        const dirPath = path.dirname(content);
        const hasPath = dirPath && dirPath !== '.' && dirPath !== content;

        // 判断文件类型
        let fileType = 'unknown';
        if (this.supportedImageFormats.includes(extension)) {
            fileType = 'image';
        } else if (this.supportedFileFormats.includes(extension)) {
            fileType = 'data';
        }

        // 分析路径前缀
        let pathPrefix = null;
        if (hasPath) {
            // 提取第一级目录作为路径前缀
            const pathParts = dirPath.split(/[/\\]/);
            pathPrefix = pathParts[0];
        }

        return {
            isFile: fileType !== 'unknown',
            fileType,
            fileName,
            hasPath,
            pathPrefix,
            extension,
            fullPath: content
        };
    }

    /**
     * 批量分析内容
     */
    analyzeMultipleContents(contents) {
        return contents.map((content, index) => ({
            index,
            ...this.analyzeContent(content)
        }));
    }

    /**
     * 按类型分组内容
     */
    groupContentsByType(contents) {
        const analyzed = this.analyzeMultipleContents(contents);
        const groups = {
            files: [],
            textDescriptions: [],
            discordLinks: [],
            unknown: [],
            empty: []
        };

        analyzed.forEach(item => {
            switch (item.type) {
                case 'file':
                    groups.files.push(item);
                    break;
                case 'text_description':
                    groups.textDescriptions.push(item);
                    break;
                case 'discord_link':
                    groups.discordLinks.push(item);
                    break;
                case 'unknown':
                    groups.unknown.push(item);
                    break;
                case 'empty':
                    groups.empty.push(item);
                    break;
            }
        });

        return groups;
    }

    /**
     * 获取处理优先级
     */
    getProcessingPriority(contentType) {
        const priorities = {
            'file': 1,           // 文件最优先
            'discord_link': 2,   // 链接其次
            'text_description': 3, // 文字描述
            'unknown': 4,        // 未知类型
            'empty': 5           // 空内容最后
        };
        
        return priorities[contentType] || 10;
    }

    /**
     * 排序内容（按处理优先级）
     */
    sortContentsByPriority(analyzedContents) {
        return analyzedContents.sort((a, b) => {
            const priorityA = this.getProcessingPriority(a.type);
            const priorityB = this.getProcessingPriority(b.type);
            return priorityA - priorityB;
        });
    }
}

module.exports = ContentAnalyzer; 