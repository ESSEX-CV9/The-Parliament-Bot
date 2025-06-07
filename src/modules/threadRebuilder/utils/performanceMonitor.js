class PerformanceMonitor {
    constructor() {
        this.startTime = Date.now();
        this.checkpoints = new Map();
        this.counters = new Map();
        this.metrics = new Map();
        this.concurrencySnapshots = [];
    }

    // 记录检查点
    checkpoint(name) {
        this.checkpoints.set(name, Date.now());
    }

    // 增加计数器
    increment(name, value = 1) {
        const current = this.counters.get(name) || 0;
        this.counters.set(name, current + value);
    }

    // 记录指标
    recordMetric(name, value) {
        if (!this.metrics.has(name)) {
            this.metrics.set(name, []);
        }
        this.metrics.get(name).push({
            value: value,
            timestamp: Date.now()
        });
    }

    // 记录并发快照
    recordConcurrency(activeThreads, maxConcurrency) {
        this.concurrencySnapshots.push({
            active: activeThreads,
            max: maxConcurrency,
            utilization: (activeThreads / maxConcurrency) * 100,
            timestamp: Date.now()
        });
    }

    // 获取并发统计
    getConcurrencyStats() {
        if (this.concurrencySnapshots.length === 0) {
            return {
                averageUtilization: 0,
                maxUtilization: 0,
                minUtilization: 0,
                peakConcurrency: 0
            };
        }

        const utilizations = this.concurrencySnapshots.map(s => s.utilization);
        const activeCounts = this.concurrencySnapshots.map(s => s.active);

        return {
            averageUtilization: Math.round(utilizations.reduce((a, b) => a + b, 0) / utilizations.length),
            maxUtilization: Math.round(Math.max(...utilizations)),
            minUtilization: Math.round(Math.min(...utilizations)),
            peakConcurrency: Math.max(...activeCounts),
            totalSnapshots: this.concurrencySnapshots.length
        };
    }

    // 获取指标统计
    getMetricStats(name) {
        const values = this.metrics.get(name);
        if (!values || values.length === 0) {
            return null;
        }

        const numericValues = values.map(v => v.value);
        return {
            count: values.length,
            average: numericValues.reduce((a, b) => a + b, 0) / numericValues.length,
            min: Math.min(...numericValues),
            max: Math.max(...numericValues),
            total: numericValues.reduce((a, b) => a + b, 0)
        };
    }

    // 获取性能报告
    getReport() {
        const totalTime = Date.now() - this.startTime;
        const report = {
            totalTimeMs: totalTime,
            totalTimeFormatted: this.formatTime(totalTime),
            checkpoints: {},
            counters: Object.fromEntries(this.counters),
            concurrency: this.getConcurrencyStats(),
            metrics: {}
        };

        // 计算检查点间隔
        const checkpointEntries = Array.from(this.checkpoints.entries());
        for (let i = 0; i < checkpointEntries.length; i++) {
            const [name, time] = checkpointEntries[i];
            const elapsed = time - this.startTime;
            report.checkpoints[name] = {
                elapsedMs: elapsed,
                elapsedFormatted: this.formatTime(elapsed)
            };
        }

        // 计算指标统计
        for (const [name, values] of this.metrics.entries()) {
            report.metrics[name] = this.getMetricStats(name);
        }

        return report;
    }

    // 格式化时间
    formatTime(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        
        if (minutes > 0) {
            return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
        }
        return `${seconds}s`;
    }

    // 计算性能提升
    calculateSpeedup(serialTime, parallelTime) {
        if (parallelTime === 0) return 0;
        return Math.round((serialTime / parallelTime) * 100) / 100;
    }

    // 计算效率
    calculateEfficiency(speedup, numberOfThreads) {
        if (numberOfThreads === 0) return 0;
        return Math.round((speedup / numberOfThreads) * 100);
    }

    // 生成详细报告
    generateDetailedReport() {
        const report = this.getReport();
        const concurrency = report.concurrency;
        
        let output = '\n=== 详细性能监控报告 ===\n';
        output += `总耗时: ${report.totalTimeFormatted}\n`;
        
        if (Object.keys(report.checkpoints).length > 0) {
            output += '\n检查点:\n';
            for (const [name, data] of Object.entries(report.checkpoints)) {
                output += `  ${name}: ${data.elapsedFormatted}\n`;
            }
        }
        
        if (Object.keys(report.counters).length > 0) {
            output += '\n计数器:\n';
            for (const [name, count] of Object.entries(report.counters)) {
                output += `  ${name}: ${count}\n`;
            }
        }
        
        if (concurrency.totalSnapshots > 0) {
            output += '\n并发统计:\n';
            output += `  平均利用率: ${concurrency.averageUtilization}%\n`;
            output += `  最高利用率: ${concurrency.maxUtilization}%\n`;
            output += `  峰值并发: ${concurrency.peakConcurrency}\n`;
            output += `  监控快照: ${concurrency.totalSnapshots}\n`;
        }
        
        if (Object.keys(report.metrics).length > 0) {
            output += '\n性能指标:\n';
            for (const [name, stats] of Object.entries(report.metrics)) {
                if (stats) {
                    output += `  ${name}:\n`;
                    output += `    平均值: ${Math.round(stats.average * 100) / 100}\n`;
                    output += `    最小值: ${stats.min}\n`;
                    output += `    最大值: ${stats.max}\n`;
                    output += `    样本数: ${stats.count}\n`;
                }
            }
        }
        
        output += '=========================\n';
        return output;
    }

    // 打印报告
    printReport() {
        console.log(this.generateDetailedReport());
    }
}

module.exports = PerformanceMonitor; 