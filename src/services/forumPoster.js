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
        
        // 获取提案人用户
        const author = await client.users.fetch(messageData.authorId).catch(() => null);
        const authorMention = author ? `<@${author.id}>` : "未知用户";
        
        // 创建论坛帖子
        const thread = await forumChannel.threads.create({
            name: messageData.formData.title,
            message: {
                content: `提案人：${authorMention}\n\n**提案原因**\n${messageData.formData.reason}\n\n**议案动议**\n${messageData.formData.motion}\n\n**执行方案**\n${messageData.formData.implementation}\n\n**投票时间**\n${messageData.formData.voteTime}\n\n*此帖子在收到 ${messageData.currentVotes} 个支持后创建。提案ID: ${messageData.proposalId}*`,
            },
            // 可以添加适当的标签
            appliedTags: []
        });
        
        // 更新数据库中的状态
        await updateMessage(messageData.messageId, { 
            status: 'posted',
            threadId: thread.id
        });
        
        console.log(`成功创建论坛帖子: ${thread.id}`);
        
        return thread;
        
    } catch (error) {
        console.error('创建论坛帖子时出错:', error);
        throw error;
    }
}

module.exports = {
    createForumPost
};