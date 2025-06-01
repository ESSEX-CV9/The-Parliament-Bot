class RateLimiter {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.operationsThisSecond = 0;
        this.lastReset = Date.now();
        this.maxOperationsPerSecond = 5; // Discord API限制
    }

    async execute(operation) {
        return new Promise((resolve, reject) => {
            this.queue.push({ operation, resolve, reject });
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.processing || this.queue.length === 0) {
            return;
        }

        this.processing = true;

        while (this.queue.length > 0) {
            const now = Date.now();
            
            // 每秒重置操作计数
            if (now - this.lastReset >= 1000) {
                this.operationsThisSecond = 0;
                this.lastReset = now;
            }

            // 如果达到限制，等待到下一秒
            if (this.operationsThisSecond >= this.maxOperationsPerSecond) {
                const waitTime = 1000 - (now - this.lastReset);
                if (waitTime > 0) {
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                }
                continue;
            }

            const { operation, resolve, reject } = this.queue.shift();
            
            try {
                this.operationsThisSecond++;
                const result = await operation();
                resolve(result);
            } catch (error) {
                reject(error);
            }

            // 在操作之间添加小延迟，确保稳定性
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        this.processing = false;
    }

    getQueueLength() {
        return this.queue.length;
    }

    getOperationsThisSecond() {
        return this.operationsThisSecond;
    }
}

module.exports = { RateLimiter }; 