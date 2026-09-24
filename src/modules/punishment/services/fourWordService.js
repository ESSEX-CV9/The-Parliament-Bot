const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { checkDisciplinePermission } = require('../../../core/utils/permissionManager');
const { getFourWordConfig, validDuration, MAX_TIMEOUT_MS } = require('./fourWordConfig');
const { getWarnRoleForGuild, findLatestActivePunishment, markPunishmentExpired } = require('./punishmentDatabase');
const { executeMute } = require('./punishmentExecutor');

const MODAL_PREFIX = 'fourword:punish:';
// Serialize this feature's operations for one guild member, including restores.
const running = new Set();

async function respond(interaction, content) {
    const payload = { content, allowedMentions: { parse: [] } };
    if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
    return interaction.reply({ ...payload, ephemeral: true });
}

async function validate(interaction, targetId, punish) {
    const guild = interaction.guild;
    if (!guild) throw new Error('请在服务器内使用四字功能。');
    const operator = await guild.members.fetch({ user: interaction.user.id, force: true });
    const config = getFourWordConfig(guild.id);
    if (!checkDisciplinePermission(operator, config.allowedRoleIds)) throw new Error('您没有权限使用四字处罚或四字恢复。');
    if (!config.normalRoleId || !config.penaltyRoleId) throw new Error('请先配置正常身份组和处罚身份组。');
    if (config.normalRoleId === config.penaltyRoleId) throw new Error('正常身份组和处罚身份组不能相同。');
    // Roles can gain Administrator after they were configured; refresh both before any member mutation.
    await guild.roles.fetch();
    const fourWordRoles = new Map();
    for (const [name, id] of [['正常身份组', config.normalRoleId], ['处罚身份组', config.penaltyRoleId]]) {
        const role = await guild.roles.fetch(id);
        if (!role) throw new Error(`身份组 ${id} 不存在。`);
        if (role.permissions.has(PermissionFlagsBits.Administrator)) {
            throw new Error(`四字配置无效：${name}拥有「管理员（Administrator）」权限，请先修改身份组权限或重新配置。`);
        }
        fourWordRoles.set(id, role);
    }
    const target = await guild.members.fetch({ user: targetId, force: true }).catch(() => null);
    if (!target) throw new Error('目标成员不存在或已离开服务器。');
    const me = await guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('机器人缺少管理身份组权限。');
    if (!target.manageable) throw new Error('机器人无法管理目标成员，请检查成员身份组层级。');
    const roleIds = [config.normalRoleId, config.penaltyRoleId];
    let warnRoleId;
    if (punish) {
        if (!target.roles.cache.has(config.normalRoleId)) throw new Error('目标成员当前没有正常身份组，无法执行四字处罚。');
        if (target.roles.cache.has(config.penaltyRoleId)) throw new Error('目标成员当前已有处罚身份组，无法重复处罚。');
        if (!target.moderatable) throw new Error('机器人无法禁言目标成员。');
        if (!me.permissions.has(PermissionFlagsBits.ModerateMembers)) throw new Error('机器人缺少禁言成员权限。');
        if (target.communicationDisabledUntilTimestamp > Date.now()) throw new Error('目标成员当前已经处于禁言状态，请先处理现有禁言后再执行四字处罚。');
        warnRoleId = getWarnRoleForGuild(guild.id);
        if (!warnRoleId) throw new Error('请先使用 /处罚 配置警告身份组 设置原警告身份组。');
        if (roleIds.includes(warnRoleId)) throw new Error('正常身份组、处罚身份组不能与原警告身份组相同。');
        if (target.roles.cache.has(warnRoleId) || findLatestActivePunishment(guild.id, target.id, 'warn_role')) {
            throw new Error('目标成员当前已有警告处罚，请先处理现有警告后再执行四字处罚。');
        }
        roleIds.push(warnRoleId);
        if (!validDuration(config.muteDuration) || !validDuration(config.warnDuration)) throw new Error('请配置合法的固定禁言和警告时长。');
        if (config.muteDuration.ms > MAX_TIMEOUT_MS) throw new Error('禁言时长不能超过 28 天。');
        if (!config.message?.trim() || config.message.length > 1900) throw new Error('请配置固定话术（1 至 1900 字符）。');
        if (!config.publicChannelId) throw new Error('请先配置四字公示频道。');
    } else {
        if (!target.roles.cache.has(config.penaltyRoleId)) throw new Error('目标成员当前没有处罚身份组，无法执行四字恢复。');
        const currentWarnRoleId = getWarnRoleForGuild(guild.id);
        if (currentWarnRoleId && roleIds.includes(currentWarnRoleId)) throw new Error('四字身份组与原警告身份组重叠，请先修正配置，避免修改警告状态。');
    }
    for (const id of roleIds) {
        const role = fourWordRoles.get(id) || await guild.roles.fetch(id);
        if (!role) throw new Error(`身份组 ${id} 不存在。`);
        if (role.managed || role.id === guild.id) throw new Error(`身份组 ${id} 是托管身份组或 @everyone，无法操作。`);
        if (me.roles.highest.comparePositionTo(role) <= 0) throw new Error(`机器人身份组层级必须高于身份组 ${id}。`);
    }
    let publicChannel;
    if (punish) {
        publicChannel = await guild.channels.fetch(config.publicChannelId).catch(() => null);
        if (!publicChannel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(publicChannel.type)
            || !publicChannel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
            throw new Error('公示频道不存在或机器人无法在公示频道发送消息。');
        }
    }
    return { config, target, warnRoleId, publicChannel };
}

async function openPunishModal(interaction) {
    try {
        await validate(interaction, interaction.targetId, true);
        const input = new TextInputBuilder().setCustomId('reason').setLabel('处罚原因')
            .setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(false);
        await interaction.showModal(new ModalBuilder().setCustomId(`${MODAL_PREFIX}${interaction.targetId}`)
            .setTitle('四字处罚').addComponents(new ActionRowBuilder().addComponents(input)));
    } catch (error) {
        await respond(interaction, `❌ ${error.message}`);
    }
}

async function run(interaction, targetId, punish, reason = null) {
    await interaction.deferReply({ ephemeral: true });
    const key = `${interaction.guild?.id}:${targetId}`;
    if (running.has(key)) return respond(interaction, '该成员的四字操作正在处理中，请稍后重试。');
    running.add(key);
    try {
        const { config, target, warnRoleId, publicChannel } = await validate(interaction, targetId, punish);
        const from = punish ? config.normalRoleId : config.penaltyRoleId;
        const to = punish ? config.penaltyRoleId : config.normalRoleId;
        const hadTo = target.roles.cache.has(to);
        let removed = false;
        let added = false;
        let core;
        try {
            await target.roles.remove(from, punish ? '四字处罚' : '四字恢复');
            removed = true;
            if (!hadTo) { await target.roles.add(to, punish ? '四字处罚' : '四字恢复'); added = true; }
            if (punish) {
                core = await executeMute(interaction.client, interaction, {
                    targetMember: target, durationMs: config.muteDuration.ms, durationLabel: config.muteDuration.label,
                    reason,
                    warnDuration: config.warnDuration, sync: false, requireWarning: true, expectedWarnRoleId: warnRoleId,
                });
                if (!core?.success) throw Object.assign(new Error(core?.error || '核心处罚失败。'), { punishmentState: core });
            }
        } catch (error) {
            const state = error.punishmentState || core;
            let failed = false;
            async function undo(action) {
                try { await action(); } catch (rollbackError) {
                    failed = true;
                    console.error(`[FourWord] 回滚失败 guild=${interaction.guild.id} user=${targetId}:`, rollbackError);
                }
            }
            if (punish && state?.warnRoleAdded) await undo(() => target.roles.remove(warnRoleId, '四字处罚失败回滚'));
            if (punish && state?.timeoutApplied) await undo(() => target.timeout(null, '四字处罚失败回滚'));
            for (const id of state?.recordIds || []) await undo(() => markPunishmentExpired(id));
            if (added) await undo(() => target.roles.remove(to, '四字操作失败回滚'));
            if (removed) await undo(() => target.roles.add(from, '四字操作失败回滚'));
            console.error(`[FourWord] 操作失败 guild=${interaction.guild.id} user=${targetId}:`, error);
            await respond(interaction, `❌ 操作失败：${error.message}${failed ? '\n部分回滚失败，需要人工检查。' : '\n已回滚本次操作。'}`);
            return;
        }
        if (!punish) { await respond(interaction, '✅ 四字身份组已恢复。'); return; }
        try {
            await publicChannel.send({ content: `<@${target.id}> ${config.message}`, allowedMentions: { parse: [], users: [target.id] } });
        } catch (error) {
            console.error(`[FourWord] 固定话术发送失败 guild=${interaction.guild.id} user=${targetId}:`, error);
            await respond(interaction, '处罚已成功，但固定话术发送失败。');
        }
    } catch (error) {
        await respond(interaction, `❌ ${error.message}`);
    } finally {
        running.delete(key);
    }
}

async function handlePunishModal(interaction) {
    const targetId = interaction.customId.slice(MODAL_PREFIX.length);
    if (!/^\d{17,20}$/.test(targetId)) return respond(interaction, '❌ 四字处罚目标无效。');
    return run(interaction, targetId, true, interaction.fields.getTextInputValue('reason').trim() || null);
}

async function punish(interaction, targetId, reason) { return run(interaction, targetId, true, reason); }
async function restore(interaction, targetId = interaction.targetId) { return run(interaction, targetId, false); }

module.exports = { MODAL_PREFIX, openPunishModal, handlePunishModal, punish, restore };
