/**
 * 带重试机制的异步函数执行器
 */
async function executeWithRetry(asyncFunction, maxRetries = 3, delayMs = 1000) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await asyncFunction();
        } catch (error) {
            lastError = error;
            console.warn(`执行失败，第 ${attempt} 次尝试:`, error.message);
            
            if (attempt < maxRetries) {
                console.log(`等待 ${delayMs}ms 后重试...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
                delayMs *= 1.5; // 指数退避
            }
        }
    }
    
    throw lastError;
}

/**
 * 安全执行数据库操作
 */
async function safeDbOperation(operation, operationName = '数据库操作') {
    return executeWithRetry(
        operation,
        3, // 最多重试3次
        1000 // 初始延迟1秒
    ).catch(error => {
        console.error(`${operationName}最终失败:`, error);
        throw new Error(`${operationName}失败，请稍后重试`);
    });
}

module.exports = {
    executeWithRetry,
    safeDbOperation
}; 