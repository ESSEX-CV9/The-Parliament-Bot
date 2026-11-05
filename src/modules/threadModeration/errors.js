class SafetyError extends Error {
    constructor(message) { super(message); this.name = 'SafetyError'; }
}

function describe(error) {
    if (error instanceof SafetyError) return error.message;
    const status = error?.status;
    if (status === 403 || [50001, 50013].includes(error?.code)) return 'Discord 拒绝访问（403），请检查权限。';
    if (status === 404 || [10003, 10008].includes(error?.code)) return '帖子或公示不存在、已删除或不可访问（404）。';
    if (status === 429 || error?.name === 'RateLimitError') return 'Discord 限流（429），本次未盲目重试，请稍后核验。';
    return `请求或存储失败（${String(error?.code || error?.name || 'unknown').slice(0, 60)}），需核验实际状态。`;
}

// Only a definite API rejection establishes that a write was not accepted.
function definiteRejection(error) {
    return error?.name === 'RateLimitError' || [400, 401, 403, 404, 429].includes(error?.status)
        || [10003, 10008, 50001, 50013, 50035].includes(error?.code);
}

module.exports = { SafetyError, describe, definiteRejection };
