const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '../..');
const projectRequire = createRequire(path.join(root, 'package.json'));
const discord = projectRequire('discord.js');
const { ChannelType, MessageType } = discord;
const protection = projectRequire('./src/modules/selfModeration/utils/messageProtection');
const { isProtectedStarterMessage, THREAD_STARTER_PROTECTED_MESSAGE } = protection;

// Fail closed on unexpected dependencies: these tests must never open the bot's database.
function loadService(name, stubs, timers) {
    const filename = path.join(root, 'src/modules/selfModeration/services', `${name}.js`);
    const module = { exports: {} };
    const context = {
        module,
        exports: module.exports,
        require(request) {
            if (Object.hasOwn(stubs, request)) return stubs[request];
            if (request === 'discord.js') return discord;
            if (request === '../utils/messageProtection') return protection;
            throw new Error(`Unexpected dependency in isolated test: ${request}`);
        },
        console: { log() {}, error() {}, warn() {} },
        global: {},
        setTimeout(callback, delay) {
            const timer = { callback, delay };
            timers.push(timer);
            return timer;
        },
        clearTimeout() {},
        __filename: filename,
        __dirname: path.dirname(filename)
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    return module.exports;
}

function fixture(kind = 'reply') {
    const effects = { fetched: [], deleted: [], archived: [], updates: [], votes: [], replies: [], permissions: [], timers: [] };
    const thread = ['forum', 'media', 'uncachedForum', 'reply', 'threadStarterReference'].includes(kind);
    const channel = {
        id: '200000000000000001',
        type: thread ? ChannelType.PublicThread : ChannelType.GuildText,
        isThread: () => thread,
        parent: kind === 'uncachedForum' ? null : { type: kind === 'media' ? ChannelType.GuildMedia : ChannelType.GuildForum },
        permissionOverwrites: {
            async create(...args) { effects.permissions.push(args); },
            async delete() {}
        }
    };
    const message = {
        id: ['forum', 'media', 'uncachedForum'].includes(kind) ? channel.id : '300000000000000001',
        channel,
        type: kind === 'threadStarterReference' ? MessageType.ThreadStarterMessage : MessageType.Default,
        hasThread: kind === 'source',
        author: { id: '400000000000000001', tag: 'test-user', bot: false },
        createdTimestamp: Date.now(),
        content: 'A test message',
        attachments: [],
        embeds: [],
        async delete() { effects.deleted.push(this.id); }
    };
    channel.messages = {
        async fetch(options) {
            effects.fetched.push(options);
            return message;
        }
    };
    const guild = { id: '100000000000000001', members: { me: {}, async fetch() { return { id: message.author.id }; } } };
    const client = { channels: { async fetch() { return channel; } }, guilds: { async fetch() { return guild; } } };
    const vote = {
        guildId: guild.id,
        targetChannelId: channel.id,
        targetMessageId: message.id,
        targetUserId: message.author.id,
        currentReactionCount: 20,
        targetMessageExists: true,
        type: 'delete'
    };
    const interaction = {
        client, guild, channel, member: {}, user: { id: '500000000000000001' },
        async editReply(reply) { effects.replies.push(reply); }
    };
    return { effects, channel, message, client, vote, interaction };
}

function services(f, archiveOverride) {
    const stubs = {
        '../../../core/utils/database': {
            async getSelfModerationSettings() { return {}; },
            async checkMessageTimeLimit() { return { withinLimit: true }; },
            async updateSelfModerationVote(...args) { f.effects.updates.push(args); },
            async getAllSelfModerationVotes() { return {}; }
        },
        '../../../core/utils/permissionManager': {
            checkSelfModerationPermission: () => true,
            checkSelfModerationChannelPermission: () => true,
            getSelfModerationPermissionDeniedMessage: () => 'permission denied'
        },
        '../utils/messageParser': {
            parseMessageUrl: () => ({ guildId: f.vote.guildId, channelId: f.channel.id, messageId: f.message.id })
        },
        '../utils/channelValidator': {
            validateChannel: async () => true,
            checkBotPermissions: () => ({ hasPermission: true })
        },
        './votingManager': {
            async createOrMergeVote(vote) {
                f.effects.votes.push(vote);
                return { voteData: vote, isNewVote: false, message: 'merged' };
            }
        },
        './reactionTracker': {},
        '../../../core/config/timeconfig': {
            MUTE_DURATIONS: { LEVEL_1: { threshold: 5 } },
            SERIOUS_MUTE_STABILITY_CONFIG: { MIN_BASE: 5 },
            computeSeriousBase: n => Math.ceil(n * 1.5),
            getSeriousMuteTotalDurationMinutes: () => 30
        },
        './seriousMuteHistory': {
            getRecentSeriousMuteCount: async () => 0,
            appendSeriousMuteEvent: async () => {}
        },
        '../utils/timeCalculator': {
            formatDuration: String,
            calculateAdditionalMuteDuration: () => ({ additionalDuration: 10, totalDuration: 10, newLevel: 'LEVEL_1' })
        },
        './archiveService': {
            async archiveDeletedMessage(...args) {
                f.effects.archived.push(args);
                return archiveOverride ? archiveOverride(...args) : true;
            }
        }
    };
    return {
        moderation: loadService('moderationService', stubs, f.effects.timers),
        executor: loadService('punishmentExecutor', stubs, f.effects.timers)
    };
}

function assertProtected(result, f, { archived = false } = {}) {
    assert.equal(result.success, false);
    assert.equal(result.protected, true);
    assert.equal(result.error, THREAD_STARTER_PROTECTED_MESSAGE);
    assert.equal(result.archived, archived);
    assert.equal(f.effects.deleted.length, 0);
    assert.equal(f.effects.archived.length, archived ? 1 : 0);
}

function assertFreshFetches(f) {
    assert.ok(f.effects.fetched.length > 0);
    for (const options of f.effects.fetched) {
        assert.equal(options.message, f.message.id);
        assert.equal(options.force, true);
    }
}

test('starter identification covers forum/media posts and uncached thread relationships', async t => {
    for (const kind of ['forum', 'media', 'uncachedForum', 'threadStarterReference', 'source']) {
        await t.test(kind, () => assert.equal(isProtectedStarterMessage(fixture(kind).message), true));
    }
    for (const kind of ['text', 'reply']) {
        await t.test(kind, () => assert.equal(isProtectedStarterMessage(fixture(kind).message), false));
    }
    await t.test('matching IDs alone do not protect a non-thread message', () => {
        const f = fixture('text');
        f.message.id = f.channel.id;
        assert.equal(isProtectedStarterMessage(f.message), false);
    });
});

test('shared validation rejects starters before a vote can be created or merged', async t => {
    for (const kind of ['forum', 'media', 'threadStarterReference', 'source']) {
        for (const type of ['delete', 'mute', 'serious_mute']) {
            await t.test(`${kind}: ${type}`, async () => {
                const f = fixture(kind);
                const { moderation } = services(f);
                const validation = await moderation.validateTargetMessage(f.client, {
                    guildId: f.vote.guildId, channelId: f.channel.id, messageId: f.message.id
                });
                assert.equal(validation.success, false);
                assert.equal(validation.error, THREAD_STARTER_PROTECTED_MESSAGE);
                const result = await moderation.processMessageUrlSubmission(f.interaction, type, 'test-message-url', { earlyDelete: false });
                assert.equal(result.success, false);
                assert.equal(f.effects.votes.length, 0);
                assert.equal(f.effects.updates.length, 0);
                assert.equal(f.effects.replies[0].content, `❌ ${THREAD_STARTER_PROTECTED_MESSAGE}`);
                assertFreshFetches(f);
            });
        }
    }
});

test('ordinary messages and thread replies can still start or join all vote types', async t => {
    for (const kind of ['text', 'reply']) {
        for (const type of ['delete', 'mute', 'serious_mute']) {
            await t.test(`${kind}: ${type}`, async () => {
                const f = fixture(kind);
                const { moderation } = services(f);
                const result = await moderation.processMessageUrlSubmission(f.interaction, type, 'test-message-url', { earlyDelete: false });
                assert.equal(result.success, true);
                assert.equal(f.effects.votes.length, 1);
                assert.equal(f.effects.votes[0].type, type);
            });
        }
    }
});

test('delete boundary rejects every starter before archiving or deleting', async t => {
    for (const kind of ['forum', 'media', 'threadStarterReference', 'source']) {
        await t.test(kind, async () => {
            const f = fixture(kind);
            const { executor } = services(f);
            assertProtected(await executor.deleteAndArchiveMessage(f.client, f.vote), f);
            assertFreshFetches(f);
        });
    }
});

test('ordinary messages are archived and deleted using a refreshed message', async () => {
    const f = fixture('reply');
    const { executor } = services(f);
    const result = await executor.deleteAndArchiveMessage(f.client, f.vote);
    assert.equal(result.success, true);
    assert.equal(result.archived, true);
    assert.equal(f.effects.archived.length, 1);
    assert.deepEqual(f.effects.deleted, [f.message.id]);
    assert.equal(f.effects.fetched.length, 2);
    assertFreshFetches(f);
});

test('archive failure retains the existing deletion behavior for ordinary replies', async () => {
    const f = fixture('reply');
    const { executor } = services(f, async () => { throw new Error('archive unavailable'); });
    const result = await executor.deleteAndArchiveMessage(f.client, f.vote);
    assert.equal(result.success, true);
    assert.equal(result.archived, false);
    assert.deepEqual(f.effects.deleted, [f.message.id]);
    assertFreshFetches(f);
});

test('a thread created while archiving is protected by the last refreshed read', async () => {
    const f = fixture('text');
    const refreshedMessage = { ...f.message, hasThread: true };
    let archived = false;
    f.channel.messages.fetch = async options => {
        f.effects.fetched.push(options);
        return archived ? refreshedMessage : f.message;
    };
    const { executor } = services(f, async () => { archived = true; return true; });
    assertProtected(await executor.deleteAndArchiveMessage(f.client, f.vote), f, { archived: true });
    assertFreshFetches(f);
});

test('a failed last read must not be reported as an already-deleted message', async t => {
    for (const code of [50001, 50013, 'ECONNRESET', 10008]) {
        await t.test(String(code), async () => {
            const f = fixture('text');
            f.channel.messages.fetch = async options => {
                f.effects.fetched.push(options);
                if (f.effects.fetched.length === 2) throw Object.assign(new Error('read failed'), { code });
                return f.message;
            };
            const { executor } = services(f);
            const result = await executor.deleteAndArchiveMessage(f.client, f.vote);
            assert.equal(result.success, code === 10008);
            assert.equal(result.alreadyDeleted === true, code === 10008);
            assert.equal(f.effects.deleted.length, 0);
            assertFreshFetches(f);
        });
    }
});

test('all vote deletion wrappers preserve starters and never record successful deletion', async t => {
    for (const entry of ['executeDeleteMessage', 'deleteMessageImmediately', 'deleteMessageAfterVoteEnd', 'delayedDeleteMessage']) {
        await t.test(entry, async () => {
            const f = fixture('forum');
            const { executor } = services(f);
            let result;
            if (entry === 'delayedDeleteMessage') {
                const pending = executor[entry](f.client, f.vote, { endTime: new Date().toISOString() });
                assert.equal(f.effects.timers.length, 1);
                await f.effects.timers.shift().callback();
                result = await pending;
            } else {
                result = await executor[entry](f.client, f.vote);
            }
            assertProtected(result, f);
            for (const [, , , update] of f.effects.updates) {
                assert.notEqual(update.messageDeleted, true);
                assert.ok(!update.messageDeletedAt);
                assert.notEqual(update.executed, true);
                assert.ok(!update.executedActions?.some(action => action.type === 'delete'));
            }
            if (entry === 'executeDeleteMessage' || entry === 'delayedDeleteMessage') {
                const update = f.effects.updates.at(-1)[3];
                assert.equal(update.status, 'failed');
                assert.equal(update.executed, false);
                assert.equal(update.error, THREAD_STARTER_PROTECTED_MESSAGE);
            }
        });
    }
});

test('pre-existing mute votes can mute without deleting or mislabelling a starter', async t => {
    for (const type of ['mute', 'serious_mute']) {
        await t.test(type, async () => {
            const f = fixture('forum');
            f.vote.type = type;
            f.vote.earlyDelete = false;
            const { executor } = services(f);
            const result = await executor.executeMuteUser(f.client, f.vote);
            assert.equal(result.success, true);
            assert.equal(result.messageDeleted, false);
            assert.equal(result.messageDeleteError, THREAD_STARTER_PROTECTED_MESSAGE);
            assert.equal(f.effects.permissions.length, 1);
            assert.equal(f.effects.deleted.length, 0);
            assert.equal(f.effects.archived.length, 0);
            const deletionUpdate = f.effects.updates.find(([, , , update]) => Object.hasOwn(update, 'messageDeletedOnMuteStart'))[3];
            assert.equal(deletionUpdate.messageDeletedOnMuteStart, false);
            assert.equal(deletionUpdate.messageDeletedAt, null);
            assert.equal(deletionUpdate.messageDeleteResult, false);
            assert.equal(f.effects.timers.length, 1);
        });
    }
});

test('successful mute-related deletion still records its success and timestamp', async t => {
    for (const type of ['mute', 'serious_mute']) {
        for (const entry of ['executeMuteUser', 'deleteMessageAfterVoteEnd']) {
            await t.test(`${type}: ${entry}`, async () => {
                const f = fixture('reply');
                f.vote.type = type;
                const { executor } = services(f);
                const result = await executor[entry](f.client, f.vote);
                assert.equal(result.success, true);
                assert.deepEqual(f.effects.deleted, [f.message.id]);
                const deletionUpdate = f.effects.updates.find(([, , , update]) => Object.hasOwn(update, 'messageDeletedAt'))[3];
                const successField = entry === 'executeMuteUser' ? 'messageDeletedOnMuteStart' : 'messageDeleted';
                assert.equal(deletionUpdate[successField], true);
                assert.ok(Number.isFinite(Date.parse(deletionUpdate.messageDeletedAt)));
                assert.equal(deletionUpdate.messageArchived, true);
            });
        }
    }
});

test('protection remains local to voting and does not intercept native administrator deletion', async () => {
    const f = fixture('forum');
    services(f);
    assert.equal(isProtectedStarterMessage(f.message), true);
    f.channel.messages.delete = async messageId => { f.effects.deleted.push(messageId); };
    const result = await discord.Message.prototype.delete.call(f.message);
    assert.equal(result, f.message);
    assert.deepEqual(f.effects.deleted, [f.message.id]);
});
