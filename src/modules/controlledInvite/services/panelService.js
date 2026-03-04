const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getConfigsByMainGuild, getEligibleRoles } = require('../utils/controlledInviteDatabase');

/**
 * 构建入口消息（Embed + 按钮）
 * 消息内容由 Bot 全自动生成，包含：说明、有效时长、警告说明、按钮
 */
async function buildEntryMessage(client, mainGuildId, configs) {
    const enabledConfigs = configs.filter(c => c.enabled);
    if (enabledConfigs.length === 0) {
        return {
            content: null,
            embeds: [new EmbedBuilder()
                .setTitle('🔒 分服受控邀请')
                .setDescription('当前没有可用的分服入口。')
                .setColor(0xED4245)],
            components: [],
        };
    }

    // 获取分服名称
    const subGuildNames = {};
    for (const config of enabledConfigs) {
        try {
            const guild = await client.guilds.fetch(config.sub_guild_id).catch(() => null);
            subGuildNames[config.sub_guild_id] = guild ? guild.name : `分服 ${config.sub_guild_id}`;
        } catch {
            subGuildNames[config.sub_guild_id] = `分服 ${config.sub_guild_id}`;
        }
    }

    // 取第一个配置的有效时长作展示（多分服可能不同，但入口消息统一展示）
    const maxAgeMinutes = Math.round(enabledConfigs[0].invite_max_age_seconds / 60);

    // 构建 Embed
    const description = [
        '点击下方按钮即可申请一次性专属邀请码，用于加入分服务器。',
        '',
        `⏱️ **邀请码有效期为 ${maxAgeMinutes} 分钟**，过期后将自动失效。`,
        '',
        '> ⚠️ **重要提醒**',
        '> • 邀请码仅限本人使用，**将邀请码分享给他人将导致您被永久禁止再次获取邀请码**',
        '> • **使用非本人申请的邀请码进入分服将被踢出甚至封禁**',
    ];

    const embed = new EmbedBuilder()
        .setTitle('🔑 分服受控邀请')
        .setDescription(description.join('\n'))
        .setColor(0x5865F2)
        .setFooter({ text: '受控邀请系统' })
        .setTimestamp();

    // 构建按钮
    const row = new ActionRowBuilder();

    if (enabledConfigs.length === 1) {
        // 单分服：一个按钮
        const config = enabledConfigs[0];
        const name = subGuildNames[config.sub_guild_id];
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`ci_request:${config.sub_guild_id}`)
                .setLabel(`申请邀请码 - ${name}`)
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🔗')
        );
    } else {
        // 多分服：每个分服一个按钮
        for (const config of enabledConfigs) {
            const name = subGuildNames[config.sub_guild_id];
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`ci_request:${config.sub_guild_id}`)
                    .setLabel(name)
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('🔗')
            );
        }
    }

    return {
        content: null,
        embeds: [embed],
        components: [row],
    };
}

module.exports = { buildEntryMessage };
