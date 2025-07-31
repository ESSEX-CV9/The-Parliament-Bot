// src/modules/channelSummary/config/summaryConfig.js

module.exports = {
    // 最大消息数量限制
    MAX_MESSAGES: process.env.SUMMARY_MAX_MESSAGES || 1000,
    
    // 最大时间范围（天）
    MAX_TIME_RANGE_DAYS: 30,
    
    // 临时文件保留时间（小时）
    FILE_RETENTION_HOURS: process.env.SUMMARY_FILE_RETENTION_HOURS || 24,
    
    // Gemini API配置
    GEMINI_MODEL: 'gemini-2.5-flash',
    
    //  OpenAI 兼容 API 配置
    OPENAI_API_CONFIG: {
        // 你的代理服务器 URL，从环境变量读取，若无则使用默认的 OpenAI 地址
        BASE_URL: process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1', 
        
        // 你的 API 密钥，从环境变量读取
        API_KEY: process.env.OPENAI_API_KEY || 'your-api-key',
        
        // 你希望使用的模型，从环境变量读取，可设置默认值
        MODEL: process.env.OPENAI_MODEL || 'gemini-2.5-pro'
    },
    
    // 支持的时间格式
    TIME_FORMATS: [
        'YYYY-MM-DD',
        'YYYYMMDD',
        'YYYY-MM-DD HH:mm',
        'MM-DD',
        'HH:mm'
    ],

    // 总结显示配置
    SUMMARY_DISPLAY: {
        MAX_TOPICS: 5,
        MAX_ACTIVE_USERS: 5,
        MAX_OVERVIEW_LENGTH: 1000,
        MAX_MESSAGE_LENGTH: 1900,  // Discord消息最大长度限制
        MESSAGE_SEND_DELAY: 500    // 分段发送间隔(ms)
    }
};