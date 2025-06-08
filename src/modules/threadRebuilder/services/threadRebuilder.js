const WebhookManager = require('./webhookManager');
const MessageProcessor = require('./messageProcessor');
const ExcelReader = require('./excelReader');
const TagManager = require('./tagManager');
const { delay } = require('../utils/fileManager');

class ThreadRebuilder {
    constructor(targetForum, useWebhook = true) {
        this.targetForum = targetForum;
        this.useWebhook = useWebhook;
        this.webhookManager = new WebhookManager(targetForum);
        this.messageProcessor = new MessageProcessor();
        this.messageIdMap = new Map(); // 原消息ID -> 新消息ID的映射
        this.excelReader = null; // 改为null，由外部设置
        this.excelDataLoaded = false;
        this.tagManager = null; // 延迟初始化
        this.forumTagsCreated = false;
    }
    
    /**
     * 设置Excel读取器（由外部传入）
     */
    setExcelReader(excelReader) {
        this.excelReader = excelReader;
        if (excelReader) {
            this.tagManager = new TagManager(this.targetForum, this.excelReader);
        }
    }
    
    /**
     * 设置Excel数据加载状态
     */
    setExcelDataLoaded(loaded) {
        this.excelDataLoaded = loaded;
    }
    
    /**
     * 初始化Excel数据（保留，但改为检查是否已设置）
     */
    async initializeExcelData() {
        // 如果已经加载，直接返回
        if (this.excelDataLoaded) {
            console.log('Excel数据已加载，跳过重复初始化');
            return;
        }
        
        // 如果外部已设置ExcelReader但未标记为已加载，也跳过
        if (this.excelReader) {
            console.log('Excel读取器已由外部设置，跳过重复初始化');
            this.excelDataLoaded = true;
            return;
        }
        
        // 只有在完全没有Excel数据时才初始化
        try {
            console.log('开始初始化Excel数据...');
            this.excelReader = new ExcelReader();
            await this.excelReader.loadExcelData();
            this.tagManager = new TagManager(this.targetForum, this.excelReader);
            this.excelDataLoaded = true;
            console.log('Excel数据和标签管理器初始化完成');
        } catch (error) {
            console.warn('Excel数据初始化失败，将使用默认数据:', error);
            this.excelDataLoaded = false;
        }
    }
    
    /**
     * 创建论坛标签
     */
    async createForumTags() {
        if (this.tagManager) {
            await this.tagManager.createAllTags();
        }
    }
    
    /**
     * 重建帖子（支持断点重启）
     */
    async rebuildThread(threadData, progressCallback = null, resumeInfo = null) {
        try {
            // 确保Excel数据已加载（只在必要时加载）
            await this.initializeExcelData();
            
            const threadTitle = threadData.threadInfo.title;
            const originalThreadId = threadData.threadInfo.thread_id;
            console.log(`开始重建帖子: ${threadTitle}, 原始ID: ${originalThreadId}, Excel状态: ${this.excelDataLoaded}`);
            
            // 存储当前线程数据用于后续查找
            this.currentThreadData = threadData;
            this.timestampCache = threadData.timestampCache || new Map();
            this.messageIndex = threadData.messageIndex || new Map();
            
            console.log(`消息索引已加载，包含 ${this.messageIndex.size} 条消息`);
            
            let thread;
            let startMessageIndex = 0;
            
            // 检查是否需要从断点恢复
            if (resumeInfo && resumeInfo.canResume && resumeInfo.threadId) {
                console.log(`🔄 从断点恢复: 帖子ID ${resumeInfo.threadId}, 已处理 ${resumeInfo.processedMessages}/${resumeInfo.totalMessages} 条消息`);
                
                try {
                    // 尝试获取现有帖子
                    thread = await this.targetForum.threads.fetch(resumeInfo.threadId);
                    startMessageIndex = resumeInfo.lastProcessedMessageIndex + 1;
                    
                    console.log(`✅ 找到现有帖子: ${thread.name}, 从消息索引 ${startMessageIndex} 继续`);
                } catch (error) {
                    console.warn(`⚠️ 无法找到帖子 ${resumeInfo.threadId}, 将重新创建: ${error.message}`);
                    thread = null;
                    startMessageIndex = 0;
                }
            }
            
            // 如果没有现有帖子，创建新帖子
            if (!thread) {
                thread = await this.createThread(threadData.threadInfo);
                if (!thread) {
                    throw new Error('帖子创建失败');
                }
                startMessageIndex = 0;
                
                // 为新创建的帖子添加标签
                if (this.tagManager && threadData.threadInfo.thread_id) {
                    console.log(`====== 标签应用调试信息 ======`);
                    console.log(`开始为帖子添加标签: ${threadData.threadInfo.thread_id}`);
                    console.log(`TagManager存在: ${!!this.tagManager}`);
                    
                    try {
                        await this.tagManager.applyTagsToThread(thread, threadData.threadInfo.thread_id);
                        console.log(`✅ 标签应用完成`);
                    } catch (error) {
                        console.error(`❌ 标签应用失败:`, error);
                    }
                    console.log(`====== 标签应用调试信息结束 ======`);
                } else {
                    console.log(`⚠️ 跳过标签添加: tagManager=${!!this.tagManager}, thread_id=${threadData.threadInfo.thread_id}`);
                }
                
                // 通知进度跟踪器帖子已创建
                if (this.progressTracker && threadData.fileName) {
                    await this.progressTracker.updateThreadCreated(
                        threadData.fileName,
                        thread.id,
                        thread.name,
                        threadData.messages.length
                    );
                }
            }
            
            // 按消息ID排序
            const sortedMessages = [...threadData.messages].sort((a, b) => {
                return this.compareMessageIds(a.messageId, b.messageId);
            });
            
            console.log(`找到 ${sortedMessages.length} 条消息，从索引 ${startMessageIndex} 开始处理`);
            
            // 如果是断点恢复，需要重建已处理消息的ID映射
            if (startMessageIndex > 0) {
                await this.rebuildMessageIdMapping(thread, sortedMessages.slice(0, startMessageIndex));
            }
            
            // 分组消息 - 从指定位置开始
            const remainingMessages = sortedMessages.slice(startMessageIndex);
            
            if (remainingMessages.length === 0) {
                console.log(`✅ 所有消息已处理完成，无需继续处理`);
                return {
                    id: thread.id,
                    name: thread.name,
                    messagesProcessed: sortedMessages.length
                };
            }
            
            const messageGroups = this.groupConsecutiveMessages(remainingMessages);
            console.log(`剩余消息分为 ${messageGroups.length} 个组，共 ${remainingMessages.length} 条消息`);
            
            let processedCount = startMessageIndex;
            
            // 处理每个消息组
            for (let groupIndex = 0; groupIndex < messageGroups.length; groupIndex++) {
                const group = messageGroups[groupIndex];
                
                console.log(`处理第 ${groupIndex + 1} 组消息，包含 ${group.length} 条消息，用户: ${group[0].author.displayName || group[0].author.username}`);
                
                const firstMessageTimestamp = group[0].timestamp;
                
                // 处理组内的每条消息
                for (let messageIndex = 0; messageIndex < group.length; messageIndex++) {
                    const message = group[messageIndex];
                    const isLastInGroup = messageIndex === group.length - 1;
                    const globalMessageIndex = processedCount;
                    
                    console.log(`处理消息 ${messageIndex + 1}/${group.length} (${message.messageType}): ${message.messageId}`);
                    
                    try {
                        const sentMessage = await this.processMessage(thread, message, isLastInGroup, firstMessageTimestamp);
                        
                        // 处理反应
                        if (sentMessage && message.reactions && message.reactions.length > 0) {
                            await this.addReactions(sentMessage, message.reactions);
                        }
                        
                        processedCount++;
                        
                        // 更新进度跟踪器
                        if (this.progressTracker && threadData.fileName) {
                            await this.progressTracker.updateMessageProgress(
                                threadData.fileName,
                                message.messageId,
                                globalMessageIndex,
                                processedCount
                            );
                        }
                        
                        // 更新进度回调
                        if (progressCallback) {
                            progressCallback(processedCount, sortedMessages.length);
                        }
                        
                    } catch (error) {
                        console.error(`处理消息失败: ${message.messageId}`, error);
                        // 继续处理下一条消息
                    }
                    
                    // 消息间延迟
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
                
                // 组间延迟
                if (groupIndex < messageGroups.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
            }
            
            console.log(`帖子重建完成: ${thread.name}, 处理了 ${processedCount} 条消息`);
            return {
                id: thread.id,
                name: thread.name,
                messagesProcessed: processedCount
            };
            
        } catch (error) {
            console.error('重建帖子失败:', error);
            throw error;
        }
    }

    /**
     * 重建消息ID映射（用于断点恢复）
     */
    async rebuildMessageIdMapping(thread, processedMessages) {
        console.log(`🔄 重建消息ID映射，已处理 ${processedMessages.length} 条消息...`);
        
        try {
            // 获取帖子中的所有消息
            const existingMessages = await thread.messages.fetch({ limit: 100 });
            
            // 简单的重建策略：按时间顺序匹配
            // 这里可以根据需要实现更复杂的匹配逻辑
            let messageArray = Array.from(existingMessages.values()).reverse(); // 按时间正序
            
            for (let i = 0; i < Math.min(processedMessages.length, messageArray.length); i++) {
                const originalMessage = processedMessages[i];
                const newMessage = messageArray[i];
                
                if (originalMessage.messageId && newMessage.id) {
                    this.messageIdMap.set(originalMessage.messageId, newMessage.id);
                }
            }
            
            console.log(`✅ 重建了 ${this.messageIdMap.size} 个消息ID映射`);
            
        } catch (error) {
            console.warn(`⚠️ 重建消息ID映射失败，将继续处理: ${error.message}`);
        }
    }

    /**
     * 设置进度跟踪器
     */
    setProgressTracker(progressTracker) {
        this.progressTracker = progressTracker;
    }

    /**
     * 将连续的同用户消息分组
     */
    groupConsecutiveMessages(messages) {
        if (!messages || messages.length === 0) {
            return [];
        }
        
        const groups = [];
        let currentGroup = [messages[0]];
        
        for (let i = 1; i < messages.length; i++) {
            const currentMessage = messages[i];
            const lastMessage = currentGroup[currentGroup.length - 1];
            
            // 检查是否应该继续当前组
            const shouldContinueGroup = this.shouldContinueGroup(lastMessage, currentMessage);
            
            if (shouldContinueGroup) {
                currentGroup.push(currentMessage);
            } else {
                // 结束当前组，开始新组
                groups.push(currentGroup);
                currentGroup = [currentMessage];
            }
        }
        
        // 添加最后一组
        if (currentGroup.length > 0) {
            groups.push(currentGroup);
        }
        
        return groups;
    }
    
    /**
     * 判断是否应该继续当前消息组
     */
    shouldContinueGroup(lastMessage, currentMessage) {
        // 不同用户 - 不继续
        if (lastMessage.author.userId !== currentMessage.author.userId) {
            return false;
        }
        
        // 相同用户的情况下，以下情况可以继续组：
        // 1. 上一条是normal，当前是normal
        // 2. 上一条是reply，当前是normal
        // 3. 其他情况根据需要调整
        
        const lastType = lastMessage.messageType;
        const currentType = currentMessage.messageType;
        
        // 如果上一条是normal，当前也是normal - 继续组
        if (lastType === 'normal' && currentType === 'normal') {
            return true;
        }
        
        // 如果上一条是reply，当前是normal - 继续组
        if (lastType === 'reply' && currentType === 'normal') {
            return true;
        }
        
        // 其他情况 - 开始新组
        return false;
    }

    /**
     * 处理单条消息
     */
    async processMessage(thread, message, isLastInGroup = false, groupFirstMessageTimestamp = null) {
        let sentMessage = null;
        
        switch (message.messageType) {
            case 'normal':
                sentMessage = await this.sendNormalMessage(thread, message, isLastInGroup, groupFirstMessageTimestamp);
                break;
            
            case 'reply':
                sentMessage = await this.sendReplyMessage(thread, message, isLastInGroup, groupFirstMessageTimestamp);
                break;
            
            case 'system_message_add':
            case 'system_message_remove':
            case 'system_message_join':
            case 'system_message_leave':
            case 'system_message_boost':
            case 'system_message_follow':
            case 'system_message_pin':
            case 'system_message_unpin':
                sentMessage = await this.sendSystemMessage(thread, message, isLastInGroup, groupFirstMessageTimestamp);
                break;
            
            case 'thread_update':
                sentMessage = await this.sendThreadUpdateMessage(thread, message, isLastInGroup, groupFirstMessageTimestamp);
                break;
            
            default:
                console.warn(`未知消息类型: ${message.messageType}`);
                sentMessage = await this.sendNormalMessage(thread, message, isLastInGroup, groupFirstMessageTimestamp);
                break;
        }
        
        // 只有当消息成功发送时才记录ID映射
        if (sentMessage && sentMessage.id) {
            this.messageIdMap.set(message.messageId, sentMessage.id);
            console.log(`记录消息ID映射: ${message.messageId} -> ${sentMessage.id}`);
        } else if (sentMessage === null) {
            console.log(`消息被跳过，不记录ID映射: ${message.messageId}`);
        }
        
        return sentMessage;
    }

    /**
     * 格式化元数据行
     */
    formatMetadata(message, groupFirstMessageTimestamp = null) {
        const userId = message.author.userId || '未知';
        // 使用组首条消息的时间戳，如果没有则使用当前消息的时间戳
        const timestampToUse = groupFirstMessageTimestamp || message.timestamp;
        const formattedTimestamp = this.formatTimestampForMetadata(timestampToUse);
        return `> -# user_id:${userId} time_stamp:${formattedTimestamp}`;
    }
    
    /**
     * 格式化时间戳为可读字符串（使用缓存）
     */
    formatTimestamp(timestamp) {
        if (!timestamp || timestamp === '未知时间' || timestamp.trim() === '') {
            return '未知时间';
        }
        
        // 首先检查缓存
        const cached = this.timestampCache?.get(timestamp);
        if (cached) {
            return cached.formatted;
        }
        
        // 缓存未命中，使用原有逻辑
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
     * 格式化时间戳为元数据格式（使用缓存）
     */
    formatTimestampForMetadata(timestamp) {
        if (!timestamp || timestamp === '未知时间' || timestamp.trim() === '') {
            return '未知时间';
        }
        
        // 首先检查缓存
        const cached = this.timestampCache?.get(timestamp);
        if (cached) {
            return cached.metadataFormatted;
        }
        
        // 缓存未命中，使用原有逻辑
        const date = this.parseTimestamp(timestamp);
        if (!date) {
            return '未知时间';
        }
        
        try {
            const year = date.getFullYear();
            const month = (date.getMonth() + 1).toString().padStart(2, '0');
            const day = date.getDate().toString().padStart(2, '0');
            const hours = date.getHours().toString().padStart(2, '0');
            const minutes = date.getMinutes().toString().padStart(2, '0');
            const seconds = date.getSeconds().toString().padStart(2, '0');
            
            return `${year}/${month}/${day} - ${hours}:${minutes}:${seconds}`;
        } catch (error) {
            console.error('时间戳格式化失败:', error);
            return '时间格式错误';
        }
    }

    /**
     * 添加反应到消息 - 优化延迟
     */
    async addReactions(message, reactions) {
        if (!reactions || reactions.length === 0) return;
        
        console.log(`为消息 ${message.id} 添加 ${reactions.length} 个反应`);
        
        for (const reaction of reactions) {
            try {
                // 减少延迟：50ms
                await new Promise(resolve => setTimeout(resolve, 20));
                
                let emojiToReact = reaction.emoji;
                
                // 如果是自定义emoji，尝试使用emoji ID
                if (reaction.emojiUrl && reaction.emojiUrl.includes('cdn.discordapp.com/emojis/')) {
                    // 从URL中提取emoji ID
                    const emojiIdMatch = reaction.emojiUrl.match(/\/emojis\/(\d+)\./);
                    if (emojiIdMatch) {
                        emojiToReact = emojiIdMatch[1];
                    }
                }
                
                // 尝试添加反应
                await message.react(emojiToReact);
                console.log(`成功添加反应: ${reaction.emoji} (${reaction.count} 次)`);
                
            } catch (error) {
                console.warn(`添加反应失败: ${reaction.emoji}`, error.message);
                // 继续处理下一个反应
            }
        }
    }

    /**
     * 发送普通消息 - 优化延迟
     */
    async sendNormalMessage(thread, message, isLastInGroup = false, groupFirstMessageTimestamp = null) {
        const messageContent = this.messageProcessor.formatMessage(message);
        
        // 如果消息内容为空或只包含空白字符，跳过这条消息
        if (!messageContent.content || messageContent.content.trim() === '') {
            console.log(`跳过空消息: ${message.messageId} (可能因SVG emoji过滤)`);
            return null; // 返回null表示消息被跳过
        }
        
        const formattedTime = this.formatTimestamp(message.timestamp);
        
        console.log(`发送普通消息, ID: ${message.messageId}`);
        
        // 发送主消息
        let mainMessage;
        
        if (this.useWebhook && message.author.userId) {
            // 使用Webhook发送
            try {
                mainMessage = await this.webhookManager.sendAsUser(
                    thread,
                    message.author,
                    { 
                        content: messageContent.content,
                        files: messageContent.files
                    }
                );
            } catch (error) {
                console.error(`Webhook发送失败，尝试使用BOT发送:`, error);
                // 回退到BOT模式
                const botContent = `**${message.author.displayName || message.author.username}** (${formattedTime})\n${messageContent.content}`;
                
                mainMessage = await thread.send({
                    content: botContent,
                    files: messageContent.files
                });
            }
        } else {
            // 使用BOT身份发送
            const botContent = `**${message.author.displayName || message.author.username}** (${formattedTime})\n${messageContent.content}`;
            
            mainMessage = await thread.send({
                content: botContent,
                files: messageContent.files
            });
        }
        
        // 如果需要分离emoji，发送emoji消息
        if (messageContent.needsSeparation && messageContent.separateEmojis.length > 0) {
            console.log(`分离发送emoji: ${messageContent.separateEmojis.length} 个`);
            
            // 减少延迟：25ms
            await new Promise(resolve => setTimeout(resolve, 10));
            
            const emojiContent = messageContent.separateEmojis.join('\n');
            
            if (this.useWebhook && message.author.userId) {
                try {
                    await this.webhookManager.sendAsUser(
                        thread,
                        message.author,
                        {
                            content: emojiContent,
                            files: []
                        }
                    );
                } catch (error) {
                    console.error(`Webhook发送emoji失败，尝试使用BOT发送:`, error);
                    await thread.send({
                        content: emojiContent
                    });
                }
            } else {
                await thread.send({
                    content: emojiContent
                });
            }
        }
        
        // 如果是组中的最后一条消息，添加元数据
        if (isLastInGroup) {
            const metadata = this.formatMetadata(message, groupFirstMessageTimestamp);
            
            // 减少延迟：25ms
            await new Promise(resolve => setTimeout(resolve, 10));
            
            if (this.useWebhook && message.author.userId) {
                try {
                    await this.webhookManager.sendAsUser(
                        thread,
                        message.author,
                        {
                            content: metadata,
                            files: []
                        }
                    );
                } catch (error) {
                    console.error(`Webhook发送元数据失败，尝试使用BOT发送:`, error);
                    await thread.send({
                        content: metadata
                    });
                }
            } else {
                await thread.send({
                    content: metadata
                });
            }
        }
        
        return mainMessage;
    }

    /**
     * 发送回复消息 - 支持分离文字和emoji
     */
    async sendReplyMessage(thread, message, isLastInGroup = false, groupFirstMessageTimestamp = null) {
        const messageContent = this.messageProcessor.formatMessage(message);
        
        // 如果消息内容为空，跳过这条消息
        if (!messageContent.content || messageContent.content.trim() === '') {
            console.log(`跳过空回复消息: ${message.messageId} (可能因SVG emoji过滤)`);
            return null;
        }
        
        const formattedTime = this.formatTimestamp(message.timestamp);
        
        console.log(`\n=== 处理回复消息 ===`);
        console.log(`消息ID: ${message.messageId}`);
        console.log(`回复到 (replyTo): ${message.replyTo ? message.replyTo.messageId : '无'}`);
        console.log(`当前消息ID映射大小: ${this.messageIdMap.size}`);
        
        // 生成回复引用
        let replyQuote = '';
        
        // 使用正确的字段名 replyTo（标准化后的字段名）
        if (message.replyTo && message.replyTo.messageId) {
            const originalReplyId = message.replyTo.messageId;
            console.log(`原始被回复消息ID: ${originalReplyId}`);
            
            // 1. 先从原始JSON数据中获取被回复消息的内容
            let replyContent = this.findOriginalReplyContent(originalReplyId, this.currentThreadData.messages);
            console.log(`被回复消息内容: "${replyContent}"`);
            
            // 2. 查找被回复消息在新帖子中对应的消息ID
            const newReplyMessageId = this.messageIdMap.get(originalReplyId);
            console.log(`新消息ID映射: ${originalReplyId} -> ${newReplyMessageId || '未找到'}`);
            
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
        } else {
            console.log(`消息没有回复字段或回复ID为空`);
        }
        
        console.log(`最终回复引用: "${replyQuote}"`);
        console.log(`=== 回复消息处理完成 ===\n`);
        
        // 发送主回复消息
        let mainMessage;
        const mainContent = replyQuote + messageContent.content;
        
        if (this.useWebhook && message.author.userId) {
            // 使用Webhook发送回复
            try {
                mainMessage = await this.webhookManager.sendAsUser(
                    thread,
                    message.author,
                    { 
                        content: mainContent,
                        files: messageContent.files
                    }
                );
            } catch (error) {
                console.error(`Webhook回复发送失败，尝试使用BOT发送:`, error);
                // 回退到BOT模式
                const botContent = `**${message.author.displayName || message.author.username}** (${formattedTime})\n${mainContent}`;
                
                mainMessage = await thread.send({
                    content: botContent,
                    files: messageContent.files
                });
            }
        } else {
            // 使用BOT身份发送回复
            const botContent = `**${message.author.displayName || message.author.username}** (${formattedTime})\n${mainContent}`;
            
            mainMessage = await thread.send({
                content: botContent,
                files: messageContent.files
            });
        }
        
        // 如果需要分离emoji，发送emoji消息
        if (messageContent.needsSeparation && messageContent.separateEmojis.length > 0) {
            console.log(`分离发送回复emoji: ${messageContent.separateEmojis.length} 个`);
            
            // 减少延迟：25ms
            await new Promise(resolve => setTimeout(resolve, 10));
            
            const emojiContent = messageContent.separateEmojis.join('\n');
            
            if (this.useWebhook && message.author.userId) {
                try {
                    await this.webhookManager.sendAsUser(
                        thread,
                        message.author,
                        {
                            content: emojiContent,
                            files: []
                        }
                    );
                } catch (error) {
                    console.error(`Webhook发送回复emoji失败，尝试使用BOT发送:`, error);
                    await thread.send({
                        content: emojiContent
                    });
                }
            } else {
                await thread.send({
                    content: emojiContent
                });
            }
        }
        
        // 如果是组中的最后一条消息，添加元数据
        if (isLastInGroup) {
            const metadata = this.formatMetadata(message, groupFirstMessageTimestamp);
            
            // 减少延迟：25ms
            await new Promise(resolve => setTimeout(resolve, 10));
            
            if (this.useWebhook && message.author.userId) {
                try {
                    await this.webhookManager.sendAsUser(
                        thread,
                        message.author,
                        {
                            content: metadata,
                            files: []
                        }
                    );
                } catch (error) {
                    console.error(`Webhook发送元数据失败，尝试使用BOT发送:`, error);
                    await thread.send({
                        content: metadata
                    });
                }
            } else {
                await thread.send({
                    content: metadata
                });
            }
        }
        
        return mainMessage;
    }

    /**
     * 创建帖子 - 使用增强的Excel数据
     */
    async createThread(threadInfo) {
        const threadTitle = threadInfo.title || '未命名帖子';
        const originalThreadId = threadInfo.thread_id || threadInfo.threadId;
        
        console.log(`====== 创建帖子调试信息 ======`);
        console.log(`帖子标题: ${threadTitle}`);
        console.log(`原始thread_id: ${originalThreadId}`);
        console.log(`Excel数据加载状态: ${this.excelDataLoaded}`);
        console.log(`Excel读取器存在: ${!!this.excelReader}`);
        
        // 从Excel获取增强信息
        let enhancedInfo = null;
        if (this.excelDataLoaded && this.excelReader && originalThreadId) {
            console.log(`尝试从Excel查询thread_id: ${originalThreadId}`);
            enhancedInfo = this.excelReader.getThreadInfo(originalThreadId);
            
            if (enhancedInfo) {
                console.log(`✅ Excel查询成功:`);
                console.log(`  - Excel标题: ${enhancedInfo.title}`);
                console.log(`  - JSON标题(已过滤): ${threadTitle}`);
                console.log(`  - 作者ID: ${enhancedInfo.authorId}`);
                console.log(`  - 创建时间: ${enhancedInfo.createdAt}`);
                console.log(`  - 总消息数: ${enhancedInfo.totalMessages}`);
                console.log(`  - 标签: ${enhancedInfo.tags}`);
            } else {
                console.log(`❌ Excel查询失败: 未找到thread_id=${originalThreadId}的数据`);
                
                // 尝试调试Excel数据
                if (this.excelReader && this.excelReader.threadInfoMap) {
                    console.log(`Excel中总共有 ${this.excelReader.threadInfoMap.size} 条数据`);
                    console.log(`前5个thread_id示例:`, Array.from(this.excelReader.threadInfoMap.keys()).slice(0, 5));
                    
                    // 检查是否有类似的ID
                    const similarIds = Array.from(this.excelReader.threadInfoMap.keys())
                        .filter(id => id.includes(originalThreadId.substring(0, 10)));
                    if (similarIds.length > 0) {
                        console.log(`找到相似的ID:`, similarIds);
                    }
                }
            }
        } else {
            console.log(`⚠️ 跳过Excel查询，原因:`);
            console.log(`  - Excel数据加载状态: ${this.excelDataLoaded}`);
            console.log(`  - Excel读取器存在: ${!!this.excelReader}`);
            console.log(`  - 原始thread_id: ${originalThreadId}`);
        }
        
        // 获取发帖人信息
        let authorDisplay = '未知';
        if (enhancedInfo && enhancedInfo.authorId && this.excelReader) {
            try {
                authorDisplay = await this.excelReader.getUserDisplayName(enhancedInfo.authorId);
                console.log(`✅ 发帖人获取成功: ${authorDisplay}`);
            } catch (error) {
                console.log(`❌ 发帖人获取失败:`, error);
                authorDisplay = '未知';
            }
        } else {
            console.log(`⚠️ 跳过发帖人获取，enhancedInfo存在: ${!!enhancedInfo}, authorId: ${enhancedInfo?.authorId}`);
        }
        
        // 获取原贴ID
        const displayThreadId = originalThreadId || '未知';
        console.log(`显示的原贴ID: ${displayThreadId}`);
        
        // 修改标题优先级：JSON标题优先于Excel标题
        const displayTitle = threadTitle || enhancedInfo?.title || '未命名帖子';
        console.log(`最终显示标题: "${displayTitle}" (JSON优先)`);
        
        // 创建增强的初始帖子消息
        const initialMessage = `**📋 帖子信息**\n` +
            `**标题:** ${displayTitle}\n` +  // 修改：使用JSON标题优先
            `**发帖人:** ${authorDisplay}\n` +
            `**原贴ID:** ${displayThreadId}\n` +
            `**原始创建时间:** ${enhancedInfo?.createdAt || threadInfo.createdAt || '未知'}\n` +
            `**总消息数:** ${enhancedInfo?.totalMessages || threadInfo.totalMessages || 0}\n` +
            `**参与人数:** ${threadInfo.participants || 0}\n\n` +
            `*此帖子由系统从备份重建*`;
        
        console.log(`创建的初始消息预览:\n${initialMessage}`);
        console.log(`====== 创建帖子调试信息结束 ======`);
        
        // Discord帖子名称也使用JSON标题优先
        const thread = await this.targetForum.threads.create({
            name: displayTitle,  // 修改：确保Discord帖子名称也使用过滤后的标题
            message: {
                content: initialMessage
            }
        });
        
        return thread;
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
            // 如果是emoji URL，尝试从原始JSON数据中获取emoji字符
            return '[表情包]'; // 暂时保持这个，稍后会在 findOriginalReplyContent 中特殊处理
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
     * 从原始JSON数据中查找被回复的消息内容 - 优化版本
     */
    findOriginalReplyContent(replyToMessageId, allMessages) {
        console.log(`查找被回复消息: ${replyToMessageId}`);
        
        if (!replyToMessageId) {
            console.log(`参数无效: replyToMessageId为空`);
            return '[无法找到原消息]';
        }
        
        // 使用快速索引查找（O(1) 时间复杂度）
        const originalMessage = this.messageIndex.get(replyToMessageId);
        
        if (originalMessage) {
            console.log(`快速索引找到原始消息: ${originalMessage.messageId}`);
            
            // 特殊处理纯emoji消息
            if (originalMessage.content?.isEmojiOnly && originalMessage.content?.emojis?.length > 0) {
                // 对于纯emoji消息，显示emoji字符
                const emojiText = originalMessage.content.emojis
                    .filter(emoji => emoji.alt && emoji.alt !== '__' && emoji.alt !== 'emoj_97')
                    .map(emoji => `:${emoji.alt}:`)
                    .join(' ');
                console.log(`纯emoji消息，返回: ${emojiText || '[表情包]'}`);
                return emojiText || '[表情包]';
            }
            
            const content = originalMessage.content?.markdown || originalMessage.content?.text || '';
            const truncated = this.truncateContent(content, 15);
            console.log(`普通消息，截取内容: "${truncated}"`);
            return truncated;
        } else {
            console.log(`快速索引未找到对应的原始消息: ${replyToMessageId}`);
            
            // 如果快速索引没有找到，尝试线性搜索作为后备（兼容性）
            if (allMessages && Array.isArray(allMessages)) {
                console.log(`尝试线性搜索后备方案，在 ${allMessages.length} 条消息中查找`);
                const fallbackMessage = allMessages.find(msg => msg.messageId === replyToMessageId);
                
                if (fallbackMessage) {
                    console.log(`线性搜索找到消息: ${fallbackMessage.messageId}`);
                    
                    // 特殊处理纯emoji消息
                    if (fallbackMessage.content?.isEmojiOnly && fallbackMessage.content?.emojis?.length > 0) {
                        const emojiText = fallbackMessage.content.emojis
                            .filter(emoji => emoji.alt && emoji.alt !== '__' && emoji.alt !== 'emoj_97')
                            .map(emoji => `:${emoji.alt}:`)
                            .join(' ');
                        return emojiText || '[表情包]';
                    }
                    
                    const content = fallbackMessage.content?.markdown || fallbackMessage.content?.text || '';
                    return this.truncateContent(content, 15);
                }
            }
            
            return '[原消息不存在]';
        }
    }
    
    /**
     * 发送系统消息
     */
    async sendSystemMessage(thread, message, isLastInGroup = false, groupFirstMessageTimestamp = null) {
        const formattedTime = this.formatTimestamp(message.timestamp);
        
        // 根据系统操作类型生成不同的消息格式
        let systemContent = '';
        
        if (message.content.systemAction === 'channel_name_change') {
            // 频道名称更改
            const actorName = message.author.displayName || message.author.username || '系统';
            const newName = message.content.newName || '未知名称';
            
            systemContent = `-# **:wrench: ${actorName}** changed the channel name: **${newName}**`;
            
            // 如果有旧名称，可以添加更详细的信息
            if (message.content.oldName && message.content.oldName.trim()) {
                systemContent = `-# **:wrench: ${actorName}** changed the channel name from **${message.content.oldName}** to **${newName}**`;
            }
        } else {
            // 其他系统操作的通用格式
            const actorName = message.author.displayName || message.author.username || '系统';
            let actionText = message.content.text || message.content.markdown || '执行了操作';
            
            // 移除开头的操作描述，只保留主要内容
            actionText = actionText.replace(/^changed the channel name:\s*/, '').trim();
            
            if (actionText) {
                systemContent = `-# **:wrench: ${actorName}** changed the channel name: **${actionText}**`;
            } else {
                systemContent = `-# **:wrench: ${actorName}** 执行了操作`;
            }
        }
        
        // 如果有有效时间戳，添加到末尾
        if (message.timestamp && message.timestamp.trim() && message.timestamp !== '未知时间') {
            systemContent += `  ${formattedTime}`;
        }
        
        const sentMessage = await thread.send({
            content: systemContent
        });
        
        // 系统消息不添加元数据
        // isLastInGroup 参数对系统消息无效
        
        return sentMessage;
    }
    
    /**
     * 发送线程更新消息
     */
    async sendThreadUpdateMessage(thread, message, isLastInGroup = false, groupFirstMessageTimestamp = null) {
        const formattedTime = this.formatTimestamp(message.timestamp);
        const actorName = message.author.displayName || message.author.username || '系统';
        
        // 线程更新的通用格式
        let updateContent = '';
        
        if (message.content.systemAction) {
            // 如果有特定的系统操作类型
            switch (message.content.systemAction) {
                case 'thread_title_change':
                    const newTitle = message.content.newTitle || message.content.newName || '未知标题';
                    updateContent = `-# **:wrench: ${actorName}** changed the thread title: **${newTitle}**`;
                    break;
                case 'thread_lock':
                    updateContent = `-# **:lock: ${actorName}** locked this thread`;
                    break;
                case 'thread_unlock':
                    updateContent = `-# **:unlock: ${actorName}** unlocked this thread`;
                    break;
                case 'thread_archive':
                    updateContent = `-# **:package: ${actorName}** archived this thread`;
                    break;
                case 'thread_unarchive':
                    updateContent = `-# **:open_file_folder: ${actorName}** unarchived this thread`;
                    break;
                default:
                    let actionText = message.content.text || message.content.markdown || '更新了线程';
                    updateContent = `-# **:gear: ${actorName}** ${actionText}`;
            }
        } else {
            // 通用线程更新格式
            let actionText = message.content.text || message.content.markdown || '更新了线程';
            
            // 如果包含特定操作描述，提取关键信息
            if (actionText.includes('changed the channel name')) {
                actionText = actionText.replace(/^changed the channel name:\s*/, '').trim();
                if (actionText) {
                    updateContent = `-# **:wrench: ${actorName}** changed the channel name: **${actionText}**`;
                } else {
                    updateContent = `-# **:wrench: ${actorName}** changed the channel name`;
                }
            } else {
                updateContent = `-# **:gear: ${actorName}** ${actionText}`;
            }
        }
        
        // 如果有有效时间戳，添加到末尾
        if (message.timestamp && message.timestamp.trim() && message.timestamp !== '未知时间') {
            updateContent += `  ${formattedTime}`;
        }
        
        const sentMessage = await thread.send({
            content: updateContent
        });
        
        // 线程更新消息也不添加元数据
        // isLastInGroup 参数对线程更新消息无效
        
        return sentMessage;
    }

    /**
     * 比较两个Discord消息ID的大小
     * Discord消息ID是雪花ID，数值较小的ID表示更早的消息
     */
    compareMessageIds(idA, idB) {
        // 如果ID不存在，认为是无效的，排在后面
        if (!idA && !idB) return 0;
        if (!idA) return 1;
        if (!idB) return -1;
        
        try {
            // 将字符串ID转换为BigInt进行比较（因为JavaScript的Number精度不够）
            const bigIntA = BigInt(idA);
            const bigIntB = BigInt(idB);
            
            if (bigIntA < bigIntB) return -1;
            if (bigIntA > bigIntB) return 1;
            return 0;
        } catch (error) {
            console.warn(`消息ID比较失败: ${idA} vs ${idB}`, error);
            // 如果转换失败，按字符串比较
            return idA.localeCompare(idB);
        }
    }
}

module.exports = ThreadRebuilder; 