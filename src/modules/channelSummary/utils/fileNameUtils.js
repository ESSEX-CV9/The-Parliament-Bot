// src/modules/channelSummary/utils/fileNameUtils.js

/**
 * 将频道名等任意文本清洗为安全的文件名片段
 * - 频道名/子区名可能包含 / \ : * ? " < > | 等字符，直接拼进路径会被
 *   path.join 当作目录分隔符（或在 Windows 上非法），导致写入 ENOENT 失败
 */
function sanitizeFileName(name, fallback = '未命名频道', maxLength = 80) {
    let safe = String(name ?? '')
        // 路径分隔符与 Windows 非法字符
        .replace(/[\/:*?"<>|]/g, '_')
        // 控制字符
        .replace(/[\x00-\x1f\x7f]/g, '')
        // 折叠空白
        .replace(/\s+/g, ' ')
        .trim()
        // Windows 不允许文件名以点或空格结尾
        .replace(/[. ]+$/, '');

    if (safe.length > maxLength) {
        safe = safe.slice(0, maxLength).replace(/[. ]+$/, '');
    }

    return safe || fallback;
}

module.exports = {
    sanitizeFileName
};
