const COOLDOWN_DURATION_MS = 30 * 60 * 1000;

const cooldowns = new Map();
const inFlight = new Set();

function buildCooldownKey(guildId, userId, subcommand) {
    return `${guildId}:${userId}:${subcommand}`;
}

function isOnCooldown(guildId, userId, subcommand, now = Date.now()) {
    const key = buildCooldownKey(guildId, userId, subcommand);
    const expiresAt = cooldowns.get(key);

    if (expiresAt === undefined) {
        return false;
    }

    if (expiresAt <= now) {
        cooldowns.delete(key);
        return false;
    }

    return true;
}

function startCooldown(guildId, userId, subcommand, now = Date.now()) {
    const key = buildCooldownKey(guildId, userId, subcommand);
    cooldowns.set(key, now + COOLDOWN_DURATION_MS);
}

function acquireInFlight(guildId, userId, subcommand) {
    const key = buildCooldownKey(guildId, userId, subcommand);

    if (inFlight.has(key)) {
        return false;
    }

    inFlight.add(key);
    return true;
}

function releaseInFlight(guildId, userId, subcommand) {
    const key = buildCooldownKey(guildId, userId, subcommand);
    inFlight.delete(key);
}

function resetStateForTests() {
    cooldowns.clear();
    inFlight.clear();
}

module.exports = {
    COOLDOWN_DURATION_MS,
    buildCooldownKey,
    isOnCooldown,
    startCooldown,
    acquireInFlight,
    releaseInFlight,
    resetStateForTests,
};
