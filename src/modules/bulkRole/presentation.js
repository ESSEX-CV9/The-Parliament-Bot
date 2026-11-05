const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const MENTIONS = { parse: [] };
const STATES = { queued: '等待中', running: '执行中', completed: '已结束', stopped: '安全停止', cancelled: '已取消' };
const REASONS = {
    read_forbidden: '成员读取被拒绝', write_forbidden: '身份组变更被拒绝（权限或层级）',
    read_network: '成员读取网络错误', write_network: '变更请求网络错误',
    read_server: '成员读取服务端错误', write_server: '变更请求服务端错误',
    read_rate_limit: '成员读取限流', write_rate_limit: '变更请求限流',
    read_api_error: '其他成员读取错误', write_api_error: '其他变更 API 错误',
    read_role_deleted: '目标身份组已删除', write_role_deleted: '目标身份组已删除',
    retry_exhausted: '已达到有限尝试次数',
};

function previewPayload(preview) {
    return {
        content: [
            '**批量身份组操作预览（尚未修改任何成员）**',
            `操作：${preview.action === 'add' ? '添加' : '移除'}；目标身份组：<@&${preview.roleId}>`,
            `输入人数：${preview.inputCount}；去重后人数：${preview.ids.length}`,
            `实际需要修改人数：${preview.counts.change}`,
            `已经处于目标状态：${preview.counts.already}；不在服务器：${preview.counts.absent}；其他异常：${preview.counts.other}`,
            `确认有效期 5 分钟，<t:${Math.floor(preview.expiresAt / 1000)}:R> 失效。执行时会重新读取实际状态。`,
            '如配置了跨服同步，变更会按现有规则联动其他服务器；本任务仅统计本服结果。',
            '只有您可以确认或取消。确认后使用后台任务执行；取消只停止尚未执行的部分，不撤销已完成修改。',
        ].join('\n'),
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`bulkrole:confirm:${preview.id}`).setLabel('确认执行').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`bulkrole:cancel:${preview.id}`).setLabel('取消操作').setStyle(ButtonStyle.Secondary),
        )],
        allowedMentions: MENTIONS,
        attachments: [],
    };
}

function resultPayload({ job, rows }) {
    const count = status => rows.filter(row => row.status === status).length;
    const failed = rows.filter(row => row.status === 'failed');
    const pending = rows.filter(row => ['pending', 'inflight', 'unexecuted'].includes(row.status));
    const active = ['queued', 'running'].includes(job.status);
    const categories = new Map();
    for (const row of failed) categories.set(row.reason || 'unknown', (categories.get(row.reason || 'unknown') || 0) + 1);
    const reasonText = [...categories].map(([reason, n]) => `${REASONS[reason] || '其他错误'}：${n}`).join('；') || '无';
    const files = [];
    if (!active && failed.length) files.push({ attachment: Buffer.from(failed.map(r => r.userId).join(','), 'utf8'), name: `failed-${job.id}.txt` });
    if (!active && pending.length) files.push({ attachment: Buffer.from(pending.map(r => r.userId).join(','), 'utf8'), name: `unexecuted-${job.id}.txt` });
    return {
        content: [
            `任务 ID：\`${job.id}\`；状态：${STATES[job.status] || job.status}${job.cancelRequested && active ? '（已请求取消）' : ''}`,
            `操作：${job.action === 'add' ? '添加' : '移除'}；目标身份组：<@&${job.roleId}>`,
            `总人数：${rows.length}；成功（API 已确认）：${count('success')}`,
            '本任务仅统计本服结果；跨服同步由原有同步机制独立处理。',
            `跳过：${count('already') + count('absent') + count('reconciled')}（已是目标状态 ${count('already')}，不在服务器 ${count('absent')}，不确定请求后核对已达目标 ${count('reconciled')}）`,
            `失败：${failed.length}；${active ? '尚未完成（未执行及请求中）' : '未执行'}：${pending.length}`,
            `失败原因分类：${reasonText}`,
            job.reason ? `任务说明：${job.reason.slice(0, 240)}` : '',
            pending.some(r => r.uncertain) ? '部分未完成请求结果不确定；重新处理前会先查询实际状态。' : '',
            job.nextAt ? `下次尝试：<t:${Math.floor(job.nextAt / 1000)}:R>` : '',
            `最近更新：<t:${Math.floor(job.updatedAt / 1000)}:F>`,
            '使用 `/管理 身份组 任务` 查询或取消；「重试失败」只为失败成员生成新预览，仍需确认。',
        ].filter(Boolean).join('\n'),
        components: [], allowedMentions: MENTIONS, attachments: [], files,
    };
}

module.exports = { previewPayload, resultPayload, MENTIONS };
