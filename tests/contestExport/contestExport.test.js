const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '../..');
const projectRequire = createRequire(path.join(root, 'package.json'));
const { buildContestExport } = projectRequire('./src/modules/contestExport/services/exportBuilder');
const {
    createContestExportCommand,
    getExportRoleIds,
    DEFAULT_EXPORT_ROLE_IDS,
} = projectRequire('./src/modules/contestExport/commands/contestExport');

const GUILD = '100';
const ROLE = '900';

const channels = {
    c1: { channelId: 'c1', guildId: GUILD, contestTitle: '杯赛一', applicantId: 'u0', createdAt: '2025-06-01T00:00:00.000Z', isFinished: true },
    c2: { channelId: 'c2', guildId: '200', contestTitle: '别的服务器' },
    c3: { channelId: 'c3', contestTitle: '早期无 guildId', createdAt: '2025-05-01T00:00:00.000Z' },
};
const submissions = {
    1: { globalId: 1, contestSubmissionId: 2, contestChannelId: 'c1', submitterId: 'u2', parsedInfo: { guildId: GUILD, channelId: 't2', messageId: 'm2' }, cachedPreview: { title: '作品B', timestamp: 1750000000000 }, isValid: true },
    2: { globalId: 2, contestSubmissionId: 1, contestChannelId: 'c1', submitterId: 'u1', originalUrl: 'https://discord.com/channels/100/t1/m1~x', isValid: true, awardInfo: { awardName: '一等奖' } },
    3: { globalId: 3, contestSubmissionId: 3, contestChannelId: 'c1', submitterId: 'u3', isValid: false },
    4: { globalId: 4, contestSubmissionId: 1, contestChannelId: 'c2', submitterId: 'u9' },
};

test('只导出本服务器赛事，早期缺 guildId 的记录标注后保留', () => {
    const data = buildContestExport(channels, submissions, GUILD, new Date('2026-01-01T00:00:00Z'));
    assert.deepEqual(data.contests.map(c => c.channelId), ['c3', 'c1']);
    assert.equal(data.contests[0].guildIdMissing, true);
    assert.deepEqual(data.stats, { contests: 2, submissions: 3, validSubmissions: 2 });
});

test('投稿按赛事内编号排序并整理链接、获奖和有效性', () => {
    const contest = buildContestExport(channels, submissions, GUILD).contests.find(c => c.channelId === 'c1');
    assert.deepEqual(contest.submissions.map(s => s.contestSubmissionId), [1, 2, 3]);
    assert.equal(contest.submissions[0].workUrl, 'https://discord.com/channels/100/t1/m1');
    assert.deepEqual(contest.submissions[0].award, { name: '一等奖', message: null });
    assert.equal(contest.submissions[1].workUrl, 'https://discord.com/channels/100/t2/m2');
    assert.equal(contest.submissions[1].title, '作品B');
    assert.equal(contest.submissions[2].isValid, false);
    assert.deepEqual(contest.stats, { total: 3, valid: 2, awarded: 1 });
});

test('导出身份组可由环境变量覆盖，空值回落默认', () => {
    assert.deepEqual(getExportRoleIds({}), DEFAULT_EXPORT_ROLE_IDS);
    assert.deepEqual(getExportRoleIds({ CONTEST_EXPORT_ROLE_IDS: ' 1, 2 ,' }), ['1', '2']);
});

function fakeInteraction({ roles = [], subcommand = '导出', limit } = {}) {
    const calls = { replies: [] };
    return {
        calls,
        inGuild: () => true,
        guild: {
            id: GUILD,
            members: { fetch: async () => ({ roles: { cache: new Set(roles) } }) },
        },
        user: { id: 'caller' },
        attachmentSizeLimit: limit,
        options: { getSubcommand: () => subcommand },
        deferReply: async () => {},
        editReply: async payload => { calls.replies.push(payload); },
        reply: async payload => { calls.replies.push(payload); },
    };
}

const quiet = fn => async (...args) => {
    const { log, error } = console;
    console.log = () => {};
    console.error = () => {};
    try { return await fn(...args); } finally { console.log = log; console.error = error; }
};

test('没有导出身份组时拒绝且不读取数据', quiet(async () => {
    let read = false;
    const execute = createContestExportCommand({
        roleIds: [ROLE],
        readChannels: () => { read = true; return {}; },
        readSubmissions: () => ({}),
    });
    const interaction = fakeInteraction({ roles: ['other'] });
    await execute(interaction);
    assert.equal(read, false);
    assert.match(interaction.calls.replies[0].content, /没有导出赛事数据的权限/);
}));

test('持有身份组时私密返回 JSON 附件，超限时 gzip', quiet(async () => {
    const execute = createContestExportCommand({
        roleIds: [ROLE],
        readChannels: () => channels,
        readSubmissions: () => submissions,
        now: () => new Date('2026-01-01T00:00:00Z'),
    });
    const ok = fakeInteraction({ roles: [ROLE] });
    await execute(ok);
    const file = ok.calls.replies[0].files[0];
    assert.equal(file.name, 'contest-export-100-2026-01-01.json');
    assert.equal(JSON.parse(file.attachment.toString('utf8')).stats.contests, 2);

    const small = fakeInteraction({ roles: [ROLE], limit: 1500 });
    await execute(small);
    const gz = small.calls.replies[0].files[0];
    assert.match(gz.name, /\.json\.gz$/);
    assert.equal(JSON.parse(zlib.gunzipSync(gz.attachment).toString('utf8')).stats.submissions, 3);
}));
