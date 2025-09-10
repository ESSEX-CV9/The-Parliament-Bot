function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(fn, maxRetries = 3, initialDelay = 1000, maxDelay = 30000) {
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            return await fn();
        } catch (error) {
            attempt++;
            if (attempt >= maxRetries) {
                console.error(`操作失败，已达到最大重试次数 (${maxRetries}):`, error);
                throw error;
            }
            
            // 使用指数退避策略计算延迟时间
            const backoff = Math.min(initialDelay * Math.pow(2, attempt - 1), maxDelay);
            const jitter = backoff * 0.2 * Math.random(); // 增加随机抖动
            const waitTime = backoff + jitter;

            console.warn(`操作失败 (尝试 ${attempt}/${maxRetries})。将在 ${Math.round(waitTime / 1000)} 秒后重试... 错误: ${error.message}`);
            await delay(waitTime);
        }
    }
}

module.exports = { withRetry, delay };