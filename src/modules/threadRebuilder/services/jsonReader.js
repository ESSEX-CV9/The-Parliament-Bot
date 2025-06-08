const fs = require('fs').promises;
const path = require('path');
const ContentFilter = require('./contentFilter');

class JsonReader {
    constructor() {
        this.jsonDir = path.resolve(process.cwd(), 'data/rebuild/json');
        this.contentFilter = new ContentFilter();
        console.log(`JsonReader初始化，JSON目录: ${this.jsonDir}`);
    }
    
    /**
     * 初始化内容过滤器
     */
    async initializeContentFilter() {
        try {
            await this.contentFilter.loadConfig();
            const stats = this.contentFilter.getFilterStats();
            console.log('内容过滤器初始化完成:', stats);
        } catch (error) {
            console.warn('内容过滤器初始化失败:', error);
        }
    }
    
    /**
     * 获取所有或指定的JSON文件
     */
    async getJsonFiles(specificFile = null) {
        try {
            console.log(`正在读取目录: ${this.jsonDir}`);
            
            // 检查目录是否存在
            try {
                await fs.access(this.jsonDir);
            } catch (error) {
                throw new Error(`JSON目录不存在: ${this.jsonDir}`);
            }
            
            const files = await fs.readdir(this.jsonDir);
            const jsonFiles = files.filter(file => file.endsWith('.json'));
            
            console.log(`找到 ${jsonFiles.length} 个JSON文件`);
            
            if (specificFile) {
                const targetFile = specificFile.endsWith('.json') ? specificFile : `${specificFile}.json`;
                const found = jsonFiles.find(file => file === targetFile);
                if (!found) {
                    throw new Error(`找不到指定的JSON文件: ${targetFile}\n可用文件: ${jsonFiles.join(', ')}`);
                }
                const filePath = path.join(this.jsonDir, found);
                console.log(`选择单个文件: ${filePath}`);
                return [{
                    name: found,
                    path: filePath
                }];
            }
            
            const result = jsonFiles.map(file => {
                const filePath = path.join(this.jsonDir, file);
                console.log(`添加文件: ${filePath}`);
                return {
                    name: file,
                    path: filePath
                };
            });
            
            return result;
            
        } catch (error) {
            console.error('读取JSON文件列表时出错:', error);
            throw new Error(`读取JSON文件列表失败: ${error.message}`);
        }
    }
    
    /**
     * 标准化emoji数据，兼容新旧格式
     */
    standardizeEmojis(emojis) {
        if (!emojis || !Array.isArray(emojis)) {
            return [];
        }
        
        return emojis.map(emoji => {
            // 如果是新格式（对象）
            if (typeof emoji === 'object' && emoji !== null) {
                return {
                    alt: emoji.alt || '',
                    title: emoji.title || emoji.alt || '',
                    url: emoji.url || '',
                    isLarge: emoji.is_large || false
                };
            }
            // 如果是旧格式（字符串）
            else if (typeof emoji === 'string') {
                return {
                    alt: emoji,
                    title: emoji,
                    url: '',
                    isLarge: false
                };
            }
            return null;
        }).filter(Boolean);
    }

    /**
     * 读取并解析JSON文件中的帖子数据
     */
    async readThreadData(filePath) {
        try {
            const pathLength = filePath.length;
            console.log(`正在读取文件，路径长度: ${pathLength} 字符`);
            console.log(`文件名: ${path.basename(filePath)}`);
            
            // Windows路径长度检查
            if (pathLength > 259) {
                throw new Error(`文件路径过长 (${pathLength} 字符)，Windows系统限制为260字符。请考虑缩短文件名或使用长路径支持。`);
            }
            
            // 使用同步方式检查文件存在（避免Promise问题）
            let fileExists = false;
            try {
                const stats = await fs.stat(filePath);
                fileExists = stats.isFile();
                console.log(`文件存在检查通过，文件大小: ${stats.size} 字节`);
            } catch (statError) {
                console.error(`文件stat检查失败:`, statError);
                
                // 尝试使用短路径
                try {
                    const shortDir = this.jsonDir;
                    const fileName = path.basename(filePath);
                    const alternativePath = path.join(shortDir, fileName);
                    
                    console.log(`尝试短路径: ${alternativePath}`);
                    const altStats = await fs.stat(alternativePath);
                    if (altStats.isFile()) {
                        console.log(`短路径访问成功`);
                        filePath = alternativePath; // 使用短路径
                        fileExists = true;
                    }
                } catch (altError) {
                    throw new Error(`文件不存在或无法访问: ${path.basename(filePath)} (原路径长度: ${pathLength})`);
                }
            }
            
            if (!fileExists) {
                throw new Error(`文件不存在: ${path.basename(filePath)}`);
            }
            
            const content = await fs.readFile(filePath, 'utf8');
            console.log(`文件读取成功，大小: ${content.length} 字符`);
            
            let data;
            try {
                data = JSON.parse(content);
            } catch (parseError) {
                throw new Error(`JSON解析失败: ${parseError.message}`);
            }
            
            // 验证数据结构
            if (!data.thread_info) {
                throw new Error('JSON文件格式不正确，缺少thread_info字段');
            }
            if (!data.messages || !Array.isArray(data.messages)) {
                throw new Error('JSON文件格式不正确，缺少messages字段或messages不是数组');
            }
            
            console.log(`数据验证成功，消息数量: ${data.messages.length}`);
            
            // 创建时间戳缓存
            const timestampCache = new Map();
            
            // 预解析所有时间戳
            console.log(`开始预解析时间戳...`);
            for (const msg of data.messages) {
                if (msg.timestamp) {
                    const parsed = this.parseTimestamp(msg.timestamp);
                    if (parsed) {
                        timestampCache.set(msg.timestamp, {
                            date: parsed,
                            formatted: this.formatTimestamp(parsed),
                            metadataFormatted: this.formatTimestampForMetadata(parsed)
                        });
                    }
                }
            }
            console.log(`时间戳预解析完成，缓存了 ${timestampCache.size} 个时间戳`);
            
            // 标准化数据结构
            const messages = data.messages.map((msg, index) => {
                try {
                    return {
                        messageId: msg.message_id,
                        messageType: msg.message_type || 'normal',
                        author: {
                            userId: msg.author?.user_id,
                            username: msg.author?.username || '未知用户',
                            displayName: msg.author?.display_name || msg.author?.username || '未知用户',
                            avatarUrl: msg.author?.avatar_url,
                            isSystemActor: msg.author?.is_system_actor || false
                        },
                        timestamp: msg.timestamp || '未知时间',
                        content: {
                            text: msg.content?.text || '',
                            markdown: msg.content?.markdown || msg.content?.text || '',
                            mentions: msg.content?.mentions || [],
                            emojis: this.standardizeEmojis(msg.content?.emojis || []),
                            isEmojiOnly: msg.content?.is_emoji_only || false,
                            // 系统消息特有字段
                            systemAction: msg.content?.system_action,
                            newName: msg.content?.new_name,
                            oldName: msg.content?.old_name,
                            newTitle: msg.content?.new_title,
                            oldTitle: msg.content?.old_title
                        },
                        attachments: msg.attachments || [],
                        reactions: (msg.reactions || []).map(reaction => ({
                            emoji: reaction.emoji,
                            emojiName: reaction.emoji_name || '',
                            emojiUrl: reaction.emoji_url || '',
                            count: reaction.count || 0
                        })),
                        replyTo: msg.reply_to ? {
                            messageId: msg.reply_to.message_id,
                            author: msg.reply_to.author,
                            contentPreview: msg.reply_to.content_preview
                        } : null,
                        edited: msg.edited || { is_edited: false, edited_at: null },
                        isSpoiler: msg.is_spoiler || false
                    };
                } catch (msgError) {
                    console.error(`处理消息 ${index} 时出错:`, msgError);
                    // 返回一个默认的消息对象
                    return {
                        messageId: msg.message_id || `error_${index}`,
                        messageType: 'normal',
                        author: {
                            userId: null,
                            username: '系统',
                            displayName: '系统',
                            avatarUrl: null,
                            isSystemActor: false
                        },
                        timestamp: '未知时间',
                        content: {
                            text: `[消息解析错误: ${msgError.message}]`,
                            markdown: `[消息解析错误: ${msgError.message}]`,
                            mentions: [],
                            emojis: [],
                            isEmojiOnly: false
                        },
                        attachments: [],
                        reactions: [],
                        replyTo: null,
                        edited: { is_edited: false, edited_at: null },
                        isSpoiler: false
                    };
                }
            });

            // 创建消息ID快速索引 - 性能关键优化
            console.log(`开始建立消息ID索引...`);
            const messageIndex = new Map();
            for (const message of messages) {
                if (message.messageId) {
                    messageIndex.set(message.messageId, message);
                }
            }
            console.log(`消息ID索引建立完成，索引了 ${messageIndex.size} 条消息`);
            
            const result = {
                threadInfo: {
                    thread_id: data.thread_info.thread_id,
                    threadId: data.thread_info.thread_id,
                    title: data.thread_info.title,
                    channelPath: data.thread_info.channel_path,
                    createdAt: data.thread_info.created_at,
                    totalMessages: data.thread_info.total_messages,
                    participants: data.thread_info.participants
                },
                timestampCache: timestampCache,
                messageIndex: messageIndex,
                messages: messages
            };
            
            console.log(`数据标准化完成，thread_id: ${result.threadInfo.thread_id}`);
            
            // 应用内容过滤（新增）
            if (!this.contentFilter.configLoaded) {
                await this.initializeContentFilter();
            }
            
            const filteredResult = this.contentFilter.filterThreadData(result);
            console.log(`内容过滤完成`);
            
            return filteredResult;
            
        } catch (error) {
            console.error('读取JSON文件时出错:', error);
            throw new Error(`读取JSON文件失败: ${error.message}`);
        }
    }

    /**
     * 解析时间戳（用于预解析缓存）
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
                return null;
            }
            
            return date;
        } catch (error) {
            return null;
        }
    }

    /**
     * 格式化时间戳为可读字符串
     */
    formatTimestamp(date) {
        if (!date) {
            return '未知时间';
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
            return '时间格式错误';
        }
    }

    /**
     * 格式化时间戳为元数据格式 (YYYY/MM/DD - HH:mm:ss)
     */
    formatTimestampForMetadata(date) {
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
            return '时间格式错误';
        }
    }

    /**
     * 并行读取多个JSON文件
     * @param {Array} jsonFiles - JSON文件数组
     * @param {number} maxConcurrency - 最大并发数
     * @returns {Promise<Array>} 解析后的帖子数据数组
     */
    async readMultipleThreadsData(jsonFiles, maxConcurrency = 5) {
        console.log(`开始并行读取 ${jsonFiles.length} 个JSON文件，最大并发数: ${maxConcurrency}`);
        
        // 预先初始化内容过滤器（新增）
        await this.initializeContentFilter();
        
        const results = [];
        const errors = [];
        
        // 分批处理以控制并发数
        for (let i = 0; i < jsonFiles.length; i += maxConcurrency) {
            const batch = jsonFiles.slice(i, i + maxConcurrency);
            console.log(`处理批次 ${Math.floor(i / maxConcurrency) + 1}，包含 ${batch.length} 个文件`);
            
            const batchPromises = batch.map(async (file, batchIndex) => {
                const globalIndex = i + batchIndex;
                try {
                    console.log(`[${globalIndex + 1}/${jsonFiles.length}] 开始读取: ${file.name}`);
                    const startTime = Date.now();
                    
                    const threadData = await this.readThreadData(file.path);
                    
                    // 添加文件信息到数据中
                    threadData.fileName = file.name;
                    threadData.filePath = file.path;
                    
                    const readTime = Date.now() - startTime;
                    console.log(`[${globalIndex + 1}/${jsonFiles.length}] 读取完成: ${file.name} (${readTime}ms)`);
                    
                    return {
                        success: true,
                        data: threadData,
                        fileName: file.name,
                        readTime: readTime
                    };
                } catch (error) {
                    console.error(`[${globalIndex + 1}/${jsonFiles.length}] 读取失败: ${file.name}`, error);
                    return {
                        success: false,
                        error: error.message,
                        fileName: file.name
                    };
                }
            });
            
            try {
                const batchResults = await Promise.all(batchPromises);
                
                // 分离成功和失败的结果
                batchResults.forEach(result => {
                    if (result.success) {
                        results.push(result.data);
                    } else {
                        errors.push(result);
                    }
                });
                
                console.log(`批次处理完成，成功: ${batchResults.filter(r => r.success).length}，失败: ${batchResults.filter(r => !r.success).length}`);
                
            } catch (error) {
                console.error(`批次处理失败:`, error);
                // 即使批次失败，也继续处理下一批
            }
            
            // 批次间短暂延迟
            if (i + maxConcurrency < jsonFiles.length) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        
        console.log(`并行读取完成，成功: ${results.length}，失败: ${errors.length}`);
        
        if (errors.length > 0) {
            console.warn(`以下文件读取失败:`);
            errors.forEach(error => {
                console.warn(`- ${error.fileName}: ${error.error}`);
            });
        }
        
        return results;
    }

    /**
     * 异步验证JSON文件是否有效
     * @param {string} filePath - 文件路径
     * @returns {Promise<boolean>} 是否为有效的JSON文件
     */
    async validateJsonFile(filePath) {
        try {
            const stats = await fs.stat(filePath);
            if (!stats.isFile()) {
                return false;
            }
            
            // 只读取文件开头部分进行基本验证
            const content = await fs.readFile(filePath, 'utf8');
            const data = JSON.parse(content);
            
            // 基本结构验证
            return !!(data.thread_info && data.messages && Array.isArray(data.messages));
        } catch (error) {
            return false;
        }
    }

    /**
     * 批量验证JSON文件
     * @param {Array} jsonFiles - JSON文件数组
     * @returns {Promise<Array>} 有效的JSON文件数组
     */
    async validateMultipleJsonFiles(jsonFiles) {
        console.log(`开始验证 ${jsonFiles.length} 个JSON文件...`);
        
        const validationPromises = jsonFiles.map(async (file) => {
            const isValid = await this.validateJsonFile(file.path);
            return {
                ...file,
                isValid: isValid
            };
        });
        
        const validationResults = await Promise.all(validationPromises);
        const validFiles = validationResults.filter(file => file.isValid);
        const invalidFiles = validationResults.filter(file => !file.isValid);
        
        if (invalidFiles.length > 0) {
            console.warn(`发现 ${invalidFiles.length} 个无效文件:`);
            invalidFiles.forEach(file => {
                console.warn(`- ${file.name}`);
            });
        }
        
        console.log(`验证完成，有效文件: ${validFiles.length}，无效文件: ${invalidFiles.length}`);
        return validFiles;
    }
}

module.exports = JsonReader; 