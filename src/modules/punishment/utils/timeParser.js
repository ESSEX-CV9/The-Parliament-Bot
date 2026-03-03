/**
 * 解析时长字符串为毫秒和标签
 * @param {string} str - 时长字符串，如 "2h" 或 "3d"
 * @returns {{ ms: number, label: string } | null}
 */
function parseDuration(str) {
    const match = /^(\d+)\s*(h|d)$/i.exec(str?.trim());
    if (!match) return null;
    const value = parseInt(match[1], 10);
    if (value <= 0) return null;
    const unit = match[2].toLowerCase();
    if (unit === 'h') return { ms: value * 3600 * 1000, label: `${value}小时` };
    if (unit === 'd') return { ms: value * 24 * 3600 * 1000, label: `${value}天` };
    return null;
}

module.exports = { parseDuration };
