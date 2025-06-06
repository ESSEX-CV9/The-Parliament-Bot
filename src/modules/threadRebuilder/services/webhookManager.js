const { WebhookClient } = require('discord.js');

class WebhookManager {
    constructor(targetChannel) {
        this.targetChannel = targetChannel;
        this.webhooks = new Map(); // 缓存创建的webhooks
    }
    
    async initialize() {
        // 预先获取或创建一个通用webhook
        await this.getOrCreateWebhook('ThreadRebuilder');
    }
    
    /**
     * 获取或创建webhook
     */
    async getOrCreateWebhook(name = 'ThreadRebuilder') {
        try {
            // 先检查是否已有webhook
            const existingWebhooks = await this.targetChannel.fetchWebhooks();
            let webhook = existingWebhooks.find(wh => wh.name === name);
            
            if (!webhook) {
                // 创建新的webhook
                webhook = await this.targetChannel.createWebhook({
                    name: name,
                    reason: '用于帖子重建系统'
                });
            }
            
            this.webhooks.set(name, webhook);
            return webhook;
            
        } catch (error) {
            throw new Error(`创建Webhook失败: ${error.message}`);
        }
    }
    
    /**
     * 使用webhook模拟用户发送消息
     */
    async sendAsUser(thread, author, messageContent) {
        try {
            const webhook = this.webhooks.get('ThreadRebuilder') || 
                          await this.getOrCreateWebhook();
            
            // 准备webhook参数
            const webhookOptions = {
                content: messageContent.content,
                username: author.displayName || author.username,
                avatarURL: author.avatarUrl,
                threadId: thread.id
            };
            
            // 添加文件（如果有）
            if (messageContent.files && messageContent.files.length > 0) {
                webhookOptions.files = messageContent.files;
            }
            
            // 添加嵌入（如果有）
            if (messageContent.embeds) {
                webhookOptions.embeds = messageContent.embeds;
            }
            
            return await webhook.send(webhookOptions);
            
        } catch (error) {
            console.error('Webhook发送失败:', error);
            throw error;
        }
    }
    
    /**
     * 清理webhook
     */
    async cleanup() {
        try {
            for (const webhook of this.webhooks.values()) {
                await webhook.delete('清理帖子重建系统webhook');
            }
            this.webhooks.clear();
        } catch (error) {
            console.error('清理Webhook失败:', error);
        }
    }
}

module.exports = WebhookManager; 