module.exports = {
    excel: {
        inputPath: './data/forum_backup.xlsx',
        outputPath: './data/results/',
        columns: {
            // 原始列
            POST_ID: 0,        // A列 - 帖子ID
            FORUM_ID: 1,       // B列 - 论坛ID  
            TITLE: 2,          // C列 - 帖子标题
            PUBLISH_TIME: 3,   // D列 - 发布时间
            AUTHOR_ID: 4,      // E列 - 发帖人ID
            MESSAGE_COUNT: 5,  // F列 - 消息数
            REACTION_COUNT: 6, // G列 - 反应数
            TAGS: 7,           // H列 - TAG
            CONTENT: 8,        // I列 - 首条消息内容
            MESSAGE_IMAGES: 9, // J列 - 首条消息图片CDN
            IMAGES: 10,        // K列 - 图片CDN
            // 新增列
            NEW_FORUM_ID: 11,  // L列 - 新论坛ID
            NEW_POST_ID: 12,   // M列 - 新帖子ID
            REBUILD_STATUS: 13, // N列 - 重建状态
            REBUILD_TIME: 14,  // O列 - 重建时间
            ERROR_MESSAGE: 15  // P列 - 错误信息
        }
    },
    rebuild: {
        batchSize: 5,           // 每批处理5个帖子
        delayBetweenPosts: 3000, // 帖子间延迟3秒
        maxRetries: 3,          // 失败重试3次
        webhookName: 'ForumRebuilder'
    },
    permissions: {
        adminOnly: true,        // 只允许管理员使用
        requiredPermissions: ['MANAGE_CHANNELS', 'MANAGE_WEBHOOKS']
    }
}; 