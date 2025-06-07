const ThreadRebuilder = require('./threadRebuilder');
const PerformanceMonitor = require('../utils/performanceMonitor');

/**
 * 并行线程管理器
 * 负责同时处理多个帖子的重建，保持单个帖子内消息的串行处理
 */
class ParallelThreadManager {
    constructor(targetForum, useWebhook = true, maxConcurrency = 3, progressTracker = null) {
        this.targetForum = targetForum;
        this.useWebhook = useWebhook;
        this.maxConcurrency = maxConcurrency;
        this.activeThreads = new Set();
        this.queue = [];
        this.results = [];
        this.completedCount = 0;
        this.totalCount = 0;
        this.performanceMonitor = new PerformanceMonitor();
        this.progressTracker = progressTracker;
    }

    /**
     * 并行处理多个帖子
     * @param {Array} threadDataArray - 帖子数据数组
     * @param {Function} progressCallback - 进度回调函数
     * @returns {Promise<Array>} 处理结果数组
     */
    async processMultipleThreads(threadDataArray, progressCallback = null) {
        console.log(`开始并行处理 ${threadDataArray.length} 个帖子，最大并发数: ${this.maxConcurrency}`);
        
        this.performanceMonitor.checkpoint('parallel_start');
        this.queue = [...threadDataArray];
        this.totalCount = threadDataArray.length;
        this.completedCount = 0;
        this.results = [];
        
        // 创建并发任务队列
        const workers = [];
        const actualConcurrency = Math.min(this.maxConcurrency, this.queue.length);
        
        console.log(`启动 ${actualConcurrency} 个并发工作线程`);
        
        // 启动工作线程
        for (let i = 0; i < actualConcurrency; i++) {
            workers.push(this.createWorker(i, progressCallback));
        }

        // 等待所有工作线程完成
        await Promise.all(workers);
        
        this.performanceMonitor.checkpoint('parallel_complete');
        this.performanceMonitor.increment('total_threads_processed', this.totalCount);
        
        console.log(`并行处理完成，共处理 ${this.totalCount} 个帖子`);
        this.performanceMonitor.printReport();
        
        return this.results;
    }

    /**
     * 创建工作线程
     * @param {number} workerId - 工作线程ID
     * @param {Function} progressCallback - 进度回调函数
     */
    async createWorker(workerId, progressCallback) {
        console.log(`工作线程 ${workerId} 启动`);
        
        while (this.queue.length > 0) {
            const threadData = this.queue.shift();
            if (!threadData) break;

            const threadTitle = threadData.threadInfo?.title || '未知帖子';
            const fileName = threadData.fileName || `thread_${this.results.length + 1}`;
            
            console.log(`工作线程 ${workerId} 开始处理: ${threadTitle}`);

            this.activeThreads.add(workerId);
            this.performanceMonitor.increment('active_threads_peak', this.activeThreads.size);
            
            // 标记文件开始处理
            if (this.progressTracker) {
                await this.progressTracker.markFileProcessing(fileName);
            }
            
            try {
                // 创建独立的ThreadRebuilder实例
                const threadRebuilder = new ThreadRebuilder(this.targetForum, this.useWebhook);
                
                // 处理单个帖子（保持原有串行逻辑）
                const result = await threadRebuilder.rebuildThread(
                    threadData,
                    (processedMessages, totalMessages) => {
                        // 内部消息处理进度（可选）
                        if (progressCallback) {
                            const threadProgress = `线程${workerId}: ${threadTitle} (${processedMessages}/${totalMessages})`;
                            this.updateOverallProgress(progressCallback, threadProgress);
                        }
                    }
                );

                const processResult = {
                    fileName: fileName,
                    success: true,
                    threadId: result.id,
                    threadName: result.name,
                    messagesCount: threadData.messages?.length || 0,
                    workerId: workerId,
                    result: result
                };

                this.results.push(processResult);

                // 标记文件完成
                if (this.progressTracker) {
                    await this.progressTracker.markFileCompleted(fileName, processResult);
                }

                console.log(`工作线程 ${workerId} 完成处理: ${threadTitle}`);
                this.performanceMonitor.increment('successful_threads');

            } catch (error) {
                console.error(`工作线程 ${workerId} 处理失败: ${threadTitle}`, error);
                
                const errorResult = {
                    fileName: fileName,
                    success: false,
                    error: error.message,
                    workerId: workerId,
                    threadTitle: threadTitle
                };

                this.results.push(errorResult);

                // 标记文件失败
                if (this.progressTracker) {
                    await this.progressTracker.markFileFailed(fileName, error.message);
                }
                
                this.performanceMonitor.increment('failed_threads');
            } finally {
                this.activeThreads.delete(workerId);
                this.completedCount++;
                
                // 更新总体进度
                if (progressCallback) {
                    this.updateOverallProgress(progressCallback);
                }
                
                // 线程间延迟，避免过快请求
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        
        console.log(`工作线程 ${workerId} 结束`);
    }

    /**
     * 更新总体进度
     * @param {Function} progressCallback - 进度回调函数
     * @param {string} threadProgress - 线程进度信息
     */
    updateOverallProgress(progressCallback, threadProgress = '') {
        if (progressCallback) {
            const progress = `并行处理进度: ${this.completedCount}/${this.totalCount} 个帖子\n` +
                           `活跃线程: ${this.activeThreads.size}/${this.maxConcurrency}\n` +
                           `完成度: ${Math.round((this.completedCount / this.totalCount) * 100)}%` +
                           (threadProgress ? `\n${threadProgress}` : '');
            
            progressCallback(progress);
        }
    }

    /**
     * 获取处理统计信息
     */
    getStatistics() {
        const successful = this.results.filter(r => r.success);
        const failed = this.results.filter(r => !r.success);
        
        return {
            total: this.results.length,
            successful: successful.length,
            failed: failed.length,
            successRate: this.results.length > 0 ? Math.round((successful.length / this.results.length) * 100) : 0,
            totalMessages: successful.reduce((sum, r) => sum + (r.messagesCount || 0), 0),
            performanceReport: this.performanceMonitor.getReport()
        };
    }

    /**
     * 生成详细的结果报告
     */
    generateDetailedReport() {
        const stats = this.getStatistics();
        const performanceReport = stats.performanceReport;
        
        let report = `📊 **并行处理结果汇总**\n\n`;
        report += `✅ 成功: ${stats.successful} 个帖子\n`;
        report += `❌ 失败: ${stats.failed} 个帖子\n`;
        report += `📈 成功率: ${stats.successRate}%\n`;
        report += `📝 总消息数: ${stats.totalMessages}\n`;
        report += `⏱️ 总耗时: ${performanceReport.totalTimeFormatted}\n`;
        report += `🚀 并发效率: ${this.maxConcurrency} 线程\n\n`;

        if (stats.successful > 0) {
            report += `**成功重建的帖子:**\n`;
            this.results.filter(r => r.success).forEach(result => {
                report += `• ${result.threadName || result.fileName}\n`;
                report += `  📝 消息数: ${result.messagesCount}\n`;
                report += `  🔗 帖子ID: ${result.threadId}\n`;
                report += `  🔧 处理线程: ${result.workerId}\n\n`;
            });
        }

        if (stats.failed > 0) {
            report += `**处理失败的帖子:**\n`;
            this.results.filter(r => !r.success).forEach(result => {
                report += `• ${result.threadTitle || result.fileName}\n`;
                report += `  ❌ 错误: ${result.error}\n`;
                report += `  🔧 处理线程: ${result.workerId}\n\n`;
            });
        }

        return report;
    }
}

module.exports = ParallelThreadManager; 