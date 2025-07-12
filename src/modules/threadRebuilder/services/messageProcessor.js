const { AttachmentBuilder } = require('discord.js');
const https = require('https');
const http = require('http');
const { URL } = require('url');

class MessageProcessor {
    /**
     * 检查是否为需要过滤的SVG emoji
     */
    isSvgEmojiToFilter(emojiUrl) {
        if (!emojiUrl || typeof emojiUrl !== 'string') {
            return false;
        }
        
        // 检查是否为Twitter emoji的SVG格式
        return emojiUrl.includes('cdn.jsdelivr.net/gh/twitter/twemoji@latest/assets/svg/');
    }
    
    /**
     * 格式化消息内容 - 支持分离文字和emoji
     */
    formatMessage(message) {
        let content = message.content.markdown || message.content.text || '';
        
        // 移除消息末尾的 (edited) 标记
        content = content.replace(/\s*\(edited\)\s*$/i, '');
        
        // 处理纯emoji消息
        if (message.content.isEmojiOnly && message.content.emojis && message.content.emojis.length > 0) {
            // 过滤掉SVG格式的emoji
            const filteredEmojis = message.content.emojis.filter(emoji => 
                emoji.url && !this.isSvgEmojiToFilter(emoji.url)
            );
            
            if (filteredEmojis.length > 0) {
                const emojiUrls = filteredEmojis.map(emoji => emoji.url);
                return {
                    content: emojiUrls.join('\n'),
                    files: [],
                    embeds: [],
                    isEmojiMessage: true,
                    needsSeparation: false
                };
            } else {
                // 如果所有emoji都被过滤掉了，返回空内容（会跳过这条消息）
                console.log('所有emoji均为SVG格式，已过滤，跳过此消息');
                return {
                    content: '', // 空内容会在后续处理中被跳过
                    files: [],
                    embeds: [],
                    isEmojiMessage: true,
                    needsSeparation: false
                };
            }
        }
        
        // 检查是否有有效的emoji（过滤掉SVG格式）
        const validEmojis = message.content.emojis?.filter(emoji => 
            emoji && 
            emoji.alt && 
            emoji.alt !== '__' && 
            emoji.alt !== 'emoj_97' && 
            emoji.url &&
            !this.isSvgEmojiToFilter(emoji.url) // 添加SVG过滤
        ) || [];
        
        // 如果消息内容为空，检查其他信息
        if (!content || content.trim() === '') {
            if (validEmojis.length > 0) {
                // 如果有有效的emoji URL，使用URL
                content = validEmojis.map(emoji => emoji.url).join('\n');
                return {
                    content: content,
                    files: [],
                    embeds: [],
                    isEmojiMessage: true,
                    needsSeparation: false
                };
            }
            
            // 如果还是没有内容，检查附件
            if (message.attachments && message.attachments.length > 0) {
                content = '[发送了附件]';
            } else {
                content = '[空消息]';
            }
        }
        
        // 处理提及
        if (message.content.mentions && message.content.mentions.length > 0) {
            for (const mention of message.content.mentions) {
                content = content.replace(
                    `<@${mention.user_id}>`, 
                    `@${mention.username}`
                );
            }
        }
        
        // 处理反应
        let reactions = '';
        if (message.reactions && message.reactions.length > 0) {
            const reactionList = message.reactions
                .map(r => {
                    // 尝试格式化emoji显示
                    let emojiDisplay = r.emoji;
                    
                    // 如果是自定义emoji且有URL，尝试使用名称
                    if (r.emojiUrl && r.emojiUrl.includes('cdn.discordapp.com/emojis/')) {
                        if (r.emojiName && r.emojiName.trim()) {
                            emojiDisplay = `:${r.emojiName}:`;
                        } else {
                            // 从URL尝试提取名称
                            const urlMatch = r.emojiUrl.match(/\/emojis\/(\d+)\./);
                            if (urlMatch) {
                                emojiDisplay = `:emoji_${urlMatch[1]}:`;
                            }
                        }
                    }
                    
                    return `${emojiDisplay} ${r.count}`;
                })
                .join(' | ');
            reactions = `\n-# ${reactionList}`;
        }
        
        const result = {
            content: content + reactions,
            files: [],
            embeds: [],
            isEmojiMessage: false,
            needsSeparation: false,
            separateEmojis: []
        };
        
        // 检查是否需要分离emoji（过滤掉SVG格式）
        if (validEmojis.length > 0 && content.trim() && !message.content.isEmojiOnly) {
            // 有文字内容且有有效emoji，需要分离
            result.needsSeparation = true;
            result.separateEmojis = validEmojis.map(emoji => emoji.url);
            
            console.log(`分离emoji: 原始${message.content.emojis?.length || 0}个，过滤后${validEmojis.length}个`);
        }
        
        // 处理附件 - 使用 -# 格式
        if (message.attachments && message.attachments.length > 0) {
            result.attachmentInfo = message.attachments.map(att => ({
                filename: att.filename,
                url: att.url,
                size: att.size,
                type: att.type
            }));
            
            // 添加附件信息到消息内容 - 使用 -# 格式
            const attachmentList = message.attachments
                .map(att => `-# 📎 ${att.filename} (${att.size || '未知大小'})`)
                .join('\n');
            
            // 如果内容是默认的附件提示，替换它
            if (result.content.startsWith('[发送了附件]')) {
                result.content = `${attachmentList}${reactions}`;
            } else if (!result.isEmojiMessage) {
                result.content += `\n${attachmentList}`;
            }
        }
        
        // 处理编辑标记 - 简化格式
        if (message.edited && message.edited.is_edited) {
            result.content += `\n-# (已编辑)`;
        }
        
        // 处理剧透标记
        if (message.isSpoiler) {
            result.content = `||${result.content}||`;
        }
        
        // 最终检查：确保内容不为空
        if (!result.content || result.content.trim() === '') {
            result.content = '[无内容消息]';
        }
        
        return result;
    }
    
    /**
     * 下载附件（如果需要的话）
     */
    async downloadAttachment(url, filename) {
        return new Promise((resolve, reject) => {
            const protocol = url.startsWith('https:') ? https : http;
            const urlObj = new URL(url);
            
            const req = protocol.get(url, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`下载失败: ${res.statusCode}`));
                    return;
                }
                
                const data = [];
                res.on('data', chunk => data.push(chunk));
                res.on('end', () => {
                    const buffer = Buffer.concat(data);
                    resolve(new AttachmentBuilder(buffer, { name: filename }));
                });
            });
            
            req.on('error', reject);
            req.setTimeout(10000, () => {
                req.destroy();
                reject(new Error('下载超时'));
            });
        });
    }
}

module.exports = MessageProcessor; 