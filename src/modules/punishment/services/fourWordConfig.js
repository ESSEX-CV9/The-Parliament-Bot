const { getSetting, setSetting } = require('./punishmentDatabase');

const MAX_TIMEOUT_MS = 28 * 24 * 3600 * 1000;

function getFourWordConfig(guildId) {
    const defaults = { publicChannelId: null, normalRoleId: null, penaltyRoleId: null,
        message: '', muteDuration: null, warnDuration: null, allowedRoleIds: [] };
    const raw = getSetting(guildId, 'four_word_config');
    if (!raw) return defaults;
    const saved = JSON.parse(raw);
    return { ...defaults, ...saved };
}

function validDuration(duration) {
    return Number.isSafeInteger(duration?.ms) && duration.ms > 0
        && Number.isFinite(new Date(Date.now() + duration.ms).getTime())
        && typeof duration.label === 'string' && duration.label.length > 0;
}

function updateFourWordConfig(guildId, updates) {
    const merged = { ...getFourWordConfig(guildId), ...updates };
    setSetting(guildId, 'four_word_config', JSON.stringify(merged));
    return merged;
}

module.exports = { getFourWordConfig, updateFourWordConfig, validDuration, MAX_TIMEOUT_MS };
