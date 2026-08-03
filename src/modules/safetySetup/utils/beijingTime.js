const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const MIN_RESUME_LEAD_MS = 60 * 60 * 1000;

function parseBeijingResumeTime(input, nowMs = Date.now()) {
    const value = String(input || '').trim();
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
    if (!match) {
        throw new Error('恢复时间格式错误，请使用 YYYY-MM-DD HH:mm（北京时间）');
    }

    const [, yearText, monthText, dayText, hourText, minuteText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);

    if (
        month < 1 || month > 12 ||
        day < 1 || day > 31 ||
        hour < 0 || hour > 23 ||
        minute < 0 || minute > 59
    ) {
        throw new Error('无效的恢复时间，请检查年月日和时分');
    }

    const beijingWallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    const parsedMs = beijingWallClockAsUtc - BEIJING_OFFSET_MS;
    const roundTrip = new Date(parsedMs + BEIJING_OFFSET_MS);

    if (
        !Number.isFinite(parsedMs) ||
        roundTrip.getUTCFullYear() !== year ||
        roundTrip.getUTCMonth() !== month - 1 ||
        roundTrip.getUTCDate() !== day ||
        roundTrip.getUTCHours() !== hour ||
        roundTrip.getUTCMinutes() !== minute
    ) {
        throw new Error('无效的恢复时间，请检查年月日和时分');
    }

    if (parsedMs - nowMs < MIN_RESUME_LEAD_MS) {
        throw new Error('预约恢复时间必须至少提前 1 小时');
    }

    return new Date(parsedMs);
}

function formatBeijingDateTime(date) {
    const shifted = new Date(date.getTime() + BEIJING_OFFSET_MS);
    const year = shifted.getUTCFullYear();
    const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const day = String(shifted.getUTCDate()).padStart(2, '0');
    const hour = String(shifted.getUTCHours()).padStart(2, '0');
    const minute = String(shifted.getUTCMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hour}:${minute}`;
}

module.exports = {
    BEIJING_OFFSET_MS,
    MIN_RESUME_LEAD_MS,
    parseBeijingResumeTime,
    formatBeijingDateTime,
};
