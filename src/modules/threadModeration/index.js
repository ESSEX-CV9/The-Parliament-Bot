const { Service } = require('./service');
const { describe } = require('./errors');

const services = new WeakMap();
const retries = new WeakMap();

function getService(client) {
    if (!services.has(client)) services.set(client, new Service(client));
    return services.get(client);
}

async function startThreadModeration(client) {
    let service;
    try {
        service = getService(client);
        await service.start();
        console.log('[ThreadModeration] 未完成操作核验结束；review 状态需管理员检查独立数据库。');
    } catch (error) {
        console.error('[ThreadModeration] 初始化/恢复失败，其他模块继续运行：', describe(error));
        // A hard-crashed process can leave a live lease. Retry startup once after
        // its TTL, rather than adding a continuous guild/thread scanning task.
        if (service && !service.stopping && !retries.has(client)) {
            const timer = setTimeout(() => {
                if (!service.stopping) service.start().catch(caught => console.error('[ThreadModeration] 恢复重试失败：', describe(caught)));
            }, service.leaseMs + 100);
            timer.unref?.(); retries.set(client, timer);
        }
    }
}

async function stopThreadModeration(client) {
    clearTimeout(retries.get(client));
    const service = services.get(client);
    if (service) await service.stop();
}

module.exports = { getService, startThreadModeration, stopThreadModeration };
