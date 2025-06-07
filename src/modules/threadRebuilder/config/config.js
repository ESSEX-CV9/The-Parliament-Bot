module.exports = {
    // JSON文件路径配置
    jsonPath: 'data/rebuild/json',
    
    // 消息发送间隔（毫秒）- 优化后的延迟
    messageDelay: 50, // 从500ms减少到50ms
    
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
    },
    
    // 并行处理配置
    parallel: {
        // 最大并发帖子数 - 建议根据服务器性能调整
        maxConcurrentThreads: 3,
        
        // 最大并发文件读取数
        maxConcurrentFileReads: 5,
        
        // 帖子间处理延迟（毫秒）
        threadProcessingDelay: 100,
        
        // 批处理大小
        batchSize: 10,
        
        // 自动调整并发数
        autoScaling: {
            enabled: false,
            minConcurrency: 1,
            maxConcurrency: 5,
            adjustmentThreshold: 0.8 // 80%成功率以下时降低并发
        }
    },
    
    // 断点重启配置
    resume: {
        // 是否启用断点重启
        enabled: true,
        
        // 进度文件保存间隔（毫秒）
        saveInterval: 5000,
        
        // 是否自动清理完成的会话
        autoCleanCompleted: true,
        
        // 保留报告文件的天数
        reportRetentionDays: 30
    },
    
    // 报告配置
    reports: {
        // 报告输出目录
        outputDir: 'data/rebuild/reports',
        
        // 报告文件名格式
        fileNameFormat: '重建报告_{sessionId}_{date}.xlsx',
        
        // 是否包含详细错误信息
        includeDetailedErrors: true
    },
    
    // 进度消息配置
    progress: {
        // 进度更新间隔（毫秒）- 公开消息使用更长间隔避免刷屏
        updateInterval: 5000,
        
        // 线程进度更新节流间隔（毫秒）
        threadProgressThrottle: 3000,
        
        // 是否使用公开消息显示进度（避免token过期）
        usePublicMessages: true,
        
        // 进度消息的详细程度
        verboseLevel: 'normal', // 'minimal', 'normal', 'detailed'
        
        // 标题截断长度
        titleMaxLength: 60,
        
        // 是否显示线程内部进度
        showThreadProgress: true,
        
        // 错误重试配置
        retryConfig: {
            maxRetries: 3,
            retryDelay: 1000
        }
    }
};