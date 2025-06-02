class ForumPost {
    constructor(rowData) {
        this.originalPostId = rowData[0];
        this.originalForumId = rowData[1];
        this.title = rowData[2];
        this.publishTime = rowData[3];
        this.authorId = rowData[4];
        this.messageCount = parseInt(rowData[5]) || 0;
        this.reactionCount = parseInt(rowData[6]) || 0;
        this.tags = this.parseTags(rowData[7]);
        this.content = rowData[8] || '';
        this.messageImages = rowData[9] || '';
        this.images = rowData[10] || '';
        
        // 重建结果
        this.newForumId = null;
        this.newPostId = null;
        this.rebuildStatus = 'pending'; // pending, success, failed, skipped
        this.rebuildTime = null;
        this.errorMessage = null;
    }
    
    parseTags(tagString) {
        if (!tagString) return [];
        
        // 解析 {纯爱,原创,女性向} 格式
        const match = tagString.match(/\{([^}]+)\}/);
        if (match) {
            return match[1].split(',').map(tag => tag.trim()).filter(tag => tag);
        }
        
        return [];
    }
    
    getImageUrls() {
        const urls = [];
        
        if (this.messageImages) {
            urls.push(...this.messageImages.split(',').map(url => url.trim()).filter(url => url));
        }
        
        if (this.images) {
            urls.push(...this.images.split(',').map(url => url.trim()).filter(url => url));
        }
        
        return urls;
    }
    
    setRebuildResult(result) {
        this.newForumId = result.newForumId;
        this.newPostId = result.newPostId;
        this.rebuildStatus = result.status;
        this.rebuildTime = new Date().toISOString();
        this.errorMessage = result.error || null;
    }
    
    toExcelRow() {
        return [
            this.originalPostId,
            this.originalForumId,
            this.title,
            this.publishTime,
            this.authorId,
            this.messageCount,
            this.reactionCount,
            this.formatTagsForExcel(),
            this.content,
            this.messageImages,
            this.images,
            this.newForumId,
            this.newPostId,
            this.rebuildStatus,
            this.rebuildTime,
            this.errorMessage
        ];
    }
    
    formatTagsForExcel() {
        if (this.tags.length === 0) return '';
        return `{${this.tags.join(',')}}`;
    }
}

class RebuildResult {
    constructor() {
        this.totalPosts = 0;
        this.successCount = 0;
        this.failedCount = 0;
        this.skippedCount = 0;
        this.failedPosts = [];
        this.outputFilePath = '';
        this.startTime = new Date();
        this.endTime = null;
    }
    
    addSuccess() {
        this.successCount++;
    }
    
    addFailure(post, error) {
        this.failedCount++;
        this.failedPosts.push({
            originalPostId: post.originalPostId,
            title: post.title,
            error: error
        });
    }
    
    addSkipped() {
        this.skippedCount++;
    }
    
    complete(outputFilePath) {
        this.endTime = new Date();
        this.outputFilePath = outputFilePath;
    }
    
    getDuration() {
        if (!this.endTime) return 0;
        return Math.round((this.endTime - this.startTime) / 1000);
    }
    
    getSuccessRate() {
        if (this.totalPosts === 0) return 0;
        return Math.round((this.successCount / this.totalPosts) * 100);
    }
}

module.exports = {
    ForumPost,
    RebuildResult
}; 