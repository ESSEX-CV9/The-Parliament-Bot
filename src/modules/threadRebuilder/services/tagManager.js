class TagManager {
    constructor(forum, excelReader) {
        this.forum = forum;
        this.excelReader = excelReader;
        this.tagsCreated = false;
    }
    
    /**
     * 创建所有需要的标签
     */
    async createAllTags() {
        if (this.tagsCreated) {
            return;
        }
        
        try {
            console.log('开始创建论坛标签...');
            
            const topTags = this.excelReader.getTopTags();
            if (topTags.length === 0) {
                console.log('没有需要创建的标签');
                return;
            }
            
            // 获取现有标签
            await this.forum.fetch(); // 确保数据是最新的
            const existingTags = this.forum.availableTags || [];
            const existingTagNames = existingTags.map(tag => tag.name);
            
            console.log(`现有标签数量: ${existingTags.length}`);
            console.log(`计划创建标签数量: ${topTags.length}`);
            
            let createdCount = 0;
            let skippedCount = 0;
            
            // 准备新的标签列表
            const newTags = [...existingTags];
            
            for (const tagInfo of topTags) {
                const tagName = tagInfo.name;
                
                // 检查标签是否已存在
                if (existingTagNames.includes(tagName)) {
                    console.log(`标签已存在，跳过: ${tagName}`);
                    skippedCount++;
                    continue;
                }
                
                // 检查是否超出Discord的标签数量限制（20个）
                if (newTags.length >= 20) {
                    console.log(`已达到Discord论坛标签数量限制(20个)，停止创建: ${tagName}`);
                    break;
                }
                
                // 添加新标签到列表
                newTags.push({
                    name: tagName,
                    moderated: false,
                    emoji: null
                });
                
                console.log(`准备创建标签: ${tagName} (使用 ${tagInfo.count} 次)`);
                createdCount++;
            }
            
            // 一次性设置所有标签
            if (createdCount > 0) {
                await this.forum.setAvailableTags(newTags);
                console.log(`批量创建标签完成: 新建 ${createdCount} 个，跳过 ${skippedCount} 个`);
            } else {
                console.log('没有新标签需要创建');
            }
            
            this.tagsCreated = true;
            
        } catch (error) {
            console.error('创建论坛标签失败:', error);
            throw error;
        }
    }
    
    /**
     * 为帖子应用相应的标签
     */
    async applyTagsToThread(thread, originalThreadId) {
        try {
            console.log(`====== 标签应用详细调试 ======`);
            console.log(`目标帖子: ${thread.name} (ID: ${thread.id})`);
            console.log(`原始thread_id: ${originalThreadId}`);
            
            const threadTags = this.excelReader.getThreadTags(originalThreadId);
            console.log(`从Excel获取的标签:`, threadTags);
            
            if (threadTags.length === 0) {
                console.log(`❌ 帖子 ${originalThreadId} 没有需要添加的标签`);
                return;
            }
            
            // 重新获取最新的论坛标签
            await this.forum.fetch();
            const forumTags = this.forum.availableTags || [];
            console.log(`论坛可用标签数量: ${forumTags.length}`);
            console.log(`论坛标签列表:`, forumTags.map(tag => tag.name));
            
            const tagMap = new Map(forumTags.map(tag => [tag.name, tag.id]));
            
            // 找到匹配的标签ID
            const tagIds = threadTags
                .map(tagName => {
                    const tagId = tagMap.get(tagName);
                    console.log(`标签 "${tagName}" -> ID: ${tagId}`);
                    return tagId;
                })
                .filter(tagId => tagId !== undefined);
            
            console.log(`匹配到的标签ID:`, tagIds);
            
            if (tagIds.length > 0) {
                console.log(`准备应用 ${tagIds.length} 个标签到帖子`);
                await thread.setAppliedTags(tagIds);
                console.log(`✅ 成功为帖子 ${thread.name} 添加了 ${tagIds.length} 个标签: ${threadTags.join(', ')}`);
            } else {
                console.log(`❌ 帖子 ${originalThreadId} 的标签在论坛中不存在: ${threadTags.join(', ')}`);
            }
            
            console.log(`====== 标签应用详细调试结束 ======`);
            
        } catch (error) {
            console.error(`❌ 为帖子添加标签失败: ${originalThreadId}`, error);
            console.error('错误详情:', error.stack);
        }
    }
}

module.exports = TagManager; 