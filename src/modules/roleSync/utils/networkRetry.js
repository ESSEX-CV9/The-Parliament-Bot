function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNetworkError(error) {
    if (!error) return false;

    const code = String(error.code || '').toUpperCase();
    if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
        return true;
    }

    const message = String(error.message || '').toLowerCase();
    return (
        message.includes('econnreset') ||
        message.includes('network') ||
        message.includes('socket hang up') ||
        message.includes('fetch failed') ||
        message.includes('read timeout')
    );
}

async function withRetry(task, options = {}) {
    const {
        retries = 2,
        baseDelayMs = 400,
        maxDelayMs = 3000,
        factor = 2,
        jitterMs = 120,
        label = 'task',
    } = options;

    let attempt = 0;
    let lastError;

    while (attempt <= retries) {
        try {
            return await task();
        } catch (error) {
            lastError = error;
            if (!isNetworkError(error) || attempt >= retries) {
                throw error;
            }

            const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(factor, attempt));
            const jitter = Math.floor(Math.random() * (jitterMs + 1));
            const wait = exp + jitter;

            console.warn(`[RoleSync] ⚠️ 网络抖动，准备重试 ${label}（attempt=${attempt + 1}/${retries + 1}, wait=${wait}ms）:`, error.message || error);
            await sleep(wait);
            attempt += 1;
        }
    }

    throw lastError;
}

module.exports = {
    withRetry,
    isNetworkError,
};
