// src/modules/channelArchive/services/permissionService.js
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { VOTE_TYPE } = require('../utils/constants');
const { getAllowedCategoryIds } = require('./configService');

function isAdministrator(member, memberPermissions) {
    if (memberPermissions?.has?.(PermissionFlagsBits.Administrator)) return true;
    return Boolean(member?.permissions?.has?.(PermissionFlagsBits.Administrator));
}

function hasRole(member, roleId) {
    if (!roleId) return false;
    return Boolean(member?.roles?.cache?.has?.(roleId));
}

function getVoteRoleId(config, voteType) {
    if (!config) return null;
    return voteType === VOTE_TYPE.DELETE ? config.mod_role_id : config.event_role_id;
}

function canParticipate(member, config, voteType) {
    return hasRole(member, getVoteRoleId(config, voteType));
}

function validateBusinessChannel(channel, config) {
    if (!channel) return '❌ 无法获取当前频道。';
    if (channel.type !== ChannelType.GuildText) {
        return '❌ 该命令只能在普通文字频道中使用。';
    }
    if (!config) {
        return '❌ 本服务器尚未配置归档系统，请管理员先使用 `/归档配置 设置`。';
    }
    const categoryIds = getAllowedCategoryIds(config);
    if (!categoryIds.includes(channel.parentId)) {
        const list = categoryIds.length ? categoryIds.map(id => `<#${id}>`).join('、') : '未配置';
        return `❌ 该频道不在允许的类别 ${list} 下。`;
    }
    return null;
}

function getRoleMention(roleId) {
    return roleId ? `<@&${roleId}>` : '未配置身份组';
}

module.exports = {
    isAdministrator,
    hasRole,
    getVoteRoleId,
    canParticipate,
    validateBusinessChannel,
    getRoleMention,
};
