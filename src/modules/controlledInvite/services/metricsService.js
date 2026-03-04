const { EmbedBuilder } = require('discord.js');
const runtimeConfig = require('../utils/runtimeConfig');

const METRICS_ALERT_CHANNEL_ID = process.env.CI_METRICS_ALERT_CHANNEL_ID || '';

let reportInterval = null;
let runtimeSnapshotProvider = null;
let currentWindow = createWindow();

function createWindow() {
    return {
        startedAt: Date.now(),
        totalRequests: 0,
        successRequests: 0,
        failedRequests: 0,
        unknownInteractionCount: 0,
        retry429Count: 0,
        overloadRejectedCount: 0,
        idempotentLockedCount: 0,

        logEnqueuedCount: 0,
        logSentCount: 0,
        logFailedCount: 0,
        logDroppedCount: 0,

        queueWaitSamples: [],
        latencySamples: [],
        maxQueueDepthAtRun: 0,
        outcomeCounts: {},
    };
}

function percentile(arr, p) {
    if (!arr || arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
}

function avg(arr) {
    if (!arr || arr.length === 0) return 0;
    return Math.round(arr.reduce((s, x) => s + x, 0) / arr.length);
}

function setInviteRuntimeSnapshotProvider(provider) {
    runtimeSnapshotProvider = provider;
}

function recordInviteRequestTrace(trace) {
    currentWindow.totalRequests += 1;

    const outcome = trace?.outcome || 'unknown';
    currentWindow.outcomeCounts[outcome] = (currentWindow.outcomeCounts[outcome] || 0) + 1;

    if (outcome === 'success') {
        currentWindow.successRequests += 1;
    }

    if (outcome === 'failed' || outcome === 'ack_failed') {
        currentWindow.failedRequests += 1;
    }

    if (typeof trace?.totalMs === 'number' && trace.totalMs >= 0) {
        currentWindow.latencySamples.push(trace.totalMs);
    }

    if (typeof trace?.queueWaitMs === 'number' && trace.queueWaitMs >= 0) {
        currentWindow.queueWaitSamples.push(trace.queueWaitMs);
    }

    if (typeof trace?.queueDepthAtRun === 'number' && trace.queueDepthAtRun > currentWindow.maxQueueDepthAtRun) {
        currentWindow.maxQueueDepthAtRun = trace.queueDepthAtRun;
    }
}

function recordUnknownInteraction() {
    currentWindow.unknownInteractionCount += 1;
}

function recordRetryAttempt(statusCode) {
    if (statusCode === 429) {
        currentWindow.retry429Count += 1;
    }
}

function recordOverloadRejected() {
    currentWindow.overloadRejectedCount += 1;
}

function recordIdempotentLocked() {
    currentWindow.idempotentLockedCount += 1;
}

function recordLogQueueEvent(type) {
    switch (type) {
        case 'enqueued':
            currentWindow.logEnqueuedCount += 1;
            break;
        case 'sent':
            currentWindow.logSentCount += 1;
            break;
        case 'failed':
            currentWindow.logFailedCount += 1;
            break;
        case 'dropped':
            currentWindow.logDroppedCount += 1;
            break;
    }
}

async function sendAlertEmbed(client, alerts, summaryLines) {
    if (!METRICS_ALERT_CHANNEL_ID) return;

    try {
        const channel = await client.channels.fetch(METRICS_ALERT_CHANNEL_ID).catch(() => null);
        if (!channel) return;

        const embed = new EmbedBuilder()
            .setTitle('🚨 ControlledInvite 指标告警')
            .setDescription([
                '以下指标已超过阈值：',
                ...alerts.map(a => `• ${a}`),
                '',
                '**当前窗口摘要**',
                ...summaryLines,
            ].join('\n'))
            .setColor(0xED4245)
            .setTimestamp();

        await channel.send({ embeds: [embed] });
    } catch (err) {
        console.error('[ControlledInvite][Metrics] 发送告警失败:', err);
    }
}

async function flushMetrics(client) {
    const window = currentWindow;
    currentWindow = createWindow();

    const now = Date.now();
    const durationSec = Math.max(1, Math.round((now - window.startedAt) / 1000));
    const qps = (window.totalRequests / durationSec).toFixed(2);

    const latencyAvg = avg(window.latencySamples);
    const latencyP95 = percentile(window.latencySamples, 95);
    const queueWaitAvg = avg(window.queueWaitSamples);
    const queueWaitP95 = percentile(window.queueWaitSamples, 95);

    const runtimeSnapshot = runtimeSnapshotProvider ? runtimeSnapshotProvider() : {};
    const successRate = window.totalRequests > 0
        ? ((window.successRequests / window.totalRequests) * 100).toFixed(1)
        : '0.0';
    const errorRate = window.totalRequests > 0
        ? ((window.failedRequests / window.totalRequests) * 100).toFixed(1)
        : '0.0';

    const topOutcomes = Object.entries(window.outcomeCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => `${name}:${count}`)
        .join(', ') || '无';

    const summaryLines = [
        `窗口: ${durationSec}s | 请求: ${window.totalRequests} | QPS: ${qps}`,
        `成功: ${window.successRequests} | 失败: ${window.failedRequests} | 成功率: ${successRate}% | 失败率: ${errorRate}%`,
        `延迟: avg=${latencyAvg}ms p95=${latencyP95}ms | 排队等待: avg=${queueWaitAvg}ms p95=${queueWaitP95}ms`,
        `429重试: ${window.retry429Count} | UnknownInteraction: ${window.unknownInteractionCount}`,
        `过载拒绝: ${window.overloadRejectedCount} | 幂等拦截: ${window.idempotentLockedCount}`,
        `队列(邀请): pending=${runtimeSnapshot.inviteQueuePending || 0} maxSubPending=${runtimeSnapshot.inviteQueueMaxPendingPerSub || 0} maxAtRun=${window.maxQueueDepthAtRun}`,
        `队列(日志): pending=${runtimeSnapshot.logQueuePending || 0} running=${runtimeSnapshot.logQueueRunning || 0} droppedTotal=${runtimeSnapshot.logQueueDropped || 0}`,
        `日志统计: enqueued=${window.logEnqueuedCount} sent=${window.logSentCount} failed=${window.logFailedCount} dropped=${window.logDroppedCount}`,
        `TopOutcomes: ${topOutcomes}`,
    ];

    console.log('[ControlledInvite][Metrics] ' + summaryLines.join(' | '));

    const alerts = [];

    if (window.unknownInteractionCount >= runtimeConfig.get('alertUnknownInteractionThreshold')) {
        alerts.push(`UnknownInteraction 次数过高: ${window.unknownInteractionCount} (阈值 ${runtimeConfig.get('alertUnknownInteractionThreshold')})`);
    }
    if (window.retry429Count >= runtimeConfig.get('alert429Threshold')) {
        alerts.push(`429 重试次数过高: ${window.retry429Count} (阈值 ${runtimeConfig.get('alert429Threshold')})`);
    }
    if (Number(errorRate) >= runtimeConfig.get('alertErrorRatePercent') && window.totalRequests >= 10) {
        alerts.push(`失败率过高: ${errorRate}% (阈值 ${runtimeConfig.get('alertErrorRatePercent')}%)`);
    }
    if (latencyP95 >= runtimeConfig.get('alertP95LatencyMs') && window.latencySamples.length >= 10) {
        alerts.push(`P95 延迟过高: ${latencyP95}ms (阈值 ${runtimeConfig.get('alertP95LatencyMs')}ms)`);
    }
    if ((runtimeSnapshot.inviteQueuePending || 0) >= runtimeConfig.get('alertQueuePendingThreshold')) {
        alerts.push(`邀请码队列积压: ${runtimeSnapshot.inviteQueuePending} (阈值 ${runtimeConfig.get('alertQueuePendingThreshold')})`);
    }
    if ((runtimeSnapshot.logQueuePending || 0) >= runtimeConfig.get('alertLogQueuePendingThreshold')) {
        alerts.push(`日志队列积压: ${runtimeSnapshot.logQueuePending} (阈值 ${runtimeConfig.get('alertLogQueuePendingThreshold')})`);
    }

    if (alerts.length > 0) {
        console.warn('[ControlledInvite][Metrics][ALERT] ' + alerts.join(' | '));
        await sendAlertEmbed(client, alerts, summaryLines);
    }
}

function startControlledInviteMetricsReporter(client) {
    if (reportInterval) {
        clearInterval(reportInterval);
    }

    const intervalMs = runtimeConfig.get('metricsReportIntervalMs');
    reportInterval = setInterval(() => {
        flushMetrics(client).catch(err => {
            console.error('[ControlledInvite][Metrics] 刷新指标失败:', err);
        });
    }, intervalMs);

    console.log(`[ControlledInvite][Metrics] ✅ 指标上报已启动（间隔 ${intervalMs}ms）`);
}

function stopControlledInviteMetricsReporter() {
    if (reportInterval) {
        clearInterval(reportInterval);
        reportInterval = null;
    }
}

module.exports = {
    setInviteRuntimeSnapshotProvider,
    recordInviteRequestTrace,
    recordUnknownInteraction,
    recordRetryAttempt,
    recordOverloadRejected,
    recordIdempotentLocked,
    recordLogQueueEvent,
    startControlledInviteMetricsReporter,
    stopControlledInviteMetricsReporter,
};
