const { MessageType } = require('discord.js');

const THREAD_STARTER_PROTECTED_MESSAGE = '帖子首楼（起始消息）受保护，不能作为这类投票的目标。请选择其他楼层的消息。';

/** 仅供自助管理投票使用，不影响管理员或其他模块的正常删除。 */
function isProtectedStarterMessage(message) {
    return message.type === MessageType.ThreadStarterMessage
        // 普通频道中的线程源消息；hasThread 不依赖线程是否已缓存。
        || message.hasThread === true
        // 论坛/媒体帖的首楼与线程共用 ID，无需读取父频道或遍历历史。
        || (message.channel?.isThread() === true && message.id === message.channel.id);
}

module.exports = { isProtectedStarterMessage, THREAD_STARTER_PROTECTED_MESSAGE };
