const { PermissionFlagsBits } = require('discord.js');
const { checkCompatibility } = require('./compatibility');

class SafetyError extends Error {
    constructor(message) { super(message); this.name = 'SafetyError'; this.code = 'SAFETY'; }
}

class Safety {
    constructor(client, {
        checkPermission = member => require('../../core/utils/permissionManager').checkAdminPermission(member),
        allowedRoles = () => require('../../core/utils/permissionManager').getAllowedRoles(),
        checkCompatibility: compatibility = checkCompatibility,
    } = {}) {
        this.client = client;
        this.checkPermission = checkPermission;
        this.allowedRoles = allowedRoles;
        this.compatibility = compatibility;
    }

    async authorize({ guildId, actorId }) {
        const guild = await (await this.client.guilds.fetch(guildId)).fetch();
        const roles = await guild.roles.fetch();
        const actor = await guild.members.fetch({ user: actorId, force: true, cache: false });
        if (!this.checkPermission(actor)) throw new SafetyError('操作者当前没有管理权限。');
        return { guild, roles, actor };
    }

    async check(spec) {
        const { guild, roles, actor } = await this.authorize(spec);
        const bot = await guild.members.fetch({ user: this.client.user.id, force: true, cache: false });
        const role = roles.get(spec.roleId);
        if (!role) throw new SafetyError('目标身份组不存在。');
        if (role.id === guild.id) throw new SafetyError('禁止操作 @everyone。');
        if (role.managed) throw new SafetyError('禁止操作 Discord 托管身份组。');
        if (role.permissions.has(PermissionFlagsBits.Administrator)) throw new SafetyError('禁止操作拥有 Administrator 权限的身份组。');
        if (this.allowedRoles().includes(role.id)) throw new SafetyError('禁止操作管理指令白名单身份组。');
        if (!bot.permissions.has(PermissionFlagsBits.ManageRoles)) throw new SafetyError('Bot 缺少 ManageRoles 权限。');
        // SDK comparison includes Snowflake tie-breaking for equal raw positions.
        if (role.comparePositionTo(actor.roles.highest) >= 0) throw new SafetyError('目标身份组高于或等于操作者最高身份组（所有者也不豁免）。');
        if (role.comparePositionTo(bot.roles.highest) >= 0) throw new SafetyError('目标身份组高于或等于 Bot 最高身份组。');
        try { await this.compatibility(guild.id, role.id); }
        catch (error) { throw new SafetyError(error.message); }
        return { guild, role };
    }
}

module.exports = { Safety, SafetyError };
