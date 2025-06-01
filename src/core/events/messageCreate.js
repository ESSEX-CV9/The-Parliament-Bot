const { autoCleanupHandler } = require('../../modules/autoCleanup/events/messageCreate');

async function messageCreateHandler(message) {
    try {
        // 处理自动清理
        await autoCleanupHandler.handleMessage(message);
        
        // 这里可以添加其他消息处理逻辑
        
    } catch (error) {
        console.error('处理消息创建事件时出错:', error);
    }
}

module.exports = { messageCreateHandler }; 