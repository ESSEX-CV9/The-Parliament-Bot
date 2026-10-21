const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const discord = require('discord.js');

const root = path.resolve(__dirname, '../..');
const GUILD = '100000000000000001';
const OTHER_GUILD = '100000000000000002';
const ROLE = '300000000000000001';
const OLD_ROLE = '300000000000000002';
const silent = { log() {}, warn() {}, error() {} };

function load(relative, stubs) {
    const filename = path.join(root, relative);
    assert.ok(fs.existsSync(filename), `${relative} must exist`);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, console: silent,
        __dirname: path.dirname(filename), __filename: filename,
        require(name) {
            if (name === 'discord.js') return discord;
            if (Object.hasOwn(stubs, name)) return stubs[name];
            throw new Error(`Unexpected dependency ${name}`);
        }
    }, { filename });
    return module.exports;
}

function fixture() {
    // Use the real JSON database with virtual disk storage, so each read returns
    // a detached settings snapshot and stale saves are observable.
    const files = new Map();
    const database = load('src/modules/contest/utils/contestDatabase.js', {
        path,
        fs: {
            existsSync: filename => files.has(filename),
            mkdirSync() {},
            writeFileSync: (filename, content) => files.set(filename, content),
            readFileSync: filename => files.get(filename)
        }
    });
    const permissions = load('src/core/utils/permissionManager.js', {
        './database': { isUserInSelfModerationBlacklist: () => false }
    });
    const dependencies = {
        '../utils/contestDatabase': database,
        '../../../core/utils/permissionManager': permissions,
        '../utils/forumTagManager': { ensureContestStatusTags: async () => ({ PENDING: 'tag' }) }
    };
    const setup = load('src/modules/contest/commands/setupContestApplication.js', dependencies);
    const effects = { replies: [], edits: [], entries: [], deferred: [] };
    function interaction({ guildId = GUILD, trackId, role = null, subcommand = '查看', access = 'admin' } = {}) {
        const guild = {
            id: guildId, ownerId: access === 'owner' ? 'user' : 'owner',
            members: { me: {} },
            roles: { cache: new discord.Collection([[ROLE, { id: ROLE, name: '主办资格' }]]),
                async fetch(id) { return this.cache.get(id) || null; } }
        };
        const member = {
            user: { id: 'user', tag: 'tester' }, guild,
            roles: { cache: new discord.Collection(access === 'allowed-role' ? [['1337450755791261766', { id: '1337450755791261766' }]] : []) },
            permissions: { has: permission => (access === 'admin' && permission === discord.PermissionFlagsBits.Administrator)
                || (access === 'manage-guild' && permission === discord.PermissionFlagsBits.ManageGuild) }
        };
        const forum = { id: 'forum-new', type: discord.ChannelType.GuildForum, permissionsFor: () => ({ has: () => true }) };
        const category = { id: 'category-new', type: discord.ChannelType.GuildCategory, permissionsFor: () => ({ has: () => true }) };
        return {
            guild, member, user: member.user, client: {},
            channel: { async send(data) { effects.entries.push(data); return { id: 'entry' }; } },
            options: {
                getChannel: name => name === '审批论坛' ? forum : category,
                getString: name => name === '轨道id' ? trackId : name === '轨道名称' ? '新名称' : null,
                getInteger: () => 8,
                getRole: () => role,
                getSubcommand: () => subcommand
            },
            async reply(data) { effects.replies.push(data); this.replied = true; },
            async editReply(data) { effects.edits.push(data); },
            async deferReply(data) { effects.deferred.push(data); this.deferred = true; }
        };
    }
    async function seed(guildId = GUILD) {
        await database.saveContestSettings({
            guildId, defaultTrackId: 'art', itemsPerPage: 6,
            tracks: { art: { id: 'art', name: '旧名称', reviewForumId: 'forum-old', contestCategoryId: 'category-old' } },
            reviewerRoles: ['reviewer'], applicationPermissionRoles: [ROLE, OLD_ROLE], otherSetting: 'preserved'
        });
    }
    return { database, setup, interaction, effects, seed,
        command: () => load('src/modules/contest/commands/setContestApplicationPermission.js', dependencies) };
}

test('setup command registers an optional guild-wide prerequisite role', () => {
    const f = fixture();
    const option = f.setup.data.toJSON().options.find(option => option.name === '前置身份组');
    assert.ok(option);
    assert.equal(option.type, discord.ApplicationCommandOptionType.Role);
    assert.equal(option.required, false);
    assert.match(option.description, /全服/);
});

test('first default setup initializes the database and unrestricted role list before creating the track', async () => {
    const f = fixture();
    await f.setup.execute(f.interaction());
    const settings = await f.database.getContestSettings(GUILD);
    assert.ok(settings, 'first setup must persist settings');
    assert.equal(settings.defaultTrackId, 'default');
    assert.equal(settings.tracks.default.reviewForumId, 'forum-new');
    assert.deepEqual(Array.from(settings.applicationPermissionRoles), []);
    assert.equal(f.effects.entries.length, 1);
});

test('first explicit track becomes the default and stores a selected prerequisite globally', async () => {
    const f = fixture();
    await f.setup.execute(f.interaction({ trackId: 'art', role: { id: ROLE } }));
    const settings = await f.database.getContestSettings(GUILD);
    assert.equal(settings.defaultTrackId, 'art');
    assert.deepEqual(Array.from(settings.applicationPermissionRoles), [ROLE]);
    assert.match(f.effects.edits.at(-1).content, new RegExp(ROLE));
    assert.doesNotMatch(f.effects.entries[0].content, new RegExp(ROLE));
});

test('updating the default track keeps the latest track data and omitted legacy prerequisites', async () => {
    const f = fixture();
    await f.seed();
    await f.setup.execute(f.interaction());
    const settings = await f.database.getContestSettings(GUILD);
    assert.equal(settings.tracks.art.reviewForumId, 'forum-new');
    assert.equal(settings.tracks.art.name, '新名称');
    assert.equal(settings.itemsPerPage, 8);
    assert.deepEqual(Array.from(settings.applicationPermissionRoles), [ROLE, OLD_ROLE]);
    assert.equal(settings.otherSetting, 'preserved');
});

test('setup role selection replaces legacy roles without modifying another guild', async () => {
    const f = fixture();
    await f.seed();
    await f.seed(OTHER_GUILD);
    const before = JSON.stringify(await f.database.getContestSettings(OTHER_GUILD));
    await f.setup.execute(f.interaction({ trackId: 'extra', role: { id: ROLE } }));
    const settings = await f.database.getContestSettings(GUILD);
    assert.deepEqual(Array.from(settings.applicationPermissionRoles), [ROLE]);
    assert.ok(settings.tracks.extra);
    assert.equal(settings.defaultTrackId, 'art');
    assert.equal(JSON.stringify(await f.database.getContestSettings(OTHER_GUILD)), before);
});

test('updating an explicit track keeps its update and omitted global roles', async () => {
    const f = fixture();
    await f.seed();
    await f.setup.execute(f.interaction({ trackId: 'art' }));
    const settings = await f.database.getContestSettings(GUILD);
    assert.equal(settings.tracks.art.reviewForumId, 'forum-new');
    assert.deepEqual(Array.from(settings.applicationPermissionRoles), [ROLE, OLD_ROLE]);
    assert.match(f.effects.edits.at(-1).content, new RegExp(OLD_ROLE));
});

test('setup preserves malformed role restrictions and reports them as invalid', async () => {
    for (const roles of [null, ROLE, [ROLE, null]]) {
        const f = fixture();
        await f.seed();
        const settings = await f.database.getContestSettings(GUILD);
        settings.applicationPermissionRoles = roles;
        await f.database.saveContestSettings(settings);
        await f.setup.execute(f.interaction());
        assert.equal(JSON.stringify((await f.database.getContestSettings(GUILD)).applicationPermissionRoles), JSON.stringify(roles));
        assert.match(f.effects.edits.at(-1).content, /配置无效.*设置.*清除/);
        assert.doesNotMatch(f.effects.edits.at(-1).content, /不限制，所有成员/);
    }
});

test('setup rejects direct messages and members without shared administrator permission', async () => {
    const f = fixture();
    const dm = f.interaction();
    dm.guild = null;
    await f.setup.execute(dm);
    await f.setup.execute(f.interaction({ access: 'manage-guild' }));
    assert.equal(await f.database.getContestSettings(GUILD), null);
    assert.equal(f.effects.entries.length, 0);
    assert.equal(f.effects.deferred.length, 0);
    assert.match(f.effects.replies[0].content, /服务器|私信/);
    assert.match(f.effects.replies[1].content, /权限不足/);
    assert.ok(f.effects.replies.every(reply => reply.flags === discord.MessageFlags.Ephemeral));
});

test('permission command payload exposes set, view, and clear behind integration permissions', () => {
    const payload = fixture().command().data.toJSON();
    assert.equal(payload.name, '赛事-设置申请权限');
    assert.equal(payload.default_member_permissions, '0');
    assert.deepEqual(payload.options.map(option => option.name), ['设置', '查看', '清除']);
    const option = payload.options[0].options[0];
    assert.equal(option.name, '身份组');
    assert.equal(option.type, discord.ApplicationCommandOptionType.Role);
    assert.equal(option.required, true);
});

test('configuration authorization matches the shared punishment administrator check', async t => {
    for (const access of ['admin', 'owner', 'allowed-role', 'ordinary', 'manage-guild']) {
        await t.test(access, async () => {
            const f = fixture();
            await f.seed();
            await f.command().execute(f.interaction({ access, subcommand: '清除' }));
            const roles = (await f.database.getContestSettings(GUILD)).applicationPermissionRoles;
            assert.deepEqual(Array.from(roles), ['admin', 'owner', 'allowed-role'].includes(access) ? [] : [ROLE, OLD_ROLE]);
            const response = [...f.effects.replies, ...f.effects.edits].at(-1);
            if (access === 'ordinary' || access === 'manage-guild') assert.match(response.content, /权限不足/);
        });
    }
});

test('configuration rejects DMs and does not create settings for an uninitialized guild', async () => {
    const f = fixture();
    const dm = f.interaction({ subcommand: '设置', role: { id: ROLE } });
    dm.guild = null;
    await f.command().execute(dm);
    assert.match(f.effects.replies.at(-1).content, /服务器|私信/);
    for (const subcommand of ['设置', '查看', '清除']) {
        await f.command().execute(f.interaction({ subcommand, role: { id: ROLE } }));
        assert.equal(await f.database.getContestSettings(GUILD), null);
        assert.match([...f.effects.replies, ...f.effects.edits].at(-1).content, /先.*设置.*赛事申请入口/);
    }
});

test('standalone set replaces the role for this guild and preserves unrelated configuration', async () => {
    const f = fixture();
    await f.seed();
    await f.seed(OTHER_GUILD);
    const before = JSON.stringify(await f.database.getContestSettings(OTHER_GUILD));
    await f.command().execute(f.interaction({ subcommand: '设置', role: { id: ROLE } }));
    const settings = await f.database.getContestSettings(GUILD);
    assert.deepEqual(Array.from(settings.applicationPermissionRoles), [ROLE]);
    assert.equal(settings.otherSetting, 'preserved');
    assert.equal(settings.tracks.art.reviewForumId, 'forum-old');
    assert.deepEqual(Array.from(settings.reviewerRoles), ['reviewer']);
    assert.equal(JSON.stringify(await f.database.getContestSettings(OTHER_GUILD)), before);
});

test('configuration refuses incomplete settings without writing a prerequisite', async () => {
    const f = fixture();
    await f.database.saveContestSettings({ guildId: GUILD, tracks: {}, defaultTrackId: 'default', applicationPermissionRoles: [] });
    const before = JSON.stringify(await f.database.getContestSettings(GUILD));
    await f.command().execute(f.interaction({ subcommand: '设置', role: { id: ROLE } }));
    assert.match(f.effects.edits.at(-1).content, /先.*设置.*赛事申请入口/);
    assert.equal(JSON.stringify(await f.database.getContestSettings(GUILD)), before);
});

test('view displays all legacy roles including invalid IDs without removing restrictions', async () => {
    const f = fixture();
    await f.seed();
    const before = JSON.stringify(await f.database.getContestSettings(GUILD));
    await f.command().execute(f.interaction());
    const content = [...f.effects.replies, ...f.effects.edits].at(-1).content;
    assert.match(content, new RegExp(ROLE));
    assert.match(content, new RegExp(OLD_ROLE));
    assert.match(content, /失效|已删除|无效/);
    assert.match(content, /任一|之一/);
    assert.equal(JSON.stringify(await f.database.getContestSettings(GUILD)), before);
});

test('clear persists an empty role list and view describes unrestricted access', async () => {
    const f = fixture();
    await f.seed();
    await f.command().execute(f.interaction({ subcommand: '清除' }));
    assert.deepEqual(Array.from((await f.database.getContestSettings(GUILD)).applicationPermissionRoles), []);
    await f.command().execute(f.interaction());
    assert.match([...f.effects.replies, ...f.effects.edits].at(-1).content, /不限|不限制|所有成员/);
});

test('view preserves a prerequisite when its role cannot be fetched', async () => {
    const f = fixture();
    await f.seed();
    const interaction = f.interaction();
    interaction.guild.roles.fetch = async () => { throw new Error('Discord unavailable'); };
    await f.command().execute(interaction);
    assert.match(f.effects.edits.at(-1).content, new RegExp(ROLE));
    assert.match(f.effects.edits.at(-1).content, /无效|无法确认/);
    assert.deepEqual(Array.from((await f.database.getContestSettings(GUILD)).applicationPermissionRoles), [ROLE, OLD_ROLE]);
    assert.equal(f.effects.deferred[0].flags, discord.MessageFlags.Ephemeral);
});
