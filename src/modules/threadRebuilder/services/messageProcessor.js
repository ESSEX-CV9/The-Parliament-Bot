const { AttachmentBuilder } = require('discord.js');
const https = require('https');
const http = require('http');
const { URL } = require('url');

class MessageProcessor {
    /**
     * 格式化消息内容
     */
    formatMessage(message) {
        let content = message.content.markdown || message.content.text || '';
        
        // 处理纯emoji消息
        if (message.content.isEmojiOnly && message.content.emojis && message.content.emojis.length > 0) {
            // 如果是纯emoji消息，直接返回emoji的URL
            const emojiUrls = message.content.emojis
                .filter(emoji => emoji.url) // 只处理有URL的emoji
                .map(emoji => emoji.url);
            
            if (emojiUrls.length > 0) {
                return {
                    content: emojiUrls.join('\n'), // 每个emoji URL一行
                    files: [],
                    embeds: [],
                    isEmojiMessage: true
                };
            }
        }
        
        // 如果消息内容为空，检查其他信息
        if (!content || content.trim() === '') {
            // 检查是否有有效的表情符号
            if (message.content.emojis && message.content.emojis.length > 0) {
                const validEmojis = message.content.emojis.filter(emoji => 
                    emoji && emoji.alt && emoji.alt !== '__' && emoji.alt !== 'emoj_97'
                );
                
                if (validEmojis.length > 0) {
                    // 如果有emoji URL，优先使用URL
                    const emojiUrls = validEmojis.filter(emoji => emoji.url);
                    if (emojiUrls.length > 0) {
                        content = emojiUrls.map(emoji => emoji.url).join('\n');
                    } else {
                        // 回退到显示emoji名称
                        content = validEmojis.map(emoji => `:${emoji.alt}:`).join(' ');
                    }
                }
            }
            
            // 如果还是没有内容，检查附件
            if ((!content || content.trim() === '') && message.attachments && message.attachments.length > 0) {
                content = '[发送了附件]';
            }
            
            // 如果仍然没有内容，提供默认内容
            if (!content || content.trim() === '') {
                content = '[空消息]';
            }
        } else {
            // 处理消息中的emoji（非纯emoji消息）
            if (message.content.emojis && message.content.emojis.length > 0) {
                const validEmojis = message.content.emojis.filter(emoji => 
                    emoji && emoji.alt && emoji.alt !== '__' && emoji.alt !== 'emoj_97'
                );
                
                if (validEmojis.length > 0) {
                    // 将emoji替换为URL或保持原有格式
                    for (const emoji of validEmojis) {
                        if (emoji.url) {
                            // 如果有URL，在消息末尾添加emoji URL
                            content += `\n${emoji.url}`;
                        } else {
                            // 否则保持原有的emoji格式
                            content = content.replace(
                                new RegExp(`:${emoji.alt}:`, 'g'),
                                `:${emoji.alt}:`
                            );
                        }
                    }
                }
            }
        }
        
        // 处理提及
        if (message.content.mentions && message.content.mentions.length > 0) {
            for (const mention of message.content.mentions) {
                // 替换提及为可见格式
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
                .map(r => `${r.emoji} ${r.count}`)
                .join(' | ');
            reactions = `\n*反应: ${reactionList}*`;
        }
        
        const result = {
            content: content + reactions,
            files: [],
            embeds: [],
            isEmojiMessage: message.content.isEmojiOnly || false
        };
        
        // 处理附件
        if (message.attachments && message.attachments.length > 0) {
            result.attachmentInfo = message.attachments.map(att => ({
                filename: att.filename,
                url: att.url,
                size: att.size,
                type: att.type
            }));
            
            // 添加附件信息到消息内容
            const attachmentList = message.attachments
                .map(att => `📎 ${att.filename} (${att.size || '未知大小'})`)
                .join('\n');
            
            // 如果内容是默认的附件提示，替换它
            if (result.content.startsWith('[发送了附件]')) {
                result.content = `**附件:**\n${attachmentList}${reactions}`;
            } else if (!result.isEmojiMessage) {
                // 只有在非emoji消息时才添加附件信息
                result.content += `\n\n**附件:**\n${attachmentList}`;
            }
        }
        
        // 处理编辑标记
        if (message.edited && message.edited.is_edited) {
            result.content += `\n*（已编辑 - ${message.edited.edited_at || '未知时间'}）*`;
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