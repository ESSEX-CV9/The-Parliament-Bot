// src/modules/botMessage/commands/botMessage.js
const {
    SlashCommandBuilder,
    PermissionFlagsBits,
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
} = require('../services/botMessageService');
const {
    buildSendTextModal,
    buildSendEmbedModal,
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
    // 默认仅对拥有「管理消息」权限的成员可见；实际可用范围仍以模块白名单为准
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand(sub => sub
        .setName('编辑')
        .setDescription('修改机器人已发出消息的文字内容')
        .addStringOption(opt => opt
            .setName('消息')
            .setDescription(MESSAGE_OPTION_DESC)
            .setRequired(true)))
    .addSubcommand(sub => sub
        .setName('发送')
        .setDescription('用机器人在指定频道发一条新消息')
        .addChannelOption(opt => opt
            .setName('频道')
            .setDescription('要发送到的频道')
            .addChannelTypes(...TEXT_CHANNEL_TYPES)
            .setRequired(true))
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
    const channelOption = interaction.options.getChannel('频道');

    if (mode === 'copy') {
        const sourceInput = interaction.options.getString('来源消息');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (!sourceInput) {
            await interaction.editReply({ content: '❌ 形式选择了「复制另一条消息的内容」，请同时填写「来源消息」。' });
            return;
        }

        const channel = await interaction.guild.channels.fetch(channelOption.id).catch(() => null);
        if (!channel) {
            await interaction.editReply({ content: '❌ 无法访问目标频道。' });
            return;
        }

        await sendFromSource(interaction, channel, sourceInput, allowMentions);
        return;
    }

    const modal = mode === 'embed'
        ? buildSendEmbedModal(channelOption.id, allowMentions)
        : buildSendTextModal(channelOption.id, allowMentions);

    await interaction.showModal(modal);
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
};
