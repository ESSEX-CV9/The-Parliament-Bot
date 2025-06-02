const { ChannelType, AttachmentBuilder } = require('discord.js');
const TagManager = require('./tagManager');
const WebhookManager = require('./webhookManager');
const ImageHandler = require('../utils/imageHandler');
const config = require('../config/config');

class PostRebuilder {
    constructor(client) {
        this.client = client;
        this.tagManager = new TagManager();
        this.webhookManager = new WebhookManager();
        this.imageHandler = new ImageHandler();
        this.retryCount = 0;
        this.maxRetries = 3;
    }
    
    async rebuildPost(post, targetForumChannel) {
        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                console.log(`🔄 开始重建帖子 (尝试 ${attempt}/${this.maxRetries}): ${post.title}`);
                
                // 1. 获取标签ID
                const tagIds = this.tagManager.getTagIds(post.tags, targetForumChannel);
                
                // 2. 准备帖子内容
                const postContent = await this.preparePostContent(post);
                
                // 3. 创建论坛帖子
                const forumPost = await targetForumChannel.threads.create({
                    name: post.title,
                    message: {
                        content: postContent.content,
                        files: postContent.files
                    },
                    appliedTags: tagIds,
                    reason: '论坛重建'
                });
                
                // 短暂延迟确保帖子创建完成
                await this.delay(2000);
                
                // 4. 尝试模拟原发帖人发送消息
                if (post.authorId && postContent.originalContent) {
                    await this.attemptUserSimulation(forumPost, post, postContent);
                }
                
                // 5. 设置重建结果
                post.setRebuildResult({
                    newForumId: targetForumChannel.id,
                    newPostId: forumPost.id,
                    status: 'success'
                });
                
                console.log(`✅ 帖子重建成功: ${post.title} (${forumPost.id})`);
                return { success: true, post: forumPost };
                
            } catch (error) {
                console.error(`❌ 帖子重建失败 (尝试 ${attempt}/${this.maxRetries}): ${post.title}`, error);
                
                // 检查是否是频率限制错误
                if (error.code === 429 || error.message.includes('rate limit')) {
                    const retryAfter = error.retryAfter || 60; // Discord通常会告诉我们要等多久
                    console.log(`⚠️ 频率限制，等待 ${retryAfter} 秒后重试...`);
                    await this.delay(retryAfter * 1000);
                    
                    if (attempt < this.maxRetries) {
                        continue; // 重试
                    }
                }
                
                // 其他错误或最后一次尝试失败
                if (attempt === this.maxRetries) {
                    post.setRebuildResult({
                        newForumId: targetForumChannel.id,
                        newPostId: null,
                        status: 'failed',
                        error: error.message
                    });
                    
                    return { success: false, error: error.message };
                }
                
                // 非频率限制错误，等待后重试
                console.log(`⏱️ 等待 ${5000 * attempt} 毫秒后重试...`);
                await this.delay(5000 * attempt);
            }
        }
    }
    
    async preparePostContent(post) {
        try {
            let content = post.content || '';
            const files = [];
            
            // 处理图片 (现在会自动跳过失败的图片)
            // const imageUrls = post.getImageUrls();
            // if (imageUrls.length > 0) {
            //     console.log(`📷 处理 ${imageUrls.length} 个图片...`);
            //     const downloadedImages = await this.imageHandler.downloadImages(imageUrls);
            //     files.push(...downloadedImages);
                
            //     if (downloadedImages.length > 0) {
            //         console.log(`✅ 成功处理 ${downloadedImages.length} 个图片`);
            //     } else {
            //         console.log(`⚠️ 所有图片处理失败，将跳过图片`);
            //     }
                
            //     // 如果内容为空，添加图片说明
            //     if (!content.trim() && downloadedImages.length > 0) {
            //         content = '📸 重建的图片内容';
            //     }
            // }
            
            // 保存原始内容（用于Webhook）
            const originalContent = content;
            
            // 添加重建说明
            const rebuildInfo = this.generateRebuildInfo(post);
            content = `${content}\n\n${rebuildInfo}`;
            
            // 检查内容长度限制 (Discord限制2000字符)
            if (content.length > 1900) { // 留一些余量
                console.log(`⚠️ 内容过长 (${content.length} 字符)，进行截断`);
                
                // 保留原始内容的前1500字符，然后添加简化的重建信息
                const truncatedOriginal = originalContent.substring(0, 1500);
                const shortRebuildInfo = `\n\n📋 原帖ID: ${post.originalPostId} | 🔄 重建时间: ${new Date().toLocaleString('zh-CN')} | ⚠️ 内容已截断`;
                content = truncatedOriginal + shortRebuildInfo;
                
                // 再次检查长度
                if (content.length > 2000) {
                    content = content.substring(0, 1900) + '\n\n... (内容过长已截断)';
                }
            }
            
            return { content, files, originalContent };
            
        } catch (error) {
            console.error('准备帖子内容失败:', error);
            return { 
                content: `📝 重建的帖子内容\n\n📋 原帖ID: ${post.originalPostId}`, 
                files: [],
                originalContent: post.content || ''
            };
        }
    }
    
    async attemptUserSimulation(forumPost, originalPost, postContent) {
        try {
            console.log(`🎭 尝试模拟原发帖人: ${originalPost.authorId}`);
            
            // 获取第一条消息
            const messages = await forumPost.messages.fetch({ limit: 1 });
            const firstMessage = messages.first();
            
            if (!firstMessage) {
                console.log('⚠️ 找不到首条消息，跳过模拟');
                return;
            }
            
            // 尝试通过webhook发送模拟消息
            const webhookMessage = await this.webhookManager.sendAsUser(
                forumPost,
                originalPost.authorId,
                postContent.originalContent || postContent.content,
                this.client,
                { files: postContent.files }
            );
            
            if (webhookMessage) {
                // 成功发送模拟消息，删除原始消息
                try {
                    await firstMessage.delete();
                    console.log('✅ 成功模拟原发帖人，已替换首条消息');
                } catch (deleteError) {
                    console.log('⚠️ 模拟消息发送成功，但删除原消息失败:', deleteError.message);
                }
            } else {
                // Webhook失败，使用回退方案
                console.log('⚠️ Webhook模拟失败，使用机器人回退方案');
                await this.sendFallbackMessage(forumPost, originalPost, postContent);
            }
            
        } catch (error) {
            console.log(`⚠️ 模拟原发帖人失败: ${error.message}`);
            // 尝试回退方案
            try {
                await this.sendFallbackMessage(forumPost, originalPost, postContent);
            } catch (fallbackError) {
                console.log(`⚠️ 回退方案也失败: ${fallbackError.message}`);
            }
        }
    }
    
    async sendFallbackMessage(forumPost, originalPost, postContent) {
        try {
            // 如果有文件，发送额外消息包含文件
            if (postContent.files && postContent.files.length > 0) {
                await forumPost.send({
                    content: `📎 原帖附件 (原发帖人: <@${originalPost.authorId}>)`,
                    files: postContent.files
                });
                console.log('✅ 使用机器人发送了附件');
            }
            
            // 发送原发帖人信息
            const fallbackContent = `👤 **原发帖人信息**\n` +
                `发帖人: <@${originalPost.authorId}>\n` +
                `原发布时间: ${originalPost.publishTime}\n` +
                `原帖ID: ${originalPost.originalPostId}`;
            
            await forumPost.send({ content: fallbackContent });
            console.log('✅ 使用机器人发送了回退信息');
            
        } catch (error) {
            console.error('发送回退消息失败:', error);
        }
    }
    
    generateRebuildInfo(post) {
        const info = [];
        
        info.push(`\n📋 **原帖信息**`);
        info.push(`🆔 原帖子ID: ${post.originalPostId}`);
        info.push(`📅 原发布时间: ${post.publishTime}`);
        info.push(`👤 原发帖人: <@${post.authorId}>`);
        
        if (post.messageCount > 0) {
            info.push(`💬 原消息数: ${post.messageCount}`);
        }
        
        if (post.reactionCount > 0) {
            info.push(`👍 原反应数: ${post.reactionCount}`);
        }
        
        info.push(`🔄 重建时间: ${new Date().toLocaleString('zh-CN')}`);
        
        return info.join('\n');
    }
    
    async validateTargetForum(forumChannelId, guild) {
        try {
            const channel = await guild.channels.fetch(forumChannelId);
            
            if (!channel) {
                throw new Error('找不到指定的频道');
            }
            
            if (channel.type !== ChannelType.GuildForum) {
                throw new Error('指定的频道不是论坛频道');
            }
            
            // 检查机器人权限
            const permissions = channel.permissionsFor(guild.members.me);
            if (!permissions.has(['SendMessages', 'CreatePublicThreads', 'ManageWebhooks'])) {
                throw new Error('机器人在目标论坛缺少必要权限');
            }
            
            return channel;
            
        } catch (error) {
            console.error('验证目标论坛失败:', error);
            throw error;
        }
    }
    
    async cleanup(targetForumChannel) {
        try {
            await this.webhookManager.cleanup(targetForumChannel);
        } catch (error) {
            console.error('清理资源失败:', error);
        }
    }
    
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = PostRebuilder; 