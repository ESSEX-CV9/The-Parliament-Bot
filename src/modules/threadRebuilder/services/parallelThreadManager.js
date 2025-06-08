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
        
        // 线程状态跟踪
        this.threadStates = new Map(); // workerId -> { threadTitle, processedMessages, totalMessages, status }
        this.lastProgressUpdate = 0;
        this.progressUpdateThrottle = 3000; // 3秒更新一次总体进度
        
        // 断点重启相关
        this.initialCompletedCount = 0; // 会话开始时已完成的数量
        this.sessionTotalFiles = 0; // 会话的总文件数
        this.autoArchive = true; // 自动归档选项
        this.excelReader = null; // 添加Excel读取器
    }

    /**
     * 设置Excel读取器
     */
    setExcelReader(excelReader) {
        this.excelReader = excelReader;
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
        this.threadStates.clear();
        
        // 获取会话的总体进度信息
        if (this.progressTracker) {
            const stats = this.progressTracker.getProgressStats();
            this.sessionTotalFiles = stats.totalFiles;
            this.initialCompletedCount = stats.completedFiles + stats.failedFiles + stats.skippedFiles;
            
            console.log(`会话总进度 - 总文件: ${this.sessionTotalFiles}, 已完成: ${this.initialCompletedCount}, 待处理: ${this.totalCount}`);
        }
        
        // 创建并发任务队列
        const workers = [];
        const actualConcurrency = Math.min(this.maxConcurrency, this.queue.length);
        
        console.log(`启动 ${actualConcurrency} 个并发工作线程`);
        
        // 初始化所有线程状态
        for (let i = 0; i < actualConcurrency; i++) {
            this.threadStates.set(i, {
                threadTitle: '等待分配任务...',
                processedMessages: 0,
                totalMessages: 0,
                status: 'waiting'
            });
        }
        
        // 发送初始进度
        if (progressCallback) {
            this.updateOverallProgress(progressCallback);
        }
        
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
     * 创建工作线程（支持断点重启）
     */
    async createWorker(workerId, progressCallback) {
        console.log(`工作线程 ${workerId} 启动`);
        
        while (this.queue.length > 0) {
            const threadData = this.queue.shift();
            if (!threadData) break;

            const threadTitle = threadData.threadInfo?.title || '未知帖子';
            const fileName = threadData.fileName || `thread_${this.results.length + 1}`;
            
            console.log(`工作线程 ${workerId} 开始处理: ${threadTitle}`);

            // 获取断点重启信息
            const resumeInfo = threadData.resumeInfo || null;
            
            // 更新线程状态
            const totalMessages = threadData.messages?.length || 0;
            const initialProgress = resumeInfo ? resumeInfo.processedMessages : 0;
            
            this.updateThreadState(workerId, {
                threadTitle: this.truncateTitle(threadTitle),
                processedMessages: initialProgress,
                totalMessages: totalMessages,
                status: 'processing'
            });

            this.activeThreads.add(workerId);
            this.performanceMonitor.increment('active_threads_peak', this.activeThreads.size);
            
            // 标记文件开始处理（如果不是恢复）
            if (this.progressTracker && (!resumeInfo || !resumeInfo.canResume)) {
                await this.progressTracker.markFileProcessing(fileName);
            }
            
            try {
                // 创建独立的ThreadRebuilder实例
                const threadRebuilder = new ThreadRebuilder(this.targetForum, this.useWebhook);
                
                // 设置Excel读取器（如果有的话）
                if (this.excelReader) {
                    threadRebuilder.setExcelReader(this.excelReader);
                    threadRebuilder.setExcelDataLoaded(true);
                }
                
                // 设置进度跟踪器
                if (this.progressTracker) {
                    threadRebuilder.setProgressTracker(this.progressTracker);
                }
                
                // 处理单个帖子（支持断点重启）
                const result = await threadRebuilder.rebuildThread(
                    threadData,
                    (processedMessages, totalMessages) => {
                        // 更新线程内部进度
                        this.updateThreadState(workerId, {
                            threadTitle: this.truncateTitle(threadTitle),
                            processedMessages: processedMessages,
                            totalMessages: totalMessages,
                            status: 'processing'
                        });
                        
                        // 节流更新总体进度
                        this.throttledProgressUpdate(progressCallback);
                    },
                    resumeInfo // 传递断点重启信息
                );

                // 自动归档线程（如果启用）
                let archived = false;
                if (this.autoArchive && result.id) {
                    try {
                        const thread = await this.targetForum.threads.fetch(result.id);
                        await thread.setArchived(true);
                        archived = true;
                        console.log(`工作线程 ${workerId} 已自动归档线程: ${threadTitle}`);
                    } catch (archiveError) {
                        console.warn(`工作线程 ${workerId} 归档线程失败: ${threadTitle}, ${archiveError.message}`);
                    }
                }

                const processResult = {
                    fileName: fileName,
                    success: true,
                    threadId: result.id,
                    threadName: result.name,
                    messagesCount: result.messagesProcessed || 0,
                    archived: archived,
                    workerId: workerId,
                    result: result
                };

                this.results.push(processResult);

                // 标记文件完成
                if (this.progressTracker) {
                    await this.progressTracker.markFileCompleted(fileName, processResult);
                }

                // 更新线程状态为完成
                this.updateThreadState(workerId, {
                    threadTitle: this.truncateTitle(threadTitle),
                    processedMessages: result.messagesProcessed || 0,
                    totalMessages: totalMessages,
                    status: 'completed'
                });

                console.log(`工作线程 ${workerId} 完成处理: ${threadTitle}`);
                this.performanceMonitor.increment('successful_threads');

            } catch (error) {
                console.error(`工作线程 ${workerId} 处理失败: ${threadTitle}`, error);
                
                // 更新线程状态为失败
                this.updateThreadState(workerId, {
                    threadTitle: this.truncateTitle(threadTitle),
                    processedMessages: initialProgress,
                    totalMessages: totalMessages,
                    status: 'failed'
                });
                
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
                
                // 更新线程状态为空闲
                this.updateThreadState(workerId, {
                    threadTitle: '等待下一个任务...',
                    processedMessages: 0,
                    totalMessages: 0,
                    status: 'waiting'
                });
                
                // 更新总体进度
                if (progressCallback) {
                    this.updateOverallProgress(progressCallback);
                }
                
                // 线程间延迟，避免过快请求
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        
        // 线程结束
        this.updateThreadState(workerId, {
            threadTitle: '已完成所有任务',
            processedMessages: 0,
            totalMessages: 0,
            status: 'finished'
        });
        
        console.log(`工作线程 ${workerId} 结束`);
    }

    /**
     * 更新线程状态
     * @param {number} workerId - 工作线程ID
     * @param {Object} state - 状态信息
     */
    updateThreadState(workerId, state) {
        this.threadStates.set(workerId, {
            ...this.threadStates.get(workerId),
            ...state,
            lastUpdate: Date.now()
        });
    }

    /**
     * 截断标题显示
     */
    truncateTitle(title, maxLength = 60) {
        if (title.length <= maxLength) {
            return title;
        }
        return title.substring(0, maxLength - 3) + '...';
    }

    /**
     * 节流的进度更新
     */
    throttledProgressUpdate(progressCallback) {
        const now = Date.now();
        if (now - this.lastProgressUpdate > this.progressUpdateThrottle) {
            this.lastProgressUpdate = now;
            if (progressCallback) {
                this.updateOverallProgress(progressCallback);
            }
        }
    }

    /**
     * 更新总体进度
     * @param {Function} progressCallback - 进度回调函数
     */
    updateOverallProgress(progressCallback) {
        if (!progressCallback) return;

        // 计算总体进度 - 考虑断点重启
        let currentCompleted = this.initialCompletedCount + this.completedCount;
        let totalFiles = this.sessionTotalFiles > 0 ? this.sessionTotalFiles : this.totalCount;
        
        // 如果没有progressTracker，使用当前批次的进度
        if (!this.progressTracker) {
            currentCompleted = this.completedCount;
            totalFiles = this.totalCount;
        }
        
        const completedPercentage = totalFiles > 0 ? 
            Math.round((currentCompleted / totalFiles) * 100) : 0;
        
        // 构建进度消息
        let progress = `帖子处理进度: 完成 ${currentCompleted}/${totalFiles} 个帖子\n`;
        progress += `活跃线程: ${this.activeThreads.size}/${this.maxConcurrency}\n`;
        
        // 如果是断点重启，显示额外信息
        if (this.progressTracker && this.initialCompletedCount > 0) {
            const currentBatchCompleted = this.completedCount;
            const currentBatchTotal = this.totalCount;
            progress += `当前批次: 完成 ${currentBatchCompleted}/${currentBatchTotal} 个帖子\n`;
        }
        
        progress += `完成度: ${completedPercentage}%\n`;
        
        // 显示所有线程状态
        const sortedThreads = Array.from(this.threadStates.entries()).sort((a, b) => a[0] - b[0]);
        
        for (const [workerId, state] of sortedThreads) {
            const statusIcon = this.getStatusIcon(state.status);
            const progressBar = state.totalMessages > 0 ? 
                ` (${state.processedMessages}/${state.totalMessages})` : '';
            
            progress += `${statusIcon} 线程${workerId}: ${state.threadTitle}${progressBar}\n`;
        }
        
        // 总进度
        progress += `📊 总进度: ${completedPercentage}%`;
        
        progressCallback(progress);
    }

    /**
     * 获取状态图标
     */
    getStatusIcon(status) {
        const icons = {
            'waiting': '⏳',
            'processing': '🔄',
            'completed': '✅',
            'failed': '❌',
            'finished': '🏁'
        };
        return icons[status] || '❓';
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

    /**
     * 获取所有线程的当前状态快照
     */
    getThreadStatesSnapshot() {
        const snapshot = {};
        for (const [workerId, state] of this.threadStates.entries()) {
            snapshot[workerId] = {
                ...state,
                progressPercentage: state.totalMessages > 0 ? 
                    Math.round((state.processedMessages / state.totalMessages) * 100) : 0
            };
        }
        return snapshot;
    }

    /**
     * 获取会话级别的进度信息
     */
    getSessionProgress() {
        let currentCompleted = this.initialCompletedCount + this.completedCount;
        let totalFiles = this.sessionTotalFiles > 0 ? this.sessionTotalFiles : this.totalCount;
        
        return {
            currentCompleted: currentCompleted,
            totalFiles: totalFiles,
            initialCompleted: this.initialCompletedCount,
            currentBatchCompleted: this.completedCount,
            currentBatchTotal: this.totalCount,
            overallPercentage: totalFiles > 0 ? Math.round((currentCompleted / totalFiles) * 100) : 0,
            batchPercentage: this.totalCount > 0 ? Math.round((this.completedCount / this.totalCount) * 100) : 0
        };
    }

    /**
     * 设置自动归档选项
     */
    setAutoArchive(autoArchive) {
        this.autoArchive = autoArchive;
        console.log(`自动归档设置为: ${autoArchive}`);
    }
}

module.exports = ParallelThreadManager; 