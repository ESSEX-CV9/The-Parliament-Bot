const { getExpiredVotes, cleanupExpiredVotes } = require('./voteManager');
const { createVoteResultEmbed } = require('../components/votePanel');

let voteCheckInterval = null;

function startVoteChecker(client) {
    console.log('投票检查器启动...');
    
    // 每30秒检查一次
    voteCheckInterval = setInterval(async () => {
        try {
            await checkExpiredVotes(client);
        } catch (error) {
            console.error('投票检查器错误:', error);
        }
    }, 30 * 1000);
    
    // 每小时清理一次过期投票
    setInterval(async () => {
        try {
            await cleanupExpiredVotes(7); // 保留7天
        } catch (error) {
            console.error('清理过期投票错误:', error);
        }
    }, 60 * 60 * 1000);
}

function stopVoteChecker() {
    if (voteCheckInterval) {
        clearInterval(voteCheckInterval);
        voteCheckInterval = null;
        console.log('投票检查器已停止');
    }
}

async function checkExpiredVotes(client) {
    try {
        const expiredVotes = await getExpiredVotes();
        
        for (const vote of expiredVotes) {
            await handleExpiredVote(client, vote);
        }
    } catch (error) {
        console.error('检查过期投票失败:', error);
    }
}

async function handleExpiredVote(client, voteData) {
    try {
        // 如果投票已经被处理过，跳过
        if (voteData.isProcessed) {
            return;
        }
        
        const guild = client.guilds.cache.get(voteData.guildId);
        if (!guild) {
            console.log(`服务器 ${voteData.guildId} 不存在，跳过投票 ${voteData.voteId}`);
            return;
        }
        
        const channel = guild.channels.cache.get(voteData.channelId);
        if (!channel) {
            console.log(`频道 ${voteData.channelId} 不存在，跳过投票 ${voteData.voteId}`);
            return;
        }
        
        // 获取原投票消息
        let voteMessage = null;
        if (voteData.messageId) {
            try {
                voteMessage = await channel.messages.fetch(voteData.messageId);
            } catch (error) {
                console.log(`无法获取投票消息 ${voteData.messageId}:`, error.message);
            }
        }
        
        // 创建最终结果嵌入消息
        const resultEmbed = createVoteResultEmbed(voteData);
        resultEmbed.setColor(0xFF6B6B); // 设置为红色表示已结束
        resultEmbed.setTitle(`🔒 ${voteData.title} - 投票已结束`);
        
        // 更新原消息（移除按钮）
        if (voteMessage) {
            try {
                await voteMessage.edit({
                    embeds: [resultEmbed],
                    components: [] // 移除所有按钮
                });
            } catch (error) {
                console.error('更新投票消息失败:', error);
            }
        }
        
        // 发送投票结束通知
        await sendVoteEndNotification(channel, voteData, resultEmbed);
        
        // 标记为已处理
        voteData.isProcessed = true;
        const { saveVoteData } = require('./voteManager');
        await saveVoteData(voteData);
        
        console.log(`投票 ${voteData.voteId} 已结束并处理完成`);
        
    } catch (error) {
        console.error(`处理过期投票 ${voteData.voteId} 失败:`, error);
    }
}

async function sendVoteEndNotification(channel, voteData, resultEmbed) {
    try {
        // 只发送结果embed，不添加额外的文字说明
        await channel.send({
            embeds: [resultEmbed]
        });
        
    } catch (error) {
        console.error('发送投票结束通知失败:', error);
    }
}

module.exports = {
    startVoteChecker,
    stopVoteChecker,
    checkExpiredVotes,
    handleExpiredVote
}; 