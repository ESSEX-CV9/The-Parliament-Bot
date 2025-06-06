const WebhookManager = require('./webhookManager');
const MessageProcessor = require('./messageProcessor');
const { delay } = require('../utils/fileManager');

class ThreadRebuilder {
    constructor(targetForum, useWebhook = true) {
        this.targetForum = targetForum;
        this.useWebhook = useWebhook;
        this.webhookManager = new WebhookManager(targetForum);
        this.messageProcessor = new MessageProcessor();
        this.messageIdMap = new Map(); // 原消息ID -> 新消息ID的映射
    }
    
    /**
     * 重建整个帖子
     */
    async rebuildThread(threadData, progressCallback = null) {
        try {
            // 保存当前线程数据，供回复查找使用
            this.currentThreadData = threadData;
            
            if (progressCallback) await progressCallback('正在创建帖子...');
            
            // 1. 创建帖子主题
            const thread = await this.createThread(threadData.threadInfo);
            
            if (progressCallback) await progressCallback('正在处理消息...');
            
            // 2. 准备Webhook（如果需要）
            if (this.useWebhook) {
                await this.webhookManager.initialize();
            }
            
            // 3. 按顺序处理所有消息
            let processedCount = 0;
            const totalMessages = threadData.messages.length;
            
            for (const message of threadData.messages) {
                try {
                    if (progressCallback) {
                        await progressCallback(`正在发送消息 ${processedCount + 1}/${totalMessages}`);
                    }
                    
                    const newMessage = await this.processMessage(thread, message);
                    
                    // 记录消息ID映射 - 这很重要！
                    if (newMessage && message.messageId) {
                        this.messageIdMap.set(message.messageId, newMessage.id);
                        console.log(`消息ID映射: ${message.messageId} -> ${newMessage.id}`);
                    }
                    
                    processedCount++;
                    
                    // 消息间延迟，避免速率限制
                    await delay(500);
                    
                } catch (error) {
                    console.error(`处理消息失败 (${message.messageId}):`, error);
                    // 继续处理下一条消息
                }
            }
            
            // 清理数据引用
            this.currentThreadData = null;
            
            return {
                success: true,
                threadId: thread.id,
                threadUrl: `https://discord.com/channels/${thread.guild.id}/${thread.id}`,
                messagesProcessed: processedCount,
                totalMessages: totalMessages
            };
            
        } catch (error) {
            this.currentThreadData = null;
            throw new Error(`重建帖子失败: ${error.message}`);
        }
    }
    
    /**
     * 创建帖子主题
     */
    async createThread(threadInfo) {
        const threadTitle = threadInfo.title || '未命名帖子';
        
        // 创建初始帖子消息
        const initialMessage = `**📋 帖子信息**\n` +
            `**标题:** ${threadTitle}\n` +
            `**原始创建时间:** ${threadInfo.createdAt || '未知'}\n` +
            `**总消息数:** ${threadInfo.totalMessages || 0}\n` +
            `**参与人数:** ${threadInfo.participants || 0}\n\n` +
            `*此帖子由系统从备份重建*`;
        
        const thread = await this.targetForum.threads.create({
            name: threadTitle,
            message: {
                content: initialMessage
            }
        });
        
        return thread;
    }
    
    /**
     * 处理单条消息
     */
    async processMessage(thread, message) {
        try {
            // 根据消息类型处理
            switch (message.messageType) {
                case 'normal':
                    return await this.sendNormalMessage(thread, message);
                
                case 'reply':
                    return await this.sendReplyMessage(thread, message);
                
                case 'system_notification':
                    return await this.sendSystemMessage(thread, message);
                
                case 'thread_update':
                    return await this.sendThreadUpdateMessage(thread, message);
                
                default:
                    console.warn(`未知消息类型: ${message.messageType}`);
                    return await this.sendNormalMessage(thread, message);
            }
        } catch (error) {
            console.error(`发送消息失败:`, error);
            throw error;
        }
    }
    
    /**
     * 安全地解析时间戳
     */
    parseTimestamp(timestamp) {
        if (!timestamp || timestamp === '未知时间' || timestamp.trim() === '') {
            return null;
        }
        
        try {
            // 尝试多种时间戳格式
            let date;
            
            // 如果是数字类型的时间戳
            if (typeof timestamp === 'number') {
                date = new Date(timestamp);
            }
            // 如果是字符串
            else if (typeof timestamp === 'string') {
                const trimmedTimestamp = timestamp.trim();
                
                // 处理中文日期格式：2024年8月8日星期四 00:51
                const chineseDateMatch = trimmedTimestamp.match(/(\d{4})年(\d{1,2})月(\d{1,2})日.*?(\d{1,2}):(\d{1,2})/);
                if (chineseDateMatch) {
                    const [, year, month, day, hour, minute] = chineseDateMatch;
                    date = new Date(
                        parseInt(year),
                        parseInt(month) - 1, // 月份从0开始
                        parseInt(day),
                        parseInt(hour),
                        parseInt(minute)
                    );
                    console.log(`成功解析中文时间戳: ${trimmedTimestamp} -> ${date.toISOString()}`);
                }
                // 尝试直接解析
                else {
                    date = new Date(trimmedTimestamp);
                    
                    // 如果解析失败，尝试其他格式
                    if (isNaN(date.getTime())) {
                        // 尝试解析Discord的时间戳格式 (ISO 8601)
                        const isoMatch = trimmedTimestamp.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
                        if (isoMatch) {
                            date = new Date(isoMatch[1]);
                        }
                        // 尝试解析Unix时间戳
                        else if (/^\d+$/.test(trimmedTimestamp)) {
                            const unixTime = parseInt(trimmedTimestamp);
                            // 检查是否是毫秒时间戳（长度为13位）还是秒时间戳（长度为10位）
                            date = new Date(unixTime.toString().length === 10 ? unixTime * 1000 : unixTime);
                        }
                    }
                }
            }
            
            // 验证日期是否有效
            if (!date || isNaN(date.getTime())) {
                console.warn(`无法解析时间戳: ${timestamp}`);
                return null;
            }
            
            return date;
        } catch (error) {
            console.warn(`解析时间戳失败: ${timestamp}`, error);
            return null;
        }
    }
    
    /**
     * 格式化时间戳为可读字符串
     */
    formatTimestamp(timestamp) {
        const date = this.parseTimestamp(timestamp);
        if (!date) {
            return timestamp || '未知时间'; // 返回原始时间戳或默认值
        }
        
        try {
            // 返回本地时间格式
            return date.toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
        } catch (error) {
            return timestamp || '时间格式错误';
        }
    }
    
    /**
     * 发送普通消息
     */
    async sendNormalMessage(thread, message) {
        const messageContent = this.messageProcessor.formatMessage(message);
        const formattedTime = this.formatTimestamp(message.timestamp);
        
        // 确保内容不为空
        if (!messageContent.content || messageContent.content.trim() === '') {
            console.warn(`消息内容为空，使用默认内容: ${message.messageId}`);
            messageContent.content = '[空消息内容]';
        }
        
        // 特殊处理纯emoji消息
        if (messageContent.isEmojiMessage) {
            console.log(`发送纯emoji消息: ${message.messageId}`);
            
            if (this.useWebhook && message.author.userId) {
                try {
                    return await this.webhookManager.sendAsUser(
                        thread, 
                        message.author, 
                        {
                            content: messageContent.content,
                            files: messageContent.files
                        }
                    );
                } catch (error) {
                    console.error(`Webhook发送emoji消息失败，尝试使用BOT发送:`, error);
                    // 回退到BOT模式
                    return await thread.send({
                        content: `**${message.author.displayName || message.author.username}** (${formattedTime})\n${messageContent.content}`,
                        files: messageContent.files
                    });
                }
            } else {
                // 使用BOT身份发送emoji消息
                return await thread.send({
                    content: `**${message.author.displayName || message.author.username}** (${formattedTime})\n${messageContent.content}`,
                    files: messageContent.files
                });
            }
        }
        
        // 普通消息处理
        if (this.useWebhook && message.author.userId) {
            // 使用Webhook模拟原作者
            try {
                return await this.webhookManager.sendAsUser(
                    thread, 
                    message.author, 
                    messageContent
                );
            } catch (error) {
                console.error(`Webhook发送失败，尝试使用BOT发送:`, error);
                // 如果Webhook失败，回退到BOT模式
                const content = `**${message.author.displayName || message.author.username}** (${formattedTime})\n${messageContent.content}`;
                return await thread.send({
                    content: content,
                    files: messageContent.files
                });
            }
        } else {
            // 使用BOT身份发送，添加作者信息
            const content = `**${message.author.displayName || message.author.username}** (${formattedTime})\n${messageContent.content}`;
            
            return await thread.send({
                content: content,
                files: messageContent.files
            });
        }
    }
    
    /**
     * 生成Discord消息链接
     */
    generateMessageLink(thread, messageId) {
        return `https://discord.com/channels/${thread.guild.id}/${thread.id}/${messageId}`;
    }
    
    /**
     * 截取消息内容前N个字符，用于引用显示
     */
    truncateContent(content, maxLength = 15) {
        if (!content || content.trim() === '') {
            return '[空消息]';
        }
        
        // 检查是否是emoji URL消息
        if (content.includes('cdn.discordapp.com/emojis/')) {
            return '[表情包]';
        }
        
        // 移除markdown格式和特殊字符，只保留纯文本
        let cleanContent = content
            // 移除作者信息（如果有）
            .replace(/^\*\*.*?\*\*\s*\(.*?\)\n/, '')
            // 移除各种markdown格式
            .replace(/\*\*(.*?)\*\*/g, '$1')     // 移除粗体
            .replace(/\*(.*?)\*/g, '$1')         // 移除斜体
            .replace(/`(.*?)`/g, '$1')           // 移除行内代码
            .replace(/```[\s\S]*?```/g, '[代码块]') // 移除代码块
            .replace(/~~(.*?)~~/g, '$1')         // 移除删除线
            .replace(/> -# .*?\n?/g, '')         // 移除已存在的引用
            .replace(/> .*?\n?/g, '')            // 移除引用块
            .replace(/\n+/g, ' ')                // 将换行替换为空格
            .replace(/\s+/g, ' ')                // 合并多个空格
            .replace(/^\s*\[.*?\]\s*/, '')       // 移除开头的方括号内容（如[空消息]）
            .replace(/\s*\(edited\)\s*$/i, '')   // 移除结尾的(edited)
            .trim();
        
        // 如果清理后为空，返回默认文本
        if (!cleanContent) {
            return '[无文本内容]';
        }
        
        // 截取指定长度
        if (cleanContent.length <= maxLength) {
            return cleanContent;
        }
        
        return cleanContent.substring(0, maxLength) + '...';
    }
    
    /**
     * 从原始JSON数据中查找被回复的消息内容
     */
    findOriginalReplyContent(replyToMessageId, allMessages) {
        if (!replyToMessageId || !allMessages) {
            return '[无法找到原消息]';
        }
        
        const originalMessage = allMessages.find(msg => msg.messageId === replyToMessageId);
        if (originalMessage) {
            const content = originalMessage.content?.markdown || originalMessage.content?.text || '';
            return this.truncateContent(content, 15);
        }
        
        return '[原消息不存在]';
    }
    
    /**
     * 发送回复消息
     */
    async sendReplyMessage(thread, message) {
        const messageContent = this.messageProcessor.formatMessage(message);
        const formattedTime = this.formatTimestamp(message.timestamp);
        
        // 确保内容不为空
        if (!messageContent.content || messageContent.content.trim() === '') {
            console.warn(`回复消息内容为空，使用默认内容: ${message.messageId}`);
            messageContent.content = '[空回复内容]';
        }
        
        // 生成回复引用
        let replyQuote = '';
        
        if (message.replyTo && message.replyTo.messageId) {
            const originalReplyId = message.replyTo.messageId;
            
            // 1. 先从原始JSON数据中获取被回复消息的内容
            let replyContent = this.findOriginalReplyContent(originalReplyId, this.currentThreadData.messages);
            
            // 2. 查找被回复消息在新帖子中对应的消息ID
            const newReplyMessageId = this.messageIdMap.get(originalReplyId);
            
            if (newReplyMessageId) {
                // 如果找到了新的消息ID，生成链接
                const messageLink = this.generateMessageLink(thread, newReplyMessageId);
                replyQuote = `> -# [${replyContent}](${messageLink})\n`;
                console.log(`生成回复引用: 原ID=${originalReplyId}, 新ID=${newReplyMessageId}, 内容="${replyContent}"`);
            } else {
                // 如果没有找到对应的新消息ID，只显示内容（无链接）
                replyQuote = `> -# [${replyContent}]()\n`;
                console.warn(`未找到回复消息的新ID映射: 原ID=${originalReplyId}`);
            }
        }
        
        if (this.useWebhook && message.author.userId) {
            // 使用Webhook发送回复
            const content = replyQuote + messageContent.content;
                
            try {
                return await this.webhookManager.sendAsUser(
                    thread,
                    message.author,
                    { ...messageContent, content }
                );
            } catch (error) {
                console.error(`Webhook回复发送失败，尝试使用BOT发送:`, error);
                // 回退到BOT模式
                const botContent = `**${message.author.displayName || message.author.username}** (${formattedTime})\n${replyQuote}${messageContent.content}`;
                
                return await thread.send({
                    content: botContent,
                    files: messageContent.files
                });
            }
        } else {
            // 使用BOT身份发送回复
            const botContent = `**${message.author.displayName || message.author.username}** (${formattedTime})\n${replyQuote}${messageContent.content}`;
            
            const options = {
                content: botContent,
                files: messageContent.files
            };
            
            return await thread.send(options);
        }
    }
    
    /**
     * 发送系统消息
     */
    async sendSystemMessage(thread, message) {
        const formattedTime = this.formatTimestamp(message.timestamp);
        const content = `🔔 **系统通知** (${formattedTime})\n` +
            `${message.content.text || '系统消息'}`;
        
        const embedOptions = {
            color: 0x5865F2,
            description: message.content.text || '系统消息'
        };
        
        // 只有当时间戳有效时才添加timestamp字段
        const parsedDate = this.parseTimestamp(message.timestamp);
        if (parsedDate) {
            try {
                embedOptions.timestamp = parsedDate.toISOString();
            } catch (error) {
                console.warn('时间戳转换为ISO格式失败:', error);
                // 不添加timestamp字段
            }
        }
        
        return await thread.send({
            content: content,
            embeds: [embedOptions]
        });
    }
    
    /**
     * 发送线程更新消息
     */
    async sendThreadUpdateMessage(thread, message) {
        const formattedTime = this.formatTimestamp(message.timestamp);
        const content = `⚙️ **帖子更新** (${formattedTime})\n` +
            `${message.content.text || '帖子已更新'}`;
        
        const embedOptions = {
            color: 0xFEE75C,
            description: message.content.text || '帖子已更新'
        };
        
        // 只有当时间戳有效时才添加timestamp字段
        const parsedDate = this.parseTimestamp(message.timestamp);
        if (parsedDate) {
            try {
                embedOptions.timestamp = parsedDate.toISOString();
            } catch (error) {
                console.warn('时间戳转换为ISO格式失败:', error);
                // 不添加timestamp字段
            }
        }
        
        return await thread.send({
            content: content,
            embeds: [embedOptions]
        });
    }
}

module.exports = ThreadRebuilder; 