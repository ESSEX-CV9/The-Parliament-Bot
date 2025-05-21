// src/services/forumPoster.js
const { updateMessage } = require('../utils/database');

async function createForumPost(client, messageData) {
    try {
        // 获取论坛频道
        const forumChannel = await client.channels.fetch(messageData.forumChannelId);
        
        if (!forumChannel || forumChannel.type !== 15) { // 15 = GUILD_FORUM
            console.error('无效的论坛频道');
            return;
        }
        
        // 创建论坛帖子
        const thread = await forumChannel.threads.create({
            name: messageData.formData.title,
            message: {
                content: `**描述:** ${messageData.formData.description}\n\n**联系方式:** ${messageData.formData.contact}\n\n*此帖子在收到 ${messageData.currentVotes} 个支持后创建。*`,
            },
            // 可以添加适当的标签
            appliedTags: []
        });
        
        // 更新数据库中的状态
        await updateMessage(messageData.messageId, { 
            status: 'posted',
            threadId: thread.id
        });
        
    } catch (error) {
        console.error('创建论坛帖子时出错:', error);
    }
}

module.exports = {
    createForumPost
};