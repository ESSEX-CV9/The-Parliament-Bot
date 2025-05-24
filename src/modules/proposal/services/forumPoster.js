// src/services/forumPoster.js
const { updateMessage } = require('../utils/database');

async function createForumPost(client, messageData) {
    try {
        // 获取论坛频道
        const forumChannel = await client.channels.fetch(messageData.forumChannelId);
        
        if (!forumChannel || forumChannel.type !== 15) { // 15 = GUILD_FORUM
            console.error('无效的论坛频道');
            throw new Error('无效的论坛频道');
        }
        
        // 获取提案人用户
        const author = await client.users.fetch(messageData.authorId).catch(() => null);
        const authorMention = author ? `<@${author.id}>` : "未知用户";
        
        // 获取当前时间戳（Discord格式）
        const currentTimestamp = Math.floor(Date.now() / 1000);
        
        // 构建新的帖子内容格式
        const postContent = `***提案人: ${authorMention}***

> ## 提案原因
${messageData.formData.reason}

> ## 议案动议
${messageData.formData.motion}

> ## 执行方案
${messageData.formData.implementation}

> ## 投票时间
${messageData.formData.voteTime}

*讨论帖创建时间: <t:${currentTimestamp}:f>*`;
        
        // 创建论坛帖子
        const thread = await forumChannel.threads.create({
            name: messageData.formData.title,
            message: {
                content: postContent,
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
        
        // 返回帖子信息，包括URL
        return {
            id: thread.id,
            url: `https://discord.com/channels/${messageData.forumChannelId}/${thread.id}`,
            thread: thread
        };
        
    } catch (error) {
        console.error('创建论坛帖子时出错:', error);
        throw error;
    }
}

module.exports = {
    createForumPost
};