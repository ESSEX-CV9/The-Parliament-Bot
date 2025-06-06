const fs = require('fs').promises;
const path = require('path');

class JsonReader {
    constructor() {
        this.jsonDir = path.resolve(process.cwd(), 'data/rebuild/json');
        console.log(`JsonReader初始化，JSON目录: ${this.jsonDir}`);
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
            
            // 标准化数据结构
            const result = {
                threadInfo: {
                    threadId: data.thread_info.thread_id,
                    title: data.thread_info.title,
                    channelPath: data.thread_info.channel_path,
                    createdAt: data.thread_info.created_at,
                    totalMessages: data.thread_info.total_messages,
                    participants: data.thread_info.participants
                },
                messages: data.messages.map((msg, index) => {
                    try {
                        return {
                            messageId: msg.message_id,
                            messageType: msg.message_type || 'normal',
                            author: {
                                userId: msg.author?.user_id,
                                username: msg.author?.username || '未知用户',
                                displayName: msg.author?.display_name || msg.author?.username || '未知用户',
                                avatarUrl: msg.author?.avatar_url
                            },
                            timestamp: msg.timestamp || '未知时间',
                            content: {
                                text: msg.content?.text || '',
                                markdown: msg.content?.markdown || msg.content?.text || '',
                                mentions: msg.content?.mentions || [],
                                emojis: this.standardizeEmojis(msg.content?.emojis || []),
                                isEmojiOnly: msg.content?.is_emoji_only || false
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
                                avatarUrl: null
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
                })
            };
            
            console.log(`数据标准化完成`);
            return result;
            
        } catch (error) {
            console.error('读取JSON文件时出错:', error);
            throw new Error(`读取JSON文件失败: ${error.message}`);
        }
    }
}

module.exports = JsonReader; 