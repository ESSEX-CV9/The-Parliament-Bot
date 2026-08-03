const MAX_INCIDENT_PAUSE_MS = 24 * 60 * 60 * 1000;
const RENEW_THRESHOLD_MS = 60 * 60 * 1000;

function parseResumeAt(resumeAt) {
    if (!resumeAt) return null;
    const timestamp = resumeAt instanceof Date ? resumeAt.getTime() : Date.parse(resumeAt);
    if (!Number.isFinite(timestamp)) {
        throw new Error('无效的预约恢复时间');
    }
    return timestamp;
}

function calculatePauseUntil(nowMs = Date.now(), resumeAt = null) {
    const maximumUntilMs = nowMs + MAX_INCIDENT_PAUSE_MS;
    const resumeAtMs = parseResumeAt(resumeAt);
    const untilMs = resumeAtMs === null
        ? maximumUntilMs
        : Math.min(maximumUntilMs, resumeAtMs);

    if (!Number.isFinite(untilMs) || untilMs <= nowMs) {
        throw new Error('预约恢复时间必须晚于当前时间');
    }

    return new Date(untilMs);
}

async function pauseInvites(guild, { nowMs = Date.now(), resumeAt = null } = {}) {
    const invitesDisabledUntil = calculatePauseUntil(nowMs, resumeAt);
    await guild.setIncidentActions({ invitesDisabledUntil });
    return invitesDisabledUntil;
}

async function resumeInvites(guild) {
    await guild.setIncidentActions({ invitesDisabledUntil: null });
}

module.exports = {
    MAX_INCIDENT_PAUSE_MS,
    RENEW_THRESHOLD_MS,
    calculatePauseUntil,
    pauseInvites,
    resumeInvites,
};
