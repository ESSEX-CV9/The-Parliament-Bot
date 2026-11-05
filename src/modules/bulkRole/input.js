function parseIds(value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('用户ID列表不能为空。');
    if (value.length > 6000) throw new Error('用户ID列表不能超过 6000 字符。');
    const tokens = value.split(',').map(id => id.trim());
    const invalid = tokens.findIndex(id => !/^[1-9]\d{16,19}$/.test(id) || BigInt(id) > 18446744073709551615n);
    if (invalid !== -1) throw new Error(`第 ${invalid + 1} 项不是合法的 Discord 用户 ID（仅接受 17–20 位十进制 Snowflake，以英文逗号分隔，不能有空项）。`);
    const ids = [...new Set(tokens)];
    if (ids.length > 200) throw new Error(`去重后 ${ids.length} 人，单次最多 200 人。`);
    return { ids, inputCount: tokens.length };
}
module.exports = { parseIds };
