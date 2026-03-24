// src/modules/channelSummary/config/summaryConfig.js

module.exports = {
    MAX_MESSAGES: Number(process.env.SUMMARY_MAX_MESSAGES) || 1000,
    MAX_TIME_RANGE_DAYS: 30,
    FILE_RETENTION_HOURS: Number(process.env.SUMMARY_FILE_RETENTION_HOURS) || 24,

    OPENAI_API_CONFIG: {
        BASE_URL: process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1',
        API_KEY: process.env.OPENAI_API_KEY || '',
        MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini'
    },

    TIME_FORMATS: [
        'YYYY-MM-DD',
        'YYYYMMDD',
        'YYYY-MM-DD HH:mm',
        'MM-DD',
        'HH:mm'
    ],

    SUMMARY_DISPLAY: {
        MAX_TOPICS: 5,
        MAX_ACTIVE_USERS: 5,
        MAX_OVERVIEW_LENGTH: 1000,
        MAX_MESSAGE_LENGTH: 1900,
        MESSAGE_SEND_DELAY: 500
    }
};
