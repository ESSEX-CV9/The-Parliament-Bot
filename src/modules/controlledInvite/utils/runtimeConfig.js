/**
 * 受控邀请系统 —— 运行时参数管理
 *
 * 所有调优参数集中在此，启动时从 DB 加载，修改时同步写 DB + 内存。
 * 对外暴露 get / set / reset / getAll / loadAll API。
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '../../../../data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_FILE = path.join(DATA_DIR, 'controlledInvite.sqlite');
const db = new Database(DB_FILE);

// ==================== 参数定义 ====================

const PARAM_DEFINITIONS = {
    // 过载保护
    globalMaxInflight: {
        defaultValue: 120,
        label: '全局同时处理中申请上限',
        group: '过载保护',
    },
    subMaxInflight: {
        defaultValue: 30,
        label: '单分服同时处理中申请上限',
        group: '过载保护',
    },

    // 幂等锁
    idempotentLockTtlMs: {
        defaultValue: 8000,
        label: '重复点击幂等锁时长 (ms)',
        group: '幂等锁',
    },

    // DB 预占位
    reservationTtlSeconds: {
        defaultValue: 45,
        label: 'DB 预占位超时 (s)',
        group: 'DB预占位',
    },

    // 邀请码重试
    retryMaxAttempts: {
        defaultValue: 3,
        label: '邀请码创建最大重试次数',
        group: '邀请码重试',
    },
    retryBaseDelayMs: {
        defaultValue: 350,
        label: '重试基础退避时长 (ms)',
        group: '邀请码重试',
    },

    // 日志队列
    logQueueMaxPending: {
        defaultValue: 500,
        label: '日志队列最大积压',
        group: '日志队列',
    },
    logQueueWarnThreshold: {
        defaultValue: 200,
        label: '日志队列积压告警阈值',
        group: '日志队列',
    },

    // 指标上报
    metricsReportIntervalMs: {
        defaultValue: 60000,
        label: '指标汇总周期 (ms)',
        group: '指标上报',
    },

    // 告警阈值
    alertUnknownInteractionThreshold: {
        defaultValue: 8,
        label: 'UnknownInteraction 告警阈值',
        group: '告警阈值',
    },
    alert429Threshold: {
        defaultValue: 10,
        label: '429 重试告警阈值',
        group: '告警阈值',
    },
    alertErrorRatePercent: {
        defaultValue: 15,
        label: '失败率告警阈值 (%)',
        group: '告警阈值',
    },
    alertP95LatencyMs: {
        defaultValue: 5000,
        label: 'P95 延迟告警阈值 (ms)',
        group: '告警阈值',
    },
    alertQueuePendingThreshold: {
        defaultValue: 80,
        label: '邀请码队列积压告警阈值',
        group: '告警阈值',
    },
    alertLogQueuePendingThreshold: {
        defaultValue: 120,
        label: '日志队列积压告警阈值',
        group: '告警阈值',
    },

    // 告警频道
    metricsAlertChannelId: {
        defaultValue: '',
        label: '告警推送频道 ID',
        group: '告警频道',
        type: 'string',
    },
};

// ==================== 内存缓存 ====================

/** @type {Map<string, number|string>} */
const cache = new Map();

// ==================== DB 操作 ====================

let initialized = false;
const stmts = {};

function ensureTable() {
    if (initialized) return;

    db.exec(`
        CREATE TABLE IF NOT EXISTS ci_runtime_params (
            key         TEXT PRIMARY KEY,
            value       TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );
    `);

    stmts.get = db.prepare('SELECT value FROM ci_runtime_params WHERE key = ?');
    stmts.upsert = db.prepare(`
        INSERT INTO ci_runtime_params (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    stmts.delete = db.prepare('DELETE FROM ci_runtime_params WHERE key = ?');
    stmts.all = db.prepare('SELECT key, value FROM ci_runtime_params');

    initialized = true;
}

// ==================== 公共 API ====================

/**
 * 启动时调用，从 DB 加载所有已保存的参数到内存。
 */
function loadAll() {
    ensureTable();

    const rows = stmts.all.all();
    for (const row of rows) {
        const def = PARAM_DEFINITIONS[row.key];
        if (!def) continue;

        if (def.type === 'string') {
            cache.set(row.key, row.value);
        } else {
            const parsed = Number(row.value);
            if (Number.isFinite(parsed) && parsed > 0) {
                cache.set(row.key, parsed);
            }
        }
    }

    const customCount = cache.size;
    console.log(`[ControlledInvite][RuntimeConfig] ✅ 已加载 ${customCount} 个自定义参数，共 ${Object.keys(PARAM_DEFINITIONS).length} 个参数`);
}

/**
 * 获取参数当前值（内存缓存 > 默认值）。
 * @param {string} key
 * @returns {number}
 */
function get(key) {
    if (!PARAM_DEFINITIONS[key]) {
        throw new Error(`[RuntimeConfig] 未知参数: ${key}`);
    }
    if (cache.has(key)) {
        return cache.get(key);
    }
    return PARAM_DEFINITIONS[key].defaultValue;
}

/**
 * 修改参数，同时写入 DB 和内存。
 * @param {string} key
 * @param {number} value 必须为正整数
 * @returns {{ ok: boolean, error?: string }}
 */
function set(key, value) {
    if (!PARAM_DEFINITIONS[key]) {
        return { ok: false, error: `未知参数: ${key}` };
    }

    const def = PARAM_DEFINITIONS[key];

    if (def.type === 'string') {
        // 字符串类型：直接存储
        ensureTable();
        stmts.upsert.run(key, String(value), new Date().toISOString());
        cache.set(key, String(value));
        return { ok: true };
    }

    // 数字类型：验证正整数
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0 || !Number.isInteger(num)) {
        return { ok: false, error: `值必须为正整数，收到: ${value}` };
    }

    ensureTable();
    stmts.upsert.run(key, String(num), new Date().toISOString());
    cache.set(key, num);
    return { ok: true };
}

/**
 * 重置参数为默认值，删除 DB 记录。
 * @param {string} key
 * @returns {{ ok: boolean, error?: string, defaultValue?: number }}
 */
function reset(key) {
    if (!PARAM_DEFINITIONS[key]) {
        return { ok: false, error: `未知参数: ${key}` };
    }

    ensureTable();
    stmts.delete.run(key);
    cache.delete(key);
    return { ok: true, defaultValue: PARAM_DEFINITIONS[key].defaultValue };
}

/**
 * 返回所有参数的 { key, label, group, currentValue, defaultValue, isCustom } 列表。
 */
function getAll() {
    const result = [];
    for (const [key, def] of Object.entries(PARAM_DEFINITIONS)) {
        const isCustom = cache.has(key);
        result.push({
            key,
            label: def.label,
            group: def.group,
            currentValue: isCustom ? cache.get(key) : def.defaultValue,
            defaultValue: def.defaultValue,
            isCustom,
        });
    }
    return result;
}

/**
 * 获取所有参数名列表（用于构建 Choices）。
 */
function getParamKeys() {
    return Object.keys(PARAM_DEFINITIONS);
}

/**
 * 获取参数定义。
 */
function getDefinition(key) {
    return PARAM_DEFINITIONS[key] || null;
}

module.exports = {
    loadAll,
    get,
    set,
    reset,
    getAll,
    getParamKeys,
    getDefinition,
};
