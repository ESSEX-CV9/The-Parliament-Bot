// 神秘指令的游戏名（同时是 slash 子命令名）。
// 单独放在这里，避免 store / service / command 之间互相 require 成环。
const MYSTERY_GAMES = Object.freeze({
    SELF_TIMEOUT: '自刎归天',
    RANDOM_NICKNAME: '取名字好麻烦',
    ROULETTE: '运气轮盘',
    BOMB: '传炸弹',
    DUEL: '死斗',
    DEVIL_ROULETTE: '恶魔轮盘',
    DEVIL_ROULETTE_PVE: '与庄家对赌',
    PRESSURE: '加压轮盘',
});

const MYSTERY_GAME_NAMES = Object.freeze(Object.values(MYSTERY_GAMES));

const MULTIPLAYER_GAME_NAMES = Object.freeze([
    MYSTERY_GAMES.ROULETTE,
    MYSTERY_GAMES.BOMB,
    MYSTERY_GAMES.DUEL,
    MYSTERY_GAMES.DEVIL_ROULETTE,
    MYSTERY_GAMES.DEVIL_ROULETTE_PVE,
    MYSTERY_GAMES.PRESSURE,
]);

const MYSTERY_GAME_NAME_SET = new Set(MYSTERY_GAME_NAMES);
const MULTIPLAYER_GAME_NAME_SET = new Set(MULTIPLAYER_GAME_NAMES);

function isMysteryGame(name) {
    return typeof name === 'string' && MYSTERY_GAME_NAME_SET.has(name);
}

function isMultiplayerGame(name) {
    return typeof name === 'string' && MULTIPLAYER_GAME_NAME_SET.has(name);
}

module.exports = {
    MYSTERY_GAMES,
    MYSTERY_GAME_NAMES,
    MULTIPLAYER_GAME_NAMES,
    isMysteryGame,
    isMultiplayerGame,
};
