const { ChannelType } = require('discord.js');

class TagManager {
    constructor() {
        this.createdTags = new Map(); // 缓存已创建的tag
    }
    
    async getAllTagsFromPosts(posts) {
        const allTags = new Set();
        
        posts.forEach(post => {
            post.tags.forEach(tag => {
                if (tag && tag.trim()) {
                    allTags.add(tag.trim());
                }
            });
        });
        
        return Array.from(allTags);
    }
    
    async createTagsInForum(forumChannel, tags) {
        const createdTags = [];
        const errors = [];
        
        try {
            // 获取现有的tags
            const existingTags = await this.getExistingTags(forumChannel);
            const existingTagNames = existingTags.map(tag => tag.name.toLowerCase());
            
            for (const tagName of tags) {
                try {
                    // 检查tag是否已存在
                    if (existingTagNames.includes(tagName.toLowerCase())) {
                        console.log(`标签已存在，跳过: ${tagName}`);
                        const existingTag = existingTags.find(tag => 
                            tag.name.toLowerCase() === tagName.toLowerCase()
                        );
                        this.createdTags.set(tagName.toLowerCase(), existingTag.id);
                        continue;
                    }
                    
                    // 创建新tag
                    const newTag = await forumChannel.setAvailableTags([
                        ...forumChannel.availableTags,
                        {
                            name: tagName,
                            moderated: false,
                            emoji: this.getTagEmoji(tagName)
                        }
                    ]);
                    
                    // 获取新创建的tag ID
                    const createdTag = forumChannel.availableTags.find(tag => 
                        tag.name === tagName
                    );
                    
                    if (createdTag) {
                        this.createdTags.set(tagName.toLowerCase(), createdTag.id);
                        createdTags.push(tagName);
                        console.log(`✅ 创建标签: ${tagName}`);
                    }
                    
                    // 添加延迟避免频率限制
                    await this.delay(1000);
                    
                } catch (error) {
                    console.error(`创建标签失败 ${tagName}:`, error);
                    errors.push({ tag: tagName, error: error.message });
                }
            }
            
        } catch (error) {
            console.error('获取现有标签失败:', error);
            throw error;
        }
        
        return { createdTags, errors };
    }
    
    async getExistingTags(forumChannel) {
        try {
            // 刷新频道数据以获取最新的tags
            await forumChannel.fetch();
            return forumChannel.availableTags || [];
        } catch (error) {
            console.error('获取现有标签失败:', error);
            return [];
        }
    }
    
    getTagIds(tagNames, forumChannel) {
        const tagIds = [];
        
        tagNames.forEach(tagName => {
            const tagId = this.createdTags.get(tagName.toLowerCase());
            if (tagId) {
                tagIds.push(tagId);
            } else {
                // 尝试从论坛的availableTags中查找
                const existingTag = forumChannel.availableTags.find(tag => 
                    tag.name.toLowerCase() === tagName.toLowerCase()
                );
                if (existingTag) {
                    tagIds.push(existingTag.id);
                    this.createdTags.set(tagName.toLowerCase(), existingTag.id);
                }
            }
        });
        
        return tagIds;
    }
    
    getTagEmoji(tagName) {
        // 根据tag名称返回合适的emoji
        const emojiMap = {
            '纯爱': '💕',
            '原创': '✨',
            '女性向': '👩',
            '男性向': '👨',
            '剧情': '📖',
            '短篇': '📝',
            '长篇': '📚',
            '连载': '🔄',
            '完结': '✅',
            'BL': '👨‍❤️‍👨',
            'GL': '👩‍❤️‍👩',
            'NL': '👫'
        };
        
        return emojiMap[tagName] || null;
    }
    
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = TagManager; 