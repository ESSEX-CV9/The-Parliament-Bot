const path = require('path');

module.exports = {
    excel: {
        // Excel文件路径
        filePath: 'data/backupCards/确认补卡项_带帖子ID_updated_20250703_010237.xlsx',
        // 开始列（2k图包的匹配结果）
        startColumn: 'H',
        // 结束列（角色卡30）
        endColumn: 'AL'
    },
    
    paths: {
        // 基础图片目录
        picDir: 'data/backupCards/pic',
        // characters目录（在pic目录内）
        characterDir: 'data/backupCards/pic/characters',
        // 类脑角色卡目录
        brainCardDir: 'data/backupCards/类脑角色卡'
    },
    
    discord: {
        // Discord基础URL
        baseUrl: 'https://discord.com/channels/1134557553011998840/',
        // 发送消息间隔（毫秒）
        rateLimitDelay: 1000,
        // 批处理大小
        batchSize: 10
    },
    
    processing: {
        // 最大重试次数
        maxRetries: 3,
        // 超时时间（毫秒）
        timeoutMs: 30000,
        // 是否记录详细进度
        logProgress: true,
        // 支持的图片格式
        supportedImageFormats: ['.png', '.jpg', '.jpeg', '.gif', '.webp'],
        // 支持的文件格式
        supportedFileFormats: ['.json', '.txt', '.card']
    },
    
    content: {
        // 文字描述关键词
        textDescriptions: [
            '作者自补',
            '网盘',
            '无需匹配',
            '作者已经自补',
            '源文档匹配失败'
        ],
        // Discord链接模式
        discordLinkPattern: /https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+/g
    }
}; 