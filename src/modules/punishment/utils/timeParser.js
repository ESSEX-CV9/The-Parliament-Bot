/**
 * 解析时长字符串为毫秒和标签
 * @param {string} str - 时长字符串，如 "2h" 或 "3d"
 * @returns {{ ms: number, label: string } | null}
 */
function parseDuration(str) {
    const trimmed = str?.trim();
    if (!trimmed) return null;

    // 带单位: "2h", "3d"
    const matchWithUnit = /^(\d+)\s*(h|d)$/i.exec(trimmed);
    if (matchWithUnit) {
        const value = parseInt(matchWithUnit[1], 10);
        if (value <= 0) return null;
        const unit = matchWithUnit[2].toLowerCase();
        if (unit === 'h') return { ms: value * 3600 * 1000, label: `${value}小时` };
        if (unit === 'd') return { ms: value * 24 * 3600 * 1000, label: `${value}天` };
        return null;
    }

    // 纯数字: 默认按天
    const matchNumber = /^(\d+)$/.exec(trimmed);
    if (matchNumber) {
        const value = parseInt(matchNumber[1], 10);
        if (value <= 0) return null;
        return { ms: value * 24 * 3600 * 1000, label: `${value}天` };
    }

    return null;
}

module.exports = { parseDuration };
