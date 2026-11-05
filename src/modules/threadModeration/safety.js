const { ChannelType, PermissionFlagsBits: P } = require('discord.js');
const { SafetyError } = require('./errors');

function validateId(id) {
    if (typeof id !== 'string' || !/^[1-9]\d{16,19}$/.test(id) || BigInt(id) > 18446744073709551615n) {
        throw new SafetyError('ID 必须是有效的 Discord 数字 ID（17～20 位）。');
    }
    return id;
}

function supportedParent(channel) {
    return channel && [ChannelType.GuildText, ChannelType.GuildForum].includes(channel.type);
}

class Safety {
    constructor(client, store, { checkPermission = member => require('../../core/utils/permissionManager').checkAdminPermission(member) } = {}) {
        this.client = client;
        this.store = store;
        this.checkPermission = checkPermission;
    }

    async authorize(spec, configOnly = false) {
        const guild = await (await this.client.guilds.fetch(spec.guildId)).fetch();
        const roles = await guild.roles.fetch();
        const actor = await guild.members.fetch({ user: spec.actorId, force: true, cache: false });
        if (!actor || actor.guild?.id !== spec.guildId || guild.id !== spec.guildId) throw new SafetyError('无法获取当前服务器成员。');
        const admin = this.checkPermission(actor);
        const delegated = !configOnly && [...actor.roles.cache.keys()].some(id => id !== guild.id && roles.has(id) && this.store.has(guild.id, 'role', id));
        if (!admin && !delegated) throw new SafetyError(configOnly ? '您当前没有管理权限，不能访问锁帖配置。' : '您当前没有锁帖或解锁权限。');
        return { guild, roles, actor };
    }

    async target(spec) {
        validateId(spec.threadId);
        const context = await this.authorize(spec);
        const { guild, actor } = context;
        const thread = await guild.channels.fetch(spec.threadId, { force: true });
        if (!thread || thread.guildId !== guild.id) throw new SafetyError('目标帖子不存在或不属于当前服务器。');
        if (!thread.isThread?.()) throw new SafetyError('目标必须是 Discord 帖子或文字频道子区。');
        const parent = await guild.channels.fetch(thread.parentId, { force: true });
        if (!parent || parent.guildId !== guild.id || !supportedParent(parent)) throw new SafetyError('真实父频道必须是本服务器的普通文字频道或论坛频道。');
        if (!this.store.has(guild.id, 'channel', parent.id)) throw new SafetyError('该帖子真实父频道尚未加入锁帖白名单。');
        const permissions = thread.permissionsFor(actor);
        if (!permissions?.has(P.ViewChannel)) throw new SafetyError('您没有查看目标帖子的权限。');
        if (thread.type === ChannelType.PrivateThread && !permissions.has(P.ManageThreads)) {
            try {
                const membership = await thread.members.fetch({ member: actor.id, force: true, cache: false });
                if (membership?.id !== actor.id) throw new Error('not a member');
            } catch (_) { throw new SafetyError('您无法实际访问该私人子区。'); }
        }
        const bot = await guild.members.fetch({ user: this.client.user.id, force: true, cache: false });
        if (bot.communicationDisabledUntilTimestamp > Date.now()) throw new SafetyError('Bot 当前被禁言，无法发送公示或管理帖子。');
        const botPermissions = thread.permissionsFor(bot);
        for (const name of ['ViewChannel', 'SendMessagesInThreads', 'ManageThreads', 'EmbedLinks', 'ReadMessageHistory']) {
            if (!botPermissions?.has(P[name])) throw new SafetyError(`Bot 缺少目标帖子所需的 ${name} 权限。`);
        }
        return { ...context, thread, parent, bot, botPermissions };
    }
}

module.exports = { Safety, validateId, supportedParent };
