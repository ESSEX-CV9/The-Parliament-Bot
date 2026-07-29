// src/modules/botMessage/commands/botMessage.js
const {
    SlashCommandBuilder,
    ChannelType,
    EmbedBuilder,
    MessageFlags,
} = require('discord.js');

const {
    ensurePermission,
    buildEditPicker,
    replaceFromSource,
    undoLastEdit,
    sendFromSource,
    messageLink,
    ACTION_LABELS,
    startForumPost,
    stashForumPost,
    createForumPostFromSource,
    resolveSendTarget,
    validateSendChannel,
} = require('../services/botMessageService');
const {
    buildSendTextModal,
    buildSendEmbedModal,
    buildForumTextModal,
    buildForumEmbedModal,
} = require('../components/messageModals');
const { fetchTargetMessage, truncate } = require('../utils/messageResolver');
const {
    getBotMessageAllowedRoles,
    setBotMessageAllowedRoles,
    getLogChannelId,
    setLogChannelId,
    getHistory,
} = require('../services/botMessageDatabase');

const TEXT_CHANNEL_TYPES = [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
];

const MESSAGE_OPTION_DESC = '消息链接（右键消息 → 复制消息链接），也支持「频道ID-消息ID」或纯消息ID';

const data = new SlashCommandBuilder()
    .setName('机器人消息')
    .setDescription('管理机器人发出的常驻消息（编辑正文 / 发送 / 替换 / 撤销）')
    // 默认对所有人隐藏。
    // 需由服主在「服务器设置 → 整合 → 本机器人 → 权限」中显式放给指定身份组，
    // 且仍要通过模块白名单（/机器人消息 配置）的代码级校验。
    .setDefaultMemberPermissions(0)
    .addSubcommand(sub => sub
        .setName('编辑')
        .setDescription('修改机器人已发出消息的文字内容')
        .addStringOption(opt => opt
            .setName('消息')
            .setDescription(MESSAGE_OPTION_DESC)
            .setRequired(true)))
    .addSubcommand(sub => sub
        .setName('发送')
        .setDescription('用机器人在指定频道或帖子里发一条新消息')
        .addChannelOption(opt => opt
            .setName('频道')
            .setDescription('要发送到的频道（选择器列不出论坛帖/子区，那种请用下面的「帖子或频道」）')
            .addChannelTypes(...TEXT_CHANNEL_TYPES)
            .setRequired(false))
        .addStringOption(opt => opt
            .setName('帖子或频道')
            .setDescription('帖子/频道的链接或ID，也可填帖子里任意一条消息的链接。留空则发到当前所在位置')
            .setRequired(false))
        .addStringOption(opt => opt
            .setName('形式')
            .setDescription('默认：弹窗写纯文本')
            .setRequired(false)
            .addChoices(
                { name: '纯文本（弹窗输入）', value: 'text' },
                { name: '嵌入卡片（弹窗输入）', value: 'embed' },
                { name: '复制另一条消息的内容', value: 'copy' },
            ))
        .addStringOption(opt => opt
            .setName('来源消息')
            .setDescription('形式选择「复制另一条消息」时必填：草稿消息的链接')
            .setRequired(false))
        .addBooleanOption(opt => opt
            .setName('允许提及')
            .setDescription('是否允许真正 @ 到人/身份组（默认否，只显示不推送）')
            .setRequired(false)))
    .addSubcommand(sub => sub
        .setName('发帖')
        .setDescription('用机器人在论坛频道开一个新帖（首楼归机器人，之后可随时编辑）')
        .addChannelOption(opt => opt
            .setName('论坛')
            .setDescription('要发帖的论坛频道')
            .addChannelTypes(ChannelType.GuildForum, ChannelType.GuildMedia)
            .setRequired(true))
        .addStringOption(opt => opt
            .setName('标题')
            .setDescription('帖子标题，最长 100 字')
            .setMaxLength(100)
            .setRequired(true))
        .addStringOption(opt => opt
            .setName('标签')
            .setDescription('帖子标签，可多选（逗号分隔）。部分论坛强制要求标签')
            .setAutocomplete(true)
            .setRequired(false))
        .addStringOption(opt => opt
            .setName('形式')
            .setDescription('默认：弹窗写纯文本首楼')
            .setRequired(false)
            .addChoices(
                { name: '纯文本（弹窗输入）', value: 'text' },
                { name: '嵌入卡片（弹窗输入）', value: 'embed' },
                { name: '复制另一条消息的内容', value: 'copy' },
            ))
        .addStringOption(opt => opt
            .setName('来源消息')
            .setDescription('形式选择「复制另一条消息」时必填：草稿消息的链接')
            .setRequired(false))
        .addBooleanOption(opt => opt
            .setName('允许提及')
            .setDescription('首楼是否允许真正 @ 到人/身份组（默认否）')
            .setRequired(false)))
    .addSubcommand(sub => sub
        .setName('替换')
        .setDescription('用一条草稿消息的内容，整体覆盖机器人已发出的消息（适合长文/复杂排版）')
        .addStringOption(opt => opt
            .setName('目标消息')
            .setDescription(`要被修改的机器人消息。${MESSAGE_OPTION_DESC}`)
            .setRequired(true))
        .addStringOption(opt => opt
            .setName('来源消息')
            .setDescription('内容取自哪条消息（任何人发的都行，机器人只复制文字与卡片）')
            .setRequired(true)))
    .addSubcommand(sub => sub
        .setName('撤销')
        .setDescription('把机器人消息回退到上一次改动之前的版本')
        .addStringOption(opt => opt
            .setName('消息')
            .setDescription(MESSAGE_OPTION_DESC)
            .setRequired(true)))
    .addSubcommand(sub => sub
        .setName('历史')
        .setDescription('查看某条机器人消息的改动记录')
        .addStringOption(opt => opt
            .setName('消息')
            .setDescription(MESSAGE_OPTION_DESC)
            .setRequired(true)))
    .addSubcommand(sub => sub
        .setName('配置')
        .setDescription('配置可使用本模块的身份组与操作日志频道')
        .addStringOption(opt => opt
            .setName('操作')
            .setDescription('要执行的配置操作')
            .setRequired(true)
            .addChoices(
                { name: '查看当前配置', value: 'view' },
                { name: '添加可用身份组', value: 'add_role' },
                { name: '移除可用身份组', value: 'remove_role' },
                { name: '设置操作日志频道', value: 'set_log' },
                { name: '关闭操作日志', value: 'clear_log' },
            ))
        .addRoleOption(opt => opt
            .setName('身份组')
            .setDescription('添加/移除可用身份组时填写')
            .setRequired(false))
        .addChannelOption(opt => opt
            .setName('频道')
            .setDescription('设置操作日志频道时填写')
            .addChannelTypes(...TEXT_CHANNEL_TYPES)
            .setRequired(false)));

async function execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // 「发送」的弹窗形式必须直接 showModal（不能先 defer），因此权限检查放在最前
    if (!await ensurePermission(interaction)) return;

    try {
        if (sub === '发送') {
            await handleSend(interaction);
            return;
        }

        if (sub === '发帖') {
            await handleForumPost(interaction);
            return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        switch (sub) {
            case '编辑':
                await handleEdit(interaction);
                break;
            case '替换':
                await replaceFromSource(
                    interaction,
                    interaction.options.getString('目标消息'),
                    interaction.options.getString('来源消息'),
                );
                break;
            case '撤销':
                await undoLastEdit(interaction, interaction.options.getString('消息'));
                break;
            case '历史':
                await handleHistory(interaction);
                break;
            case '配置':
                await handleConfig(interaction);
                break;
            default:
                await interaction.editReply({ content: '❌ 未知的子指令。' });
        }
    } catch (error) {
        console.error(`[BotMessage] /机器人消息 ${sub} 执行失败:`, error);
        const content = `❌ 执行出错：${error.message || error}`;
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content }).catch(() => {});
        } else {
            await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    }
}

async function handleEdit(interaction) {
    const input = interaction.options.getString('消息');
    const result = await fetchTargetMessage(interaction, input, { requireEditable: true });

    if (!result.ok) {
        await interaction.editReply({ content: result.error });
        return;
    }

    const picker = buildEditPicker(result.message);
    await interaction.editReply(picker);
}

async function handleSend(interaction) {
    const mode = interaction.options.getString('形式') || 'text';
    const allowMentions = interaction.options.getBoolean('允许提及') ?? false;

    const target = await resolveSendTarget(
        interaction,
        interaction.options.getChannel('频道'),
        interaction.options.getString('帖子或频道'),
    );

    if (!target.ok) {
        await interaction.reply({ content: target.error, flags: MessageFlags.Ephemeral });
        return;
    }

    // 目标不可发送时也要在弹窗弹出前拦下，否则用户白填一遍内容
    const channelError = await validateSendChannel(interaction, target.channel);
    if (channelError) {
        await interaction.reply({ content: channelError, flags: MessageFlags.Ephemeral });
        return;
    }

    if (mode === 'copy') {
        const sourceInput = interaction.options.getString('来源消息');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (!sourceInput) {
            await interaction.editReply({ content: '❌ 形式选择了「复制另一条消息的内容」，请同时填写「来源消息」。' });
            return;
        }

        await sendFromSource(interaction, target.channel, sourceInput, allowMentions);
        return;
    }

    const modal = mode === 'embed'
        ? buildSendEmbedModal(target.channel.id, allowMentions)
        : buildSendTextModal(target.channel.id, allowMentions);

    await interaction.showModal(modal);
}

async function handleForumPost(interaction) {
    const forumOption = interaction.options.getChannel('论坛');
    const mode = interaction.options.getString('形式') || 'text';

    const forum = await interaction.guild.channels.fetch(forumOption.id).catch(() => null);

    const prepared = await startForumPost(interaction, forum, {
        title: interaction.options.getString('标题'),
        tagsInput: interaction.options.getString('标签'),
        allowMentions: interaction.options.getBoolean('允许提及') ?? false,
        mode,
        sourceInput: interaction.options.getString('来源消息'),
    });

    if (!prepared.ok) {
        // 校验失败仍要给出可见反馈：弹窗路径尚未响应过交互，这里直接私密回复
        await interaction.reply({ content: prepared.error, flags: MessageFlags.Ephemeral });
        return;
    }

    if (mode === 'copy') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (!prepared.state.sourceInput) {
            await interaction.editReply({ content: '❌ 形式选择了「复制另一条消息的内容」，请同时填写「来源消息」。' });
            return;
        }

        await createForumPostFromSource(interaction, forum, prepared.state);
        return;
    }

    // 弹窗路径：标题/标签暂存到服务端，弹窗只带一个短 key
    const stateKey = interaction.id;
    stashForumPost(stateKey, prepared.state);

    const modal = mode === 'embed'
        ? buildForumEmbedModal(stateKey)
        : buildForumTextModal(stateKey);

    await interaction.showModal(modal);
}

/**
 * 「标签」选项的自动补全：列出目标论坛的可用标签
 */
async function autocomplete(interaction) {
    try {
        if (interaction.options.getSubcommand() !== '发帖') {
            await interaction.respond([]);
            return;
        }

        const forumOption = interaction.options.getChannel('论坛');
        if (!forumOption) {
            await interaction.respond([]);
            return;
        }

        const forum = await interaction.guild.channels.fetch(forumOption.id).catch(() => null);
        const tags = forum?.availableTags || [];

        const focused = (interaction.options.getFocused() || '').toLowerCase();
        // 支持「已填A, 正在填B」：只对最后一段做匹配，选中后拼回前面已填的部分
        const segments = focused.split(/[,，]/);
        const current = segments[segments.length - 1].trim();
        const prefix = segments.slice(0, -1).map(s => s.trim()).filter(Boolean);

        const choices = tags
            .filter(t => !current || t.name.toLowerCase().includes(current))
            .filter(t => !prefix.includes(t.name.toLowerCase()))
            .slice(0, 25)
            .map(t => {
                const combined = [...prefix, t.name].join(', ');
                return {
                    name: combined.length > 100 ? t.name : combined,
                    value: combined.length > 100 ? t.name : combined,
                };
            });

        await interaction.respond(choices);
    } catch (error) {
        console.error('[BotMessage] 标签自动补全失败:', error);
        await interaction.respond([]).catch(() => {});
    }
}

async function handleHistory(interaction) {
    const input = interaction.options.getString('消息');
    const result = await fetchTargetMessage(interaction, input);

    if (!result.ok) {
        await interaction.editReply({ content: result.error });
        return;
    }

    const message = result.message;
    const records = getHistory(interaction.guild.id, message.id, 10);

    if (records.length === 0) {
        await interaction.editReply({ content: 'ℹ️ 这条消息还没有由本模块产生的操作记录。' });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('📜 消息改动记录')
        .setDescription(`目标消息：[点击跳转](${messageLink(message)})　（最近 ${records.length} 条，从新到旧）`)
        .setTimestamp();

    for (const record of records) {
        const timestamp = Math.floor(new Date(record.created_at).getTime() / 1000);
        const beforePreview = truncate(record.before_content || '（无正文）', 200);
        embed.addFields({
            name: `#${record.id}　${ACTION_LABELS[record.action] || record.action}`,
            value: [
                `操作人：<@${record.editor_id}>　时间：<t:${timestamp}:f>`,
                `改动前正文：\`\`\`\n${beforePreview}\n\`\`\``,
            ].join('\n'),
        });
    }

    embed.setFooter({ text: '「/机器人消息 撤销」只会回退最近一次改动' });

    await interaction.editReply({ embeds: [embed] });
}

async function handleConfig(interaction) {
    const action = interaction.options.getString('操作');
    const role = interaction.options.getRole('身份组');
    const channel = interaction.options.getChannel('频道');
    const guildId = interaction.guild.id;

    switch (action) {
        case 'view': {
            const roleIds = getBotMessageAllowedRoles(guildId);
            const logChannelId = getLogChannelId(guildId);
            const embed = new EmbedBuilder()
                .setColor(0x5865f2)
                .setTitle('⚙️ 机器人消息模块配置')
                .addFields(
                    {
                        name: '额外可用身份组',
                        value: roleIds.length > 0
                            ? roleIds.map(id => `• <@&${id}> (\`${id}\`)`).join('\n')
                            : '未配置（当前仅服务器所有者 / 管理员 / core 配置的管理身份组可用）',
                    },
                    {
                        name: '操作日志频道',
                        value: logChannelId ? `<#${logChannelId}>` : '未配置（改动只写入本地历史与控制台日志）',
                    },
                )
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
            return;
        }
        case 'add_role': {
            if (!role) {
                await interaction.editReply({ content: '❌ 请填写要添加的「身份组」。' });
                return;
            }
            const roleIds = getBotMessageAllowedRoles(guildId);
            if (roleIds.includes(role.id)) {
                await interaction.editReply({ content: `ℹ️ <@&${role.id}> 已在白名单中。` });
                return;
            }
            setBotMessageAllowedRoles(guildId, [...roleIds, role.id]);
            await interaction.editReply({
                content: [
                    `✅ 已将 <@&${role.id}> 加入白名单。`,
                    '',
                    '💡 如果该身份组在指令列表里看不到 `/机器人消息`，请到 **服务器设置 → 整合 → 本机器人 → 权限** 里为这个身份组放开该指令。',
                ].join('\n'),
            });
            return;
        }
        case 'remove_role': {
            if (!role) {
                await interaction.editReply({ content: '❌ 请填写要移除的「身份组」。' });
                return;
            }
            const roleIds = getBotMessageAllowedRoles(guildId);
            if (!roleIds.includes(role.id)) {
                await interaction.editReply({ content: `ℹ️ <@&${role.id}> 不在白名单中。` });
                return;
            }
            setBotMessageAllowedRoles(guildId, roleIds.filter(id => id !== role.id));
            await interaction.editReply({ content: `✅ 已将 <@&${role.id}> 移出白名单。` });
            return;
        }
        case 'set_log': {
            if (!channel) {
                await interaction.editReply({ content: '❌ 请填写要作为操作日志的「频道」。' });
                return;
            }
            setLogChannelId(guildId, channel.id);
            await interaction.editReply({ content: `✅ 操作日志频道已设为 <#${channel.id}>，之后每次编辑/发送都会在这里留档。` });
            return;
        }
        case 'clear_log': {
            setLogChannelId(guildId, null);
            await interaction.editReply({ content: '✅ 已关闭操作日志频道（历史记录仍会写入本地数据库）。' });
            return;
        }
        default:
            await interaction.editReply({ content: '❌ 未知的配置操作。' });
    }
}

module.exports = {
    data,
    execute,
    autocomplete,
};
