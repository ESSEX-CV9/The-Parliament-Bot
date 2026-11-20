// src/modules/channelArchive/services/configService.js
const { ChannelType } = require('discord.js');

function formatTimestamp(timestamp) {
    if (!timestamp) return '未记录';
    return new Date(Number(timestamp) + 8 * 60 * 60 * 1000)
        .toISOString()
        .replace('T', ' ')
        .slice(0, 19) + ' (UTC+8)';
}

function getConfig(store, guildId) {
    return store.getConfig(guildId);
}

/**
 * 解析类别 ID 列表：支持纯 ID、<#ID>、频道链接，空格/逗号/分号/换行分隔。
 */
function parseIdList(input) {
    if (!input) return [];
    const ids = [];
    const tokens = String(input).split(/[\s,，;；]+/).filter(Boolean);
    for (const raw of tokens) {
        let token = raw.trim();
        if (token.includes('/')) token = token.slice(token.lastIndexOf('/') + 1);
        token = token.replace(/^<#/, '').replace(/>$/, '');
        if (/^\d{15,25}$/.test(token) && !ids.includes(token)) ids.push(token);
    }
    return ids;
}

function getAllowedCategoryIds(config) {
    if (!config?.allowed_category_id) return [];
    return parseIdList(config.allowed_category_id);
}

function describeConfig(config) {
    if (!config) return '尚未配置。请使用 `/归档配置 设置` 完成 4 项配置。';
    const categoryIds = getAllowedCategoryIds(config);
    return [
        `**赛事组：** <@&${config.event_role_id}>`,
        `**管理组：** <@&${config.mod_role_id}>`,
        `**允许类别：** ${categoryIds.length ? categoryIds.map(id => `<#${id}>`).join('、') : '未配置'}`,
        `**目标论坛：** <#${config.target_forum_id}>`,
        `**最后更新：** ${formatTimestamp(config.updated_at)}`,
    ].join('\n');
}

async function resolveConfigChannels(interaction, allowedCategoryInput, targetForumId) {
    const guild = interaction.guild;
    const categoryIds = parseIdList(allowedCategoryInput);
    if (!categoryIds.length) {
        return { error: '❌ 请至少填写一个有效的类别 ID（支持类别链接，多个用空格或逗号分隔）。' };
    }
    const categories = [];
    for (const id of categoryIds) {
        const category = await guild.channels.fetch(id).catch(() => null);
        if (!category || category.type !== ChannelType.GuildCategory) {
            return { error: `❌ 类别 ${id} 不存在或不是类别频道。` };
        }
        categories.push(category);
    }
    const forum = await guild.channels.fetch(targetForumId).catch(() => null);
    if (!forum || forum.type !== ChannelType.GuildForum) {
        return { error: '❌ 目标论坛必须是本服务器中存在的论坛频道。' };
    }
    return { categories, category: categories[0], forum };
}

async function validateStoredConfig(interaction, config) {
    if (!config) return { error: '❌ 本服务器尚未配置归档系统，请先使用 `/归档配置 设置`。' };
    const guild = interaction.guild;
    if (!guild) return { error: '❌ 该功能只能在服务器中使用。' };

    const categoryIds = getAllowedCategoryIds(config);
    if (!categoryIds.length) {
        return { error: '❌ 配置的允许类别无效，请管理员重新配置。' };
    }
    const categories = [];
    for (const id of categoryIds) {
        const category = await guild.channels.fetch(id).catch(() => null);
        if (!category || category.type !== ChannelType.GuildCategory) {
            return { error: `❌ 配置的允许类别 <#${id}> 已不存在或类型已变更，请管理员重新配置。` };
        }
        categories.push(category);
    }
    const forum = await guild.channels.fetch(config.target_forum_id).catch(() => null);
    if (!forum || forum.type !== ChannelType.GuildForum) {
        return { error: '❌ 配置的目标论坛已不存在或类型已变更，请管理员重新配置。' };
    }
    return { categories, category: categories[0], forum };
}

module.exports = {
    formatTimestamp,
    getConfig,
    describeConfig,
    parseIdList,
    getAllowedCategoryIds,
    resolveConfigChannels,
    validateStoredConfig,
};
