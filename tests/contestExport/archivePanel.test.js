const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '../..');
const projectRequire = createRequire(path.join(root, 'package.json'));
const panel = projectRequire('./src/modules/contestExport/services/archivePanel');
const { parseMapping, publishPanels } = projectRequire('./src/modules/contestExport/services/panelPublisher');
const { createArchivePanelHandler } = projectRequire('./src/modules/contestExport/interactions');

const GUILD = '111111111111111111';
const CONTEST = '222222222222222222';
const THREAD = '333333333333333333';
const BOT = '999999999999999999';

const rawContest = { guildId: GUILD, contestTitle: '测试杯', applicantId: '444444444444444444' };
const rawSubmissions = [
    { contestSubmissionId: 1, contestChannelId: CONTEST, submitterId: '555555555555555555', parsedInfo: { guildId: GUILD, channelId: '1', messageId: '2' }, cachedPreview: { title: '星海[远航]', authorName: '小明', timestamp: 1750000000000 }, isValid: true, awardInfo: { awardName: '金奖' } },
    { contestSubmissionId: 2, contestChannelId: CONTEST, submitterId: '666666666666666666', cachedPreview: { title: '雨夜', authorName: '阿花' }, isValid: true },
    { contestSubmissionId: 3, contestChannelId: CONTEST, submitterId: '777777777777777777', cachedPreview: { title: '星海删稿' }, isValid: false },
];
const contest = panel.loadContest(rawContest, rawSubmissions, CONTEST);

test('面板包含概览、获奖作品、复用的查看按钮和查询按钮', () => {
    const message = panel.buildPanelMessage(contest);
    const embed = message.embeds[0].toJSON();
    assert.match(embed.title, /测试杯/);
    assert.match(embed.description, /有效投稿 \*\*2\*\* 个/);
    assert.match(embed.footer.text, new RegExp(`${panel.PANEL_MARKER}.*${CONTEST}`));
    assert.match(embed.fields[0].value, /星海［远航］/);
    const ids = message.components[0].toJSON().components.map(c => c.custom_id);
    assert.deepEqual(ids, [`c_all_${CONTEST}`, `${panel.SEARCH_BUTTON}${CONTEST}`]);
    assert.deepEqual(message.allowedMentions, { parse: [] });
});

test('查询只命中有效投稿，可按标题、作者、投稿人和编号查', () => {
    assert.deepEqual(panel.searchSubmissions(contest, '星海').map(s => s.contestSubmissionId), [1]);
    assert.deepEqual(panel.searchSubmissions(contest, '阿花').map(s => s.contestSubmissionId), [2]);
    assert.deepEqual(panel.searchSubmissions(contest, '666666666666666666').map(s => s.contestSubmissionId), [2]);
    assert.equal(panel.searchSubmissions(contest, '  ').length, 0);
    const reply = panel.buildSearchReply(contest, '没有', []).embeds[0].toJSON();
    assert.match(reply.description, /没有找到/);
});

test('对照表校验格式、数量和重复', () => {
    assert.deepEqual(parseMapping(JSON.stringify([{ threadId: THREAD, contestChannelId: CONTEST }])), [{ threadId: THREAD, contestChannelId: CONTEST }]);
    assert.throws(() => parseMapping('{'), /JSON/);
    assert.throws(() => parseMapping('{}'), /数组/);
    assert.throws(() => parseMapping(JSON.stringify([{ threadId: 'x', contestChannelId: CONTEST }])), /无效/);
    assert.throws(() => parseMapping(JSON.stringify([{ threadId: THREAD, contestChannelId: CONTEST }, { threadId: THREAD, contestChannelId: CONTEST }])), /重复/);
});

function fakeThread({ archived = true, locked = true, guildId = GUILD, existing = [] } = {}) {
    const log = [];
    return {
        log,
        guildId,
        archived,
        locked,
        isThread: () => true,
        messages: { fetch: async () => new Map(existing.map((m, i) => [String(i), m])) },
        async setArchived(v) { log.push(`archived:${v}`); this.archived = v; },
        async setLocked(v) { log.push(`locked:${v}`); this.locked = v; },
        async send(payload) { log.push('send'); this.sent = payload; },
    };
}

const deps = (threads) => ({
    guild: { id: GUILD },
    botId: BOT,
    delay: 0,
    fetchChannel: async id => threads[id] || null,
    readContest: async id => (id === CONTEST ? rawContest : null),
    readSubmissions: async () => rawSubmissions,
});

test('发布时临时解锁归档帖，发完恢复锁定和归档', async () => {
    const thread = fakeThread();
    const result = await publishPanels([{ threadId: THREAD, contestChannelId: CONTEST }], deps({ [THREAD]: thread }));
    assert.equal(result.sent.length, 1);
    assert.deepEqual(thread.log, ['archived:false', 'locked:false', 'send', 'locked:true', 'archived:true']);
});

test('已有面板的帖子跳过；别的服务器或找不到赛事的记为失败', async () => {
    const existing = [{ author: { id: BOT }, embeds: [{ footer: { text: `${panel.PANEL_MARKER} · 原赛事频道 ${CONTEST}` } }] }];
    const done = fakeThread({ existing });
    const foreign = fakeThread({ guildId: '888888888888888888' });
    const result = await publishPanels([
        { threadId: THREAD, contestChannelId: CONTEST },
        { threadId: '123456789012345678', contestChannelId: CONTEST },
        { threadId: '223456789012345678', contestChannelId: '323456789012345678' },
    ], deps({ [THREAD]: done, '123456789012345678': foreign }));
    assert.equal(result.skipped.length, 1);
    assert.equal(done.log.length, 0);
    assert.equal(foreign.log.length, 0);
    assert.deepEqual(result.failed.map(f => f.reason), ['找不到本服务器内的这个帖子', '找不到赛事数据']);
});

test('查询按钮弹出输入框，提交后私密返回结果', async () => {
    const handler = createArchivePanelHandler({ readContest: async () => rawContest, readSubmissions: async () => rawSubmissions });
    let modal;
    await handler({ customId: `${panel.SEARCH_BUTTON}${CONTEST}`, isButton: () => true, isModalSubmit: () => false, showModal: async m => { modal = m; } });
    assert.equal(modal.toJSON().custom_id, `${panel.SEARCH_MODAL}${CONTEST}`);

    let reply;
    await handler({
        customId: `${panel.SEARCH_MODAL}${CONTEST}`,
        isButton: () => false,
        isModalSubmit: () => true,
        fields: { getTextInputValue: () => '雨夜' },
        deferReply: async () => {},
        editReply: async payload => { reply = payload; },
    });
    assert.match(reply.embeds[0].toJSON().description, /雨夜/);
});
