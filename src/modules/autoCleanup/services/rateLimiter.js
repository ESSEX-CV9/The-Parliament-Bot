class RateLimiter {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.operationsThisSecond = 0;
        this.lastReset = Date.now();
        this.maxOperationsPerSecond = 5; // Discord API限制
        
        // 新增：智能调度相关
        this.operationTypes = {
            scan: [],      // 扫描操作队列
            delete: [],    // 删除操作队列
            other: []      // 其他操作队列
        };
        this.callHistory = []; // API调用历史
        this.lastCallTime = 0; // 上次调用时间
    }

    async execute(operation, type = 'other') {
        return new Promise((resolve, reject) => {
            const operationItem = { operation, resolve, reject, timestamp: Date.now() };
            
            // 根据类型分类入队
            if (this.operationTypes[type]) {
                this.operationTypes[type].push(operationItem);
            } else {
                this.operationTypes.other.push(operationItem);
            }
            
            this.processQueueIntelligent();
        });
    }

    async processQueueIntelligent() {
        if (this.processing) return;
        this.processing = true;

        while (this.hasOperations()) {
            const now = Date.now();
            
            // 清理过期的API调用历史
            this.callHistory = this.callHistory.filter(time => now - time < 1000);
            
            // 检查是否可以执行新的操作
            if (this.callHistory.length >= this.maxOperationsPerSecond) {
                const waitTime = 1000 - (now - this.callHistory[0]);
                if (waitTime > 0) {
                    await new Promise(resolve => setTimeout(resolve, Math.min(waitTime, 100)));
                    continue;
                }
            }

            // 智能选择下一个操作
            const nextOperation = this.selectNextOperation();
            if (!nextOperation) break;

            try {
                const startTime = Date.now();
                const result = await nextOperation.operation();
                const executionTime = Date.now() - startTime;
                
                // 记录API调用
                this.callHistory.push(now);
                this.lastCallTime = now;
                
                nextOperation.resolve(result);
                
                // 动态调整延迟：快速操作减少延迟，慢操作增加延迟
                const dynamicDelay = this.calculateDynamicDelay(executionTime);
                if (dynamicDelay > 0) {
                    await new Promise(resolve => setTimeout(resolve, dynamicDelay));
                }
                
            } catch (error) {
                nextOperation.reject(error);
                // 错误时稍微增加延迟
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }

        this.processing = false;
    }

    selectNextOperation() {
        const totalOperations = this.getTotalOperationsCount();
        if (totalOperations === 0) return null;

        const scanCount = this.operationTypes.scan.length;
        const deleteCount = this.operationTypes.delete.length;
        const otherCount = this.operationTypes.other.length;

        // 其他操作最高优先级
        if (otherCount > 0) {
            return this.operationTypes.other.shift();
        }

        // 极度激进扫描策略：95%的API调用用于扫描
        const totalScanDelete = scanCount + deleteCount;
        if (totalScanDelete === 0) return null;

        const scanRatio = scanCount / totalScanDelete;
        
        // 如果扫描比例低于95%，优先扫描
        if (scanRatio < 0.95 && scanCount > 0) {
            return this.operationTypes.scan.shift();
        }
        
        // 极少的删除操作
        if (deleteCount > 0 && scanRatio >= 0.9) {
            return this.operationTypes.delete.shift();
        }
        
        // 默认扫描
        if (scanCount > 0) {
            return this.operationTypes.scan.shift();
        }
        
        if (deleteCount > 0) {
            return this.operationTypes.delete.shift();
        }

        return null;
    }

    calculateDynamicDelay(executionTime) {
        // 极度激进的延迟策略
        const apiUtilization = this.callHistory.length / this.maxOperationsPerSecond;
        
        // 更小的基础延迟
        const baseDelay = 1000 / this.maxOperationsPerSecond * 0.3; // 60ms基础延迟
        
        // 几乎无利用率调整
        const utilizationFactor = apiUtilization > 0.95 ? 1.1 : 0.8;
        
        // 极小的执行时间影响
        const executionFactor = executionTime < 30 ? 0.2 : 
                               executionTime < 100 ? 0.5 : 1.0;
        
        const dynamicDelay = baseDelay * utilizationFactor * executionFactor;
        
        // 极小的延迟范围（2ms-100ms）
        return Math.max(2, Math.min(100, dynamicDelay));
    }

    hasOperations() {
        return this.getTotalOperationsCount() > 0;
    }

    getTotalOperationsCount() {
        return this.operationTypes.scan.length + 
               this.operationTypes.delete.length + 
               this.operationTypes.other.length;
    }

    getQueueLength() {
        return this.getTotalOperationsCount();
    }

    getOperationsThisSecond() {
        return this.callHistory.length;
    }

    // 获取队列统计信息
    getQueueStats() {
        return {
            scan: this.operationTypes.scan.length,
            delete: this.operationTypes.delete.length,
            other: this.operationTypes.other.length,
            total: this.getTotalOperationsCount(),
            apiCallsThisSecond: this.callHistory.length
        };
    }

    // 向后兼容的旧方法
    async processQueue() {
        return this.processQueueIntelligent();
    }
}

module.exports = { RateLimiter }; 