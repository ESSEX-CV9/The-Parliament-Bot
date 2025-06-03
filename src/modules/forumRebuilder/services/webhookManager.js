class WebhookManager {
    constructor() {
        this.webhooks = new Map(); // 缓存webhook
    }
    
    async getOrCreateWebhook(forumChannel, authorId, client) {
        try {
            const webhookKey = `${forumChannel.id}_${authorId}`;
            
            // 检查缓存
            if (this.webhooks.has(webhookKey)) {
                return this.webhooks.get(webhookKey);
            }
            
            // 尝试获取用户信息
            let user = null;
            let member = null;
            let displayName = `用户${authorId}`;
            let englishUsername = `user_${authorId}`;
            
            try {
                user = await client.users.fetch(authorId);
                console.log(`✅ 找到原发帖人: ${user.username} (${authorId})`);
                
                // 保存英文用户名
                englishUsername = user.username;
                
                // 尝试获取服务器成员信息以获取昵称
                try {
                    const guild = forumChannel.guild;
                    member = await guild.members.fetch(authorId);
                    
                    // 优先级：服务器昵称 > 全局显示名称 > 用户名
                    if (member.nickname) {
                        displayName = member.nickname;
                        console.log(`📝 使用服务器昵称: ${displayName} (${englishUsername})`);
                    } else if (user.displayName && user.displayName !== user.username) {
                        displayName = user.displayName;
                        console.log(`📝 使用全局显示名称: ${displayName} (${englishUsername})`);
                    } else {
                        displayName = user.username;
                        console.log(`📝 使用用户名: ${displayName}`);
                    }
                    
                } catch (memberError) {
                    console.log(`⚠️ 用户不在当前服务器，使用全局信息`);
                    // 如果用户不在服务器中，使用全局显示名称或用户名
                    if (user.displayName && user.displayName !== user.username) {
                        displayName = user.displayName;
                        console.log(`📝 使用全局显示名称: ${displayName} (${englishUsername})`);
                    } else {
                        displayName = user.username;
                        console.log(`📝 使用用户名: ${displayName}`);
                    }
                }
                
            } catch (userError) {
                console.log(`⚠️ 无法获取用户信息: ${authorId}, 可能用户不存在`);
                // 返回null表示无法模拟该用户
                return null;
            }
            
            // 获取或创建webhook (在论坛频道而不是thread中)
            const webhooks = await forumChannel.fetchWebhooks();
            let webhook = webhooks.find(wh => wh.name === 'ForumRebuilder');
            
            if (!webhook) {
                webhook = await forumChannel.createWebhook({
                    name: 'ForumRebuilder',
                    reason: '论坛重建功能'
                });
                console.log('✅ 创建了新的Webhook');
            }
            
            // 缓存webhook数据
            const webhookData = {
                webhook,
                user,
                member,
                displayName: displayName, // 昵称用于显示
                username: englishUsername, // 英文用户名用于详情框
                avatarURL: (member && member.displayAvatarURL()) || (user && user.displayAvatarURL()) || null
            };
            
            this.webhooks.set(webhookKey, webhookData);
            return webhookData;
            
        } catch (error) {
            console.error('获取或创建Webhook失败:', error);
            return null; // 返回null而不是抛出错误
        }
    }
    
    async sendAsUser(forumThread, authorId, content, client, options = {}) {
        try {
            // 从thread获取父论坛频道
            const forumChannel = forumThread.parent;
            
            const webhookData = await this.getOrCreateWebhook(forumChannel, authorId, client);
            
            if (!webhookData) {
                console.log(`⚠️ 无法为用户 ${authorId} 创建Webhook，将使用回退方案`);
                return null;
            }
            
            // 使用组合显示名称：昵称 + 英文用户名
            const combinedUsername = webhookData.displayName !== webhookData.username 
                ? `${webhookData.displayName} (${webhookData.username})`
                : webhookData.username;
            
            const messageOptions = {
                content: content,
                username: combinedUsername, // 使用组合名称
                avatarURL: webhookData.avatarURL,
                threadId: forumThread.id, // 指定发送到的thread
                ...options
            };
            
            const message = await webhookData.webhook.send(messageOptions);
            console.log(`✅ 通过Webhook模拟用户发送消息: ${combinedUsername}`);
            return message;
            
        } catch (error) {
            console.error('通过Webhook发送消息失败:', error);
            return null; // 返回null而不是抛出错误
        }
    }
    
    async cleanup(forumChannel) {
        try {
            // 清理该频道的webhook缓存
            for (const [key, value] of this.webhooks.entries()) {
                if (key.startsWith(forumChannel.id)) {
                    this.webhooks.delete(key);
                }
            }
            
            // 可选：删除创建的webhooks
            const webhooks = await forumChannel.fetchWebhooks();
            const forumWebhooks = webhooks.filter(wh => wh.name === 'ForumRebuilder');
            
            for (const webhook of forumWebhooks) {
                try {
                    await webhook.delete('论坛重建完成，清理webhook');
                    console.log('🧹 清理了Webhook');
                } catch (error) {
                    console.error('删除webhook失败:', error);
                }
            }
            
        } catch (error) {
            console.error('清理Webhook失败:', error);
        }
    }
}

module.exports = WebhookManager; 