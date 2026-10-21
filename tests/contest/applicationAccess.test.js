const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const discord = require('discord.js');

const root = path.resolve(__dirname, '../..');
const GUILD = '100000000000000001';
const USER = '200000000000000001';
const ROLE = '300000000000000001';
const OTHER_ROLE = '300000000000000002';
const FORUM = '400000000000000001';

// Only the external/database boundaries are replaced. The permissions, modal,
// application service, and interaction dispatcher under test are real modules.
function load(relative, stubs = {}, ignoreUnrelated = false) {
    const filename = path.join(root, relative);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports,
        require(name) {
            if (Object.hasOwn(stubs, name)) return stubs[name];
            if (name === 'discord.js') return discord;
            if (ignoreUnrelated) return {};
            throw new Error(`Unexpected dependency: ${name}`);
        },
        console: { log() {}, error() {}, warn() {} },
        process: { env: {} },
        __filename: filename, __dirname: path.dirname(filename)
    }, { filename });
    return module.exports;
}

const permissions = load('src/modules/contest/utils/contestPermissions.js', {
    '../../../core/utils/permissionManager': {
        checkAdminPermission: member => Boolean(member?.admin || member?.guild?.ownerId === member?.user?.id)
    }
});

function member(roleIds = [], admin = false) {
    return {
        user: { id: USER, tag: 'applicant' },
        guild: { id: GUILD, ownerId: 'other-owner' },
        admin,
        roles: { cache: new discord.Collection(roleIds.map(id => [id, { id }])) }
    };
}

test('application qualification requires the role even for administrators and owners', () => {
    const settings = { applicationPermissionRoles: [ROLE] };
    assert.equal(permissions.checkContestApplicationPermission(member(), settings), false);
    assert.equal(permissions.checkContestApplicationPermission(member([], true), settings), false);
    const owner = member();
    owner.guild.ownerId = USER;
    assert.equal(permissions.checkContestApplicationPermission(owner, settings), false);
    assert.equal(permissions.checkContestApplicationPermission(member([ROLE]), settings), true);
    assert.equal(permissions.checkContestApplicationPermission(member([ROLE], true), settings), true);
    // The prerequisite must not remove administrators' existing review powers.
    assert.equal(permissions.checkContestReviewPermission(member([], true), settings), true);
});

test('unset and empty restrictions allow valid members, and legacy lists remain any-of', () => {
    for (const settings of [{}, { applicationPermissionRoles: [] }]) {
        assert.equal(permissions.checkContestApplicationPermission(member(), settings), true);
        assert.equal(permissions.checkContestApplicationPermission(member([], true), settings), true);
    }
    assert.equal(permissions.checkContestApplicationPermission(member([OTHER_ROLE]), {
        applicationPermissionRoles: [ROLE, OTHER_ROLE]
    }), true);
});

test('unavailable membership and malformed restrictions fail closed', () => {
    for (const invalid of [null, {}, { user: { id: USER } }, { ...member(), roles: {} }, { ...member(), roles: { cache: {} } }]) {
        assert.equal(permissions.checkContestApplicationPermission(invalid, { applicationPermissionRoles: [] }), false);
    }
    for (const invalidSettings of [null, 'corrupt', []]) {
        assert.equal(permissions.checkContestApplicationPermission(member(), invalidSettings), false);
    }
    for (const invalidRoles of [null, ROLE, {}, [null], [ROLE, null]]) {
        assert.equal(permissions.checkContestApplicationPermission(member([ROLE], true), {
            applicationPermissionRoles: invalidRoles
        }), false);
    }
});

function fixture(roleIds = [], restriction = [ROLE], admin = false) {
    const effects = { replies: [], edits: [], modals: [], deferred: [], ids: 0, threads: [], saved: [], fetched: [] };
    const state = {
        settings: {
            guildId: GUILD, defaultTrackId: 'art',
            tracks: { art: { id: 'art', name: '绘画', reviewForumId: FORUM } },
            applicationPermissionRoles: restriction
        }
    };
    const applicant = member(roleIds, admin);
    const guild = {
        id: GUILD,
        roles: { cache: new discord.Collection([[ROLE, { id: ROLE, name: '赛事主办资格' }]]) }
    };
    applicant.guild = { ...applicant.guild, ...guild };
    const database = {
        async getContestSettings(guildId) {
            assert.equal(guildId, GUILD);
            if (state.readError) throw new Error('settings unavailable');
            return state.settings ? structuredClone(state.settings) : null;
        },
        getNextApplicationId() { effects.ids++; return 'app-1'; },
        async saveContestApplication(data) { effects.saved.push(data); }
    };
    const forum = {
        id: FORUM, guild,
        threads: {
            async create(data) {
                effects.threads.push(data);
                return { id: 'thread-1', url: 'https://discord.com/channels/test/thread-1', guild };
            }
        }
    };
    const client = {
        channels: { async fetch(id) { effects.fetched.push(id); return forum; } }
    };
    const service = load('src/modules/contest/services/applicationService.js', {
        '../utils/contestDatabase': database,
        '../utils/contestPermissions': permissions,
        '../utils/forumTagManager': { async ensureContestStatusTags() { return { PENDING: 'pending' }; } }
    });
    const modal = load('src/modules/contest/components/applicationModal.js');
    const { interactionCreateHandler: dispatch } = load('src/core/events/interactionCreate.js', {
        '../config/disabledFeatures': { isDisabledInteraction: () => false },
        '../../modules/botMessage': { BOT_MESSAGE_CUSTOM_ID_PREFIX: 'bot_message_' },
        '../../modules/contest/utils/contestDatabase': database,
        '../../modules/contest/utils/contestPermissions': permissions,
        '../../modules/contest/components/applicationModal': modal,
        '../../modules/contest/services/applicationService': service
    }, true);

    function interaction(kind, customId = 'contest_application_art') {
        return {
            customId, guild, member: applicant, user: applicant.user, client,
            fields: { getTextInputValue: field => field === 'contest_notes' ? '' : 'test contest' },
            isAutocomplete: () => false,
            isChatInputCommand: () => false,
            isMessageContextMenuCommand: () => false,
            isUserContextMenuCommand: () => false,
            isButton: () => kind === 'button',
            isModalSubmit: () => kind === 'modal',
            isStringSelectMenu: () => false,
            async reply(data) { effects.replies.push(data); this.replied = true; },
            async editReply(data) { effects.edits.push(data); },
            async deferReply(data) { effects.deferred.push(data); this.deferred = true; },
            async showModal(data) { effects.modals.push(data); }
        };
    }
    return { effects, state, applicant, guild, dispatch, interaction };
}

function assertNoApplication(effects) {
    assert.equal(effects.ids, 0, 'must not allocate an application number');
    assert.equal(effects.threads.length, 0, 'must not create a review thread');
    assert.equal(effects.saved.length, 0, 'must not store an application');
    assert.equal(effects.fetched.length, 0, 'must reject before fetching the review forum');
}

test('buttons enforce the global role on both legacy and track-specific entries', async t => {
    for (const customId of ['contest_application', 'contest_application_art']) {
        for (const admin of [false, true]) {
            await t.test(`${customId}, administrator=${admin}`, async () => {
                const f = fixture([], [ROLE], admin);
                await f.dispatch(f.interaction('button', customId));
                assert.equal(f.effects.modals.length, 0);
                assert.equal(f.effects.replies.length, 1);
                assert.equal(f.effects.replies[0].flags, discord.MessageFlags.Ephemeral);
                assertNoApplication(f.effects);
            });
        }
    }
});

test('qualified users can open either entry and legacy entries resolve the current default track', async t => {
    for (const customId of ['contest_application', 'contest_application_art']) {
        await t.test(customId, async () => {
            const f = fixture([ROLE]);
            await f.dispatch(f.interaction('button', customId));
            assert.equal(f.effects.modals.length, 1);
            assert.equal(f.effects.modals[0].data.custom_id, 'contest_application_art');
            assert.equal(f.effects.replies.length, 0);
        });
    }
});

test('deleted prerequisite stays restrictive and the private denial identifies its ID', async () => {
    const f = fixture();
    f.guild.roles.cache.clear();
    await f.dispatch(f.interaction('button'));
    assert.equal(f.effects.modals.length, 0);
    assert.match(f.effects.replies[0].content, new RegExp(ROLE));
    assert.match(f.effects.replies[0].content, /重新设置|清除/);
    assert.doesNotMatch(f.effects.replies[0].content, /服务器管理员权限/);
});

test('unconfigured or unreadable systems never open an application modal', async t => {
    for (const kind of ['missing', 'readError', 'invalidRoles']) {
        await t.test(kind, async () => {
            const f = fixture([ROLE]);
            if (kind === 'missing') f.state.settings = null;
            else if (kind === 'readError') f.state.readError = true;
            else f.state.settings.applicationPermissionRoles = null;
            await f.dispatch(f.interaction('button'));
            assert.equal(f.effects.modals.length, 0);
            assert.equal(f.effects.replies.length, 1);
            assertNoApplication(f.effects);
        });
    }
});

test('direct modal submissions from unqualified members including administrators have no effects', async t => {
    for (const admin of [false, true]) {
        await t.test(`administrator=${admin}`, async () => {
            const f = fixture([], [ROLE], admin);
            await f.dispatch(f.interaction('modal'));
            assertNoApplication(f.effects);
            assert.equal(f.effects.deferred[0].flags, discord.MessageFlags.Ephemeral);
            assert.match(f.effects.edits.at(-1).content, /权限不足/);
        });
    }
});

test('removing a role while the form is open prevents submission', async () => {
    const f = fixture([ROLE]);
    await f.dispatch(f.interaction('button'));
    assert.equal(f.effects.modals.length, 1);
    f.applicant.roles.cache.delete(ROLE);
    await f.dispatch(f.interaction('modal'));
    assertNoApplication(f.effects);
    assert.match(f.effects.edits.at(-1).content, /权限不足/);
});

test('changing global prerequisite while the form is open prevents submission under the old rule', async () => {
    const f = fixture([ROLE]);
    await f.dispatch(f.interaction('button'));
    f.state.settings.applicationPermissionRoles = [OTHER_ROLE];
    await f.dispatch(f.interaction('modal'));
    assertNoApplication(f.effects);
    assert.match(f.effects.edits.at(-1).content, new RegExp(OTHER_ROLE));
});

test('valid and unrestricted submissions create one review thread and store the correct applicant and track', async t => {
    for (const [roles, restriction, customId] of [
        [[ROLE], [ROLE], 'contest_application_art'],
        [[OTHER_ROLE], [ROLE, OTHER_ROLE], 'contest_application_art'],
        [[], [], 'contest_application'],
        [[], undefined, 'contest_application_art']
    ]) {
        await t.test(`${roles.join(',') || 'unrestricted'}:${customId}`, async () => {
            const f = fixture(roles, restriction);
            // Passing undefined to the fixture uses its default, so explicitly remove it.
            if (restriction === undefined) delete f.state.settings.applicationPermissionRoles;
            await f.dispatch(f.interaction('modal', customId));
            assert.equal(f.effects.ids, 1);
            assert.equal(f.effects.threads.length, 1);
            assert.equal(f.effects.saved.length, 1);
            const saved = f.effects.saved[0];
            assert.equal(saved.guildId, GUILD);
            assert.equal(saved.applicantId, USER);
            assert.equal(saved.trackId, 'art');
            assert.equal(saved.threadId, 'thread-1');
            assert.equal(saved.status, 'pending');
            assert.match(f.effects.edits.at(-1).content, /申请提交成功/);
        });
    }
});

test('clearing the prerequisite takes effect on an already-open form', async () => {
    const f = fixture([ROLE]);
    await f.dispatch(f.interaction('button'));
    f.state.settings.applicationPermissionRoles = [];
    f.applicant.roles.cache.clear();
    await f.dispatch(f.interaction('modal'));
    assert.equal(f.effects.saved.length, 1);
});

test('unavailable member roles, invalid settings, and read failures never create an application', async t => {
    for (const kind of ['member', 'invalidRoles', 'readError', 'missing']) {
        await t.test(kind, async () => {
            const f = fixture([ROLE]);
            if (kind === 'member') f.applicant.roles = {};
            else if (kind === 'invalidRoles') f.state.settings.applicationPermissionRoles = null;
            else if (kind === 'readError') f.state.readError = true;
            else f.state.settings = null;
            await f.dispatch(f.interaction('modal'));
            assertNoApplication(f.effects);
            assert.equal(f.effects.edits.length, 1);
        });
    }
});
