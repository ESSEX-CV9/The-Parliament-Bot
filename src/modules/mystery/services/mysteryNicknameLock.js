const path = require('node:path');
const { createMysteryNicknameLockStore } = require('../utils/mysteryNicknameLockStore');
const { createMysteryNicknameLockService } = require('./mysteryNicknameLockService');

// 胆小鬼未结算记录在重启时最多再留 5 分钟（与 legacy 行为一致）。
const AFTER_GAME_MS = 5 * 60 * 1000;

const store = createMysteryNicknameLockStore({
    filePath: path.join('data', 'mystery', 'cowardPenalties.json'),
});
const service = createMysteryNicknameLockService({ store });

async function initialize(client) {
    await service.initialize(client);
    // 兼容 legacy 语义：未 settled 的 coward 记录重启后封顶为 5 分钟。
    for (const record of store.list()) {
        if (record.type !== 'coward' || record.settled === true) continue;
        if (record.expiresAt > Date.now() + AFTER_GAME_MS) {
            await service.updateLock(record.guildId, record.userId, draft => {
                draft.expiresAt = Math.min(draft.expiresAt, Date.now() + AFTER_GAME_MS);
                return draft;
            });
        }
    }
}

function resetForTests() {
    service.resetForTests();
    store.resetForTests();
}

module.exports = { store, service, initialize, resetForTests, AFTER_GAME_MS };
