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
                
                // 2. 准备帖子内容（简化版，用于创建帖子）
                const initialContent = await this.prepareInitialContent(post);
                
                // 3. 创建论坛帖子（使用简化内容）
                const forumPost = await targetForumChannel.threads.create({
                    name: post.title,
                    message: {
                        content: initialContent.content,
                        files: initialContent.files
                    },
                    appliedTags: tagIds,
                    reason: '论坛重建'
                });
                
                // 短暂延迟确保帖子创建完成
                await this.delay(2000);
                
                // 4. 编辑首条消息为完整内容
                await this.editFirstMessage(forumPost, post);
                
                // 5. 立即归档帖子以释放活跃线程数
                await this.archiveThread(forumPost);
                
                // 6. 设置重建结果
                post.setRebuildResult({
                    newForumId: targetForumChannel.id,
                    newPostId: forumPost.id,
                    status: 'success'
                });
                
                console.log(`✅ 帖子重建并归档成功: ${post.title} (${forumPost.id})`);
                
                // 修复：返回正确的结构，包含postId字段
                return { 
                    success: true, 
                    postId: forumPost.id,  // 添加这个字段
                    post: forumPost 
                };
                
            } catch (error) {
                console.error(`❌ 帖子重建失败 (尝试 ${attempt}/${this.maxRetries}): ${post.title}`, error);
                
                // 检查是否是频率限制错误
                if (error.code === 429 || error.message.includes('rate limit')) {
                    const retryAfter = error.retryAfter || 60;
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
    
    async archiveThread(forumPost) {
        try {
            console.log(`📁 正在归档帖子: ${forumPost.name}`);
            
            // 设置线程为已归档状态
            await forumPost.setArchived(true, '论坛重建完成，自动归档以释放活跃线程数');
            
            console.log(`✅ 帖子已成功归档: ${forumPost.name}`);
            
        } catch (error) {
            console.error(`⚠️ 归档帖子失败: ${forumPost.name}`, error);
            // 归档失败不影响重建成功，只记录错误
            console.log(`💡 提示: 帖子重建成功但归档失败，可能需要手动归档`);
        }
    }
    
    async prepareInitialContent(post) {
        // 创建帖子时使用的简化内容（避免长度问题）
        try {
            let content = post.content || '📝 正在重建帖子内容...';
            const files = [];
            
            // 临时注释掉图片处理功能
            /*
            const imageUrls = post.getImageUrls();
            if (imageUrls.length > 0) {
                const downloadedImages = await this.imageHandler.downloadImages(imageUrls);
                files.push(...downloadedImages);
            }
            */
            
            // 如果内容太长，先截断
            if (content.length > 1500) {
                content = content.substring(0, 1500) + '... (重建中)';
            }
            
            return { content, files };
            
        } catch (error) {
            console.error('准备初始内容失败:', error);
            return { 
                content: '📝 重建的帖子内容', 
                files: []
            };
        }
    }
    
    async editFirstMessage(forumPost, originalPost) {
        try {
            console.log('📝 开始编辑首条消息为完整内容');
            
            // 获取第一条消息
            const messages = await forumPost.messages.fetch({ limit: 1 });
            const firstMessage = messages.first();
            
            if (!firstMessage) {
                console.log('⚠️ 找不到首条消息');
                return;
            }
            
            // 准备完整的消息内容（包含分割信息）
            const contentData = await this.prepareFullContent(originalPost);
            
            // 编辑首条消息
            await firstMessage.edit({
                content: contentData.firstMessageContent,
                files: contentData.files || []
            });
            
            console.log('✅ 成功编辑首条消息');
            
            // 如果有续发内容，发送额外消息
            if (contentData.continuationMessages && contentData.continuationMessages.length > 0) {
                console.log(`📨 发送 ${contentData.continuationMessages.length} 条续发消息`);
                
                for (let i = 0; i < contentData.continuationMessages.length; i++) {
                    await this.delay(500); // 消息间短暂延迟
                    
                    await forumPost.send({
                        content: contentData.continuationMessages[i]
                    });
                    
                    console.log(`✅ 发送续发消息 ${i + 1}/${contentData.continuationMessages.length}`);
                }
                
                console.log(`📝 所有续发消息发送完成`);
            }
            
        } catch (error) {
            console.error('编辑首条消息失败:', error);
            // 编辑失败时，尝试发送补充消息
            try {
                await this.sendSupplementaryMessage(forumPost, originalPost);
            } catch (supplementError) {
                console.error('发送补充消息也失败:', supplementError);
            }
        }
    }
    
    async prepareFullContent(post) {
        try {
            const originalContent = post.content || '';
            
            // 构建固定的头部信息
            const headerParts = [
                `👤 **原发帖人：** <@${post.authorId}>`,
                `📅 **原发布时间：** ${post.publishTime}`
            ];
            
            if (post.messageCount > 0) {
                headerParts.push(`💬 **原消息数：** ${post.messageCount}`);
            }
            
            if (post.reactionCount > 0) {
                headerParts.push(`👍 **原反应数：** ${post.reactionCount}`);
            }
            
            headerParts.push(''); // 空行
            headerParts.push('---'); // 分隔线
            headerParts.push(''); // 空行
            
            // 构建固定的底部信息
            const footerParts = [
                '',
                '---',
                `🔄 **重建信息**`,
                `🆔 原帖ID: ${post.originalPostId}`,
                `⏰ 重建时间: ${new Date().toLocaleString('zh-CN')}`,
                `📁 状态: 自动归档以释放活跃线程数`
            ];
            
            const headerText = headerParts.join('\n');
            const footerText = footerParts.join('\n');
            
            // 计算可用于原始内容的字符数
            const reservedLength = headerText.length + footerText.length + 50; // 50字符缓冲
            const availableLength = 2000 - reservedLength;
            
            console.log(`📏 内容长度计算: 原始=${originalContent.length}, 可用=${availableLength}, 保留=${reservedLength}`);
            
            if (originalContent.length <= availableLength) {
                // 内容不超长，直接合并
                const fullContent = headerText + originalContent + footerText;
                
                return {
                    firstMessageContent: fullContent,
                    continuationMessages: [],
                    files: []
                };
                
            } else {
                // 内容超长，需要分割
                console.log(`⚠️ 内容超长，进行分割处理`);
                
                // 首条消息包含头部 + 部分原始内容 + 续接提示 + 底部
                const firstPartLength = availableLength - 100; // 为续接提示预留空间
                const firstPart = originalContent.substring(0, firstPartLength);
                
                const continuationHint = '\n\n📄 **内容较长，续接在下方消息中...**';
                const firstMessageContent = headerText + firstPart + continuationHint + footerText;
                
                // 将剩余内容分割成多条消息
                const remainingContent = originalContent.substring(firstPartLength);
                const continuationMessages = this.splitIntoMessages(remainingContent);
                
                return {
                    firstMessageContent,
                    continuationMessages,
                    files: []
                };
            }
            
        } catch (error) {
            console.error('准备完整内容失败:', error);
            return { 
                firstMessageContent: `👤 **原发帖人：** <@${post.authorId}>\n📅 **时间：** ${post.publishTime}\n\n${post.content || '📝 重建的帖子内容'}\n\n🔄 重建于 ${new Date().toLocaleString('zh-CN')}\n📁 状态: 自动归档`,
                continuationMessages: [],
                files: []
            };
        }
    }
    
    splitIntoMessages(content) {
        const messages = [];
        const maxMessageLength = 1900; // 留100字符缓冲
        
        let remainingContent = content;
        let messageIndex = 1;
        
        while (remainingContent.length > 0) {
            let messageContent;
            
            if (remainingContent.length <= maxMessageLength - 50) {
                // 最后一条消息
                messageContent = `📄 **续接内容 (${messageIndex}/${messageIndex}) - 完**\n\n${remainingContent}`;
                remainingContent = '';
            } else {
                // 中间的消息
                const cutPoint = this.findGoodCutPoint(remainingContent, maxMessageLength - 100);
                const chunk = remainingContent.substring(0, cutPoint);
                messageContent = `📄 **续接内容 (${messageIndex}) - 继续**\n\n${chunk}`;
                remainingContent = remainingContent.substring(cutPoint);
                messageIndex++;
            }
            
            messages.push(messageContent);
        }
        
        // 更新消息头部显示总数
        for (let i = 0; i < messages.length; i++) {
            messages[i] = messages[i].replace(
                `📄 **续接内容 (${i + 1})`,
                `📄 **续接内容 (${i + 1}/${messages.length})`
            );
        }
        
        return messages;
    }
    
    findGoodCutPoint(content, maxLength) {
        // 尝试在合适的位置切断（句号、换行等）
        if (content.length <= maxLength) {
            return content.length;
        }
        
        // 寻找最近的句号
        let cutPoint = content.lastIndexOf('。', maxLength);
        if (cutPoint > maxLength * 0.7) { // 如果切点不太靠前
            return cutPoint + 1;
        }
        
        // 寻找最近的换行
        cutPoint = content.lastIndexOf('\n', maxLength);
        if (cutPoint > maxLength * 0.7) {
            return cutPoint + 1;
        }
        
        // 寻找最近的空格
        cutPoint = content.lastIndexOf(' ', maxLength);
        if (cutPoint > maxLength * 0.8) {
            return cutPoint + 1;
        }
        
        // 如果都找不到合适的切点，就硬切
        return maxLength;
    }
    
    async sendSupplementaryMessage(forumPost, originalPost) {
        try {
            const supplementContent = `📋 **补充信息**\n` +
                `由于首条消息编辑失败，此为补充信息：\n` +
                `👤 原发帖人: <@${originalPost.authorId}>\n` +
                `📅 原发布时间: ${originalPost.publishTime}\n` +
                `🆔 原帖ID: ${originalPost.originalPostId}`;
            
            await forumPost.send({ content: supplementContent });
            console.log('✅ 发送了补充信息消息');
            
        } catch (error) {
            console.error('发送补充消息失败:', error);
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
        info.push(`📁 状态: 自动归档`);
        
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
            if (!permissions.has(['SendMessages', 'CreatePublicThreads', 'ManageWebhooks', 'ManageThreads'])) {
                throw new Error('机器人在目标论坛缺少必要权限（需要管理线程权限进行归档）');
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