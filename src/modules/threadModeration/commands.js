const { ChannelType, EmbedBuilder, MessageFlags } = require('discord.js');
const { validateId, supportedParent } = require('./safety');
const { SafetyError, describe } = require('./errors');
const { MENTIONS } = require('./announcements');

function addThreadCommands(builder) {
    const operation = option => option.setName('操作').setDescription('添加或移除配置').setRequired(true)
        .addChoices({ name: '添加', value: 'add' }, { name: '移除', value: 'remove' });
    const target = option => option.setName('帖子id').setDescription('论坛帖子或文字频道子区的 ID').setRequired(true);
    return builder
        .addSubcommand(sub => sub.setName('锁帖').setDescription('公示原因并锁定、归档白名单内的帖子')
            .addStringOption(target)
            .addStringOption(option => option.setName('原因').setDescription('锁帖原因，1～300 字').setRequired(true).setMinLength(1).setMaxLength(300)))
        .addSubcommand(sub => sub.setName('解锁').setDescription('解锁白名单内的已锁定帖子并公示').addStringOption(target))
        .addSubcommandGroup(group => group.setName('锁帖配置').setDescription('管理本服务器锁帖白名单和授权身份组')
            .addSubcommand(sub => sub.setName('频道').setDescription('添加或移除普通文字/论坛父频道')
                .addStringOption(operation)
                .addStringOption(option => option.setName('频道id').setDescription('手动填写父频道 ID，不能填写帖子或子区 ID').setRequired(true)))
            .addSubcommand(sub => sub.setName('身份组').setDescription('添加或移除仅限锁帖和解锁的授权身份组')
                .addStringOption(operation)
                .addRoleOption(option => option.setName('身份组').setDescription('仅授权锁帖和解锁，不授予管理配置权限').setRequired(true)))
            .addSubcommand(sub => sub.setName('查看').setDescription('私密查看本服务器锁帖配置')));
}

function configurationEmbeds(rows) {
    const sections = [
        ['已授权身份组', rows.filter(row => row.kind === 'role'), '@&'],
        ['已启用的论坛频道', rows.filter(row => row.kind === 'channel' && row.channel_type === ChannelType.GuildForum), '#'],
        ['已启用的普通文字频道', rows.filter(row => row.kind === 'channel' && row.channel_type === ChannelType.GuildText), '#'],
    ];
    const fields = [];
    for (const [name, entries, prefix] of sections) {
        const lines = entries.map(row => `<${prefix}${row.target_id}> · ID：\`${row.target_id}\``);
        if (!lines.length) { fields.push({ name, value: '未配置（空）' }); continue; }
        let value = '';
        for (const line of lines) {
            if (value && value.length + line.length + 1 > 1000) { fields.push({ name, value }); value = ''; }
            value += `${value ? '\n' : ''}${line}`;
        }
        if (value) fields.push({ name, value });
    }
    const embeds = [];
    // Four fields per response stays comfortably below Discord's 6000-char
    // aggregate embed limit. Each response is ephemeral, including follow-ups.
    for (let i = 0; i < fields.length; i += 4) embeds.push(new EmbedBuilder().setTitle('帖子锁定管理配置').setColor(0x5865f2).addFields(fields.slice(i, i + 4)));
    return embeds;
}

function createHandlers({ getService = client => require('./index').getService(client) } = {}) {
    async function configure(interaction, service, spec, subcommand) {
        let context = await service.safety.authorize(spec, true);
        if (subcommand === '查看') {
            const embeds = configurationEmbeds(service.store.config(spec.guildId));
            for (let i = 0; i < embeds.length; i++) {
                await service.safety.authorize(spec, true);
                const payload = { embeds: [embeds[i]], allowedMentions: MENTIONS };
                if (!i) await interaction.editReply(payload);
                else await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
            }
            return;
        }
        const action = interaction.options.getString('操作', true);
        if (!['add', 'remove'].includes(action)) throw new SafetyError('操作必须是添加或移除。');
        const kind = subcommand === '频道' ? 'channel' : subcommand === '身份组' ? 'role' : null;
        if (!kind) throw new SafetyError('未知的锁帖配置指令。');
        const id = validateId(kind === 'channel' ? interaction.options.getString('频道id', true) : interaction.options.getRole('身份组', true)?.id);
        let channelType = null;
        if (kind === 'channel' && action === 'add') {
            const channel = await context.guild.channels.fetch(id, { force: true });
            // Removed/deleted parents can still be removed from the whitelist.
            if (!channel || channel.guildId !== spec.guildId || !supportedParent(channel)) throw new SafetyError('只允许添加本服务器普通文字频道或论坛频道，不能添加帖子、子区或其他类型。');
            channelType = channel?.type ?? null;
        }
        // Re-fetch roles and actor again after resolving the target.
        context = await service.safety.authorize(spec, true);
        service.fence();
        if (kind === 'role') {
            if (id === spec.guildId) throw new SafetyError('禁止授权 @everyone。');
            const role = context.roles.get(id);
            if (!role || role.guild?.id !== spec.guildId) throw new SafetyError('身份组不存在、已删除或不属于当前服务器。');
        }
        const changed = service.store.configure(spec.guildId, kind, id, action, spec.actorId, channelType);
        await interaction.editReply({
            content: changed ? `✅ 已${action === 'add' ? '添加' : '移除'}${kind === 'role' ? '授权身份组' : '白名单父频道'}：\`${id}\`。配置立即生效。`
                : action === 'add' ? `ℹ️ 该配置已经存在：\`${id}\`，无需重复添加。` : `ℹ️ 该配置不存在：\`${id}\`，无需移除。`,
            allowedMentions: MENTIONS,
        });
    }

    async function execute(interaction) {
        if (!interaction.inGuild()) return interaction.reply({ content: '❌ 此命令只能在服务器中使用。', flags: MessageFlags.Ephemeral, allowedMentions: MENTIONS });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const service = getService(interaction.client);
            await service.start();
            const spec = { guildId: interaction.guild.id, actorId: interaction.user.id };
            const group = interaction.options.getSubcommandGroup(false);
            const subcommand = interaction.options.getSubcommand();
            if (group === '锁帖配置') return await configure(interaction, service, spec, subcommand);
            if (group || !['锁帖', '解锁'].includes(subcommand)) throw new SafetyError('未知的锁帖管理指令。');
            const result = await service.run({ ...spec, id: interaction.id, threadId: interaction.options.getString('帖子id', true),
                action: subcommand === '锁帖' ? 'lock' : 'unlock', reason: subcommand === '锁帖' ? interaction.options.getString('原因', true) : null });
            await interaction.editReply({ content: [result.status === 'succeeded' ? '✅' : '⚠️', result.feedback || '请核验操作记录。', `操作 ID：\`${result.id}\``].join('\n'), allowedMentions: MENTIONS });
        } catch (error) {
            await interaction.editReply({ content: `❌ ${describe(error)}`, allowedMentions: MENTIONS });
        }
    }
    return { execute };
}

module.exports = { addThreadCommands, createHandlers, configurationEmbeds, executeThreadModeration: createHandlers().execute };
