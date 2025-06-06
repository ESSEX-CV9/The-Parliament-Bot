module.exports = {
    // JSON文件路径配置
    jsonPath: 'data/rebuild/json',
    
    // 消息发送间隔（毫秒）
    messageDelay: 500,
    
    // Webhook配置
    webhook: {
        enabled: true,
        name: 'ThreadRebuilder',
        maxRetries: 3
    },
    
    // 文件处理配置
    attachments: {
        downloadEnabled: false, // 是否下载附件
        maxFileSize: 8 * 1024 * 1024, // 8MB
        timeout: 10000 // 10秒
    }
}; 