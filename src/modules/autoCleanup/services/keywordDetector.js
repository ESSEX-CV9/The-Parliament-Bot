class KeywordDetector {
    constructor() {
        this.cache = new Map(); // 缓存关键字设置
    }

    async checkMessage(message, bannedKeywords) {
        if (!message.content || bannedKeywords.length === 0) {
            return { shouldDelete: false, matchedKeywords: [] };
        }

        const content = message.content.toLowerCase();
        const matchedKeywords = [];

        for (const keyword of bannedKeywords) {
            if (content.includes(keyword.toLowerCase())) {
                matchedKeywords.push(keyword);
            }
        }

        return {
            shouldDelete: matchedKeywords.length > 0,
            matchedKeywords
        };
    }

    async checkMessageAdvanced(message, bannedKeywords) {
        // 支持正则表达式匹配
        if (!message.content || bannedKeywords.length === 0) {
            return { shouldDelete: false, matchedKeywords: [] };
        }

        const content = message.content.toLowerCase();
        const matchedKeywords = [];

        for (const keyword of bannedKeywords) {
            try {
                // 检查是否为正则表达式（以/开头和结尾）
                if (keyword.startsWith('/') && keyword.endsWith('/')) {
                    const regex = new RegExp(keyword.slice(1, -1), 'i');
                    if (regex.test(content)) {
                        matchedKeywords.push(keyword);
                    }
                } else {
                    // 普通关键字匹配
                    if (content.includes(keyword.toLowerCase())) {
                        matchedKeywords.push(keyword);
                    }
                }
            } catch (error) {
                console.error(`无效的正则表达式关键字: ${keyword}`, error);
                // 对于无效的正则，使用普通匹配
                if (content.includes(keyword.toLowerCase())) {
                    matchedKeywords.push(keyword);
                }
            }
        }

        return {
            shouldDelete: matchedKeywords.length > 0,
            matchedKeywords
        };
    }

    normalizeKeyword(keyword) {
        return keyword.trim().toLowerCase();
    }

    isValidKeyword(keyword) {
        return keyword && keyword.trim().length > 0;
    }
}

module.exports = { KeywordDetector }; 