class ContestCacheManager {
    constructor() {
        this.submissionCache = new Map();
        this.contestChannelCache = new Map();
        this.cacheTimeout = 30000; // 30秒缓存
        
        // 定期清理过期缓存
        setInterval(() => {
            this.cleanExpiredCache();
        }, 60000); // 每分钟清理一次
    }

    // 获取带缓存的投稿数据
    async getSubmissionsWithCache(contestChannelId, getSubmissionsByChannel) {
        const cacheKey = `submissions_${contestChannelId}`;
        const cached = this.submissionCache.get(cacheKey);
        
        if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
            console.log(`使用缓存的投稿数据 - 频道: ${contestChannelId}`);
            return cached.data;
        }
        
        console.log(`从数据库获取投稿数据 - 频道: ${contestChannelId}`);
        const submissions = await getSubmissionsByChannel(contestChannelId);
        
        this.submissionCache.set(cacheKey, {
            data: submissions,
            timestamp: Date.now()
        });
        
        return submissions;
    }

    // 获取带缓存的赛事频道数据
    async getContestChannelWithCache(contestChannelId, getContestChannel) {
        const cacheKey = `channel_${contestChannelId}`;
        const cached = this.contestChannelCache.get(cacheKey);
        
        if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
            console.log(`使用缓存的频道数据 - 频道: ${contestChannelId}`);
            return cached.data;
        }
        
        console.log(`从数据库获取频道数据 - 频道: ${contestChannelId}`);
        const channelData = await getContestChannel(contestChannelId);
        
        this.contestChannelCache.set(cacheKey, {
            data: channelData,
            timestamp: Date.now()
        });
        
        return channelData;
    }

    // 清除指定频道的投稿缓存（当有新投稿时调用）
    clearSubmissionCache(contestChannelId) {
        const cacheKey = `submissions_${contestChannelId}`;
        this.submissionCache.delete(cacheKey);
        console.log(`清除投稿缓存 - 频道: ${contestChannelId}`);
    }

    // 清除指定频道的频道缓存
    clearContestChannelCache(contestChannelId) {
        const cacheKey = `channel_${contestChannelId}`;
        this.contestChannelCache.delete(cacheKey);
        console.log(`清除频道缓存 - 频道: ${contestChannelId}`);
    }

    // 清除所有缓存
    clearAllCache() {
        this.submissionCache.clear();
        this.contestChannelCache.clear();
        console.log('清除所有缓存');
    }

    // 清理过期缓存
    cleanExpiredCache() {
        const now = Date.now();
        
        // 清理投稿缓存
        for (const [key, value] of this.submissionCache.entries()) {
            if (now - value.timestamp > this.cacheTimeout) {
                this.submissionCache.delete(key);
            }
        }
        
        // 清理频道缓存
        for (const [key, value] of this.contestChannelCache.entries()) {
            if (now - value.timestamp > this.cacheTimeout) {
                this.contestChannelCache.delete(key);
            }
        }
    }

    // 获取缓存统计信息
    getCacheStats() {
        return {
            submissionCacheSize: this.submissionCache.size,
            contestChannelCacheSize: this.contestChannelCache.size,
            cacheTimeout: this.cacheTimeout
        };
    }
}

// 创建全局缓存管理器实例
const contestCacheManager = new ContestCacheManager();

module.exports = { contestCacheManager }; 