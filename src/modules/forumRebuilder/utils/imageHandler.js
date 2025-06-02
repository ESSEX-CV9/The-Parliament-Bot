const { AttachmentBuilder } = require('discord.js');
const https = require('https');
const http = require('http');
const path = require('path');

class ImageHandler {
    constructor() {
        this.maxFileSize = 25 * 1024 * 1024; // 25MB Discord限制
        this.supportedFormats = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    }
    
    async downloadImages(imageUrls) {
        const attachments = [];
        
        for (let i = 0; i < imageUrls.length; i++) {
            try {
                const url = imageUrls[i];
                console.log(`📥 尝试下载图片 ${i + 1}/${imageUrls.length}: ${url}`);
                
                const imageBuffer = await this.downloadImage(url);
                if (imageBuffer) {
                    const filename = this.generateFileName(url, i);
                    const attachment = new AttachmentBuilder(imageBuffer, { name: filename });
                    attachments.push(attachment);
                    console.log(`✅ 图片下载成功: ${filename}`);
                } else {
                    console.log(`⚠️ 跳过无效图片: ${url}`);
                }
                
                // 添加延迟避免频率限制
                if (i < imageUrls.length - 1) {
                    await this.delay(1000);
                }
                
            } catch (error) {
                console.log(`⚠️ 跳过下载失败的图片 ${imageUrls[i]}: ${error.message}`);
                // 继续处理下一张图片，不抛出错误
            }
        }
        
        console.log(`📊 图片处理完成: ${attachments.length}/${imageUrls.length} 成功`);
        return attachments;
    }
    
    async downloadImage(url) {
        return new Promise((resolve, reject) => {
            try {
                // 验证URL
                if (!this.isValidImageUrl(url)) {
                    console.log(`❌ 无效的图片URL格式: ${url}`);
                    resolve(null); // 返回null而不是reject
                    return;
                }
                
                const protocol = url.startsWith('https:') ? https : http;
                
                const request = protocol.get(url, {
                    timeout: 10000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                }, (response) => {
                    // 检查响应状态
                    if (response.statusCode !== 200) {
                        console.log(`❌ HTTP ${response.statusCode} ${response.statusMessage}: ${url}`);
                        resolve(null); // 返回null而不是reject
                        return;
                    }
                    
                    // 检查内容类型
                    const contentType = response.headers['content-type'];
                    if (!contentType || !contentType.startsWith('image/')) {
                        console.log(`❌ 非图片类型: ${contentType}`);
                        resolve(null);
                        return;
                    }
                    
                    // 检查文件大小
                    const contentLength = parseInt(response.headers['content-length']);
                    if (contentLength && contentLength > this.maxFileSize) {
                        console.log(`❌ 图片文件过大: ${contentLength} bytes`);
                        resolve(null);
                        return;
                    }
                    
                    const chunks = [];
                    let currentSize = 0;
                    
                    response.on('data', (chunk) => {
                        currentSize += chunk.length;
                        if (currentSize > this.maxFileSize) {
                            console.log(`❌ 下载过程中发现文件过大: ${currentSize} bytes`);
                            resolve(null);
                            return;
                        }
                        chunks.push(chunk);
                    });
                    
                    response.on('end', () => {
                        const buffer = Buffer.concat(chunks);
                        resolve(buffer);
                    });
                    
                    response.on('error', (error) => {
                        console.log(`❌ 下载响应错误: ${error.message}`);
                        resolve(null);
                    });
                });
                
                request.on('timeout', () => {
                    request.destroy();
                    console.log(`❌ 下载超时: ${url}`);
                    resolve(null);
                });
                
                request.on('error', (error) => {
                    console.log(`❌ 下载请求错误: ${error.message}`);
                    resolve(null);
                });
                
            } catch (error) {
                console.log(`❌ 下载图片异常: ${error.message}`);
                resolve(null);
            }
        });
    }
    
    isValidImageUrl(url) {
        try {
            // 检查是否为空或只是文件名
            if (!url || url.length < 10) {
                return false;
            }
            
            // 如果不是完整URL，尝试判断是否为文件名
            if (!url.startsWith('http')) {
                console.log(`❌ 不是完整URL，可能是文件名: ${url}`);
                return false;
            }
            
            const urlObj = new URL(url);
            
            // 检查协议
            if (!['http:', 'https:'].includes(urlObj.protocol)) {
                return false;
            }
            
            // 检查是否是常见的图片CDN域名
            const allowedDomains = [
                'cdn.discordapp.com',
                'media.discordapp.net',
                'images.discordapp.net',
                'i.imgur.com',
                'imgur.com'
            ];
            
            // 如果是Discord CDN，直接允许
            if (allowedDomains.some(domain => urlObj.hostname.includes(domain))) {
                return true;
            }
            
            // 检查文件扩展名
            const pathname = urlObj.pathname.toLowerCase();
            return this.supportedFormats.some(format => pathname.includes(format));
            
        } catch (error) {
            console.log(`❌ URL解析错误: ${error.message}`);
            return false;
        }
    }
    
    generateFileName(url, index) {
        try {
            const urlObj = new URL(url);
            const pathname = urlObj.pathname;
            const extension = path.extname(pathname) || '.png';
            
            // 从URL中提取有意义的文件名
            let filename = path.basename(pathname, extension);
            
            // 如果文件名太短或包含无意义字符，使用默认名称
            if (!filename || filename.length < 3 || /^[a-f0-9]{8,}$/i.test(filename)) {
                filename = `image_${index + 1}`;
            }
            
            // 确保文件名安全
            filename = filename.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 50);
            
            return `${filename}${extension}`;
            
        } catch (error) {
            return `image_${index + 1}.png`;
        }
    }
    
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = ImageHandler; 