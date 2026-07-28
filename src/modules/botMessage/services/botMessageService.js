// src/modules/botMessage/services/botMessageService.js
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    AttachmentBuilder,
    MessageFlags,
    PermissionFlagsBits,
} = require('discord.js');

const {
    IDS,
    LIMITS,
    parseColor,
    buildContentModal,
    buildEmbedModal,
} = require('../components/messageModals');
const {
    fetchTargetMessage,
    getRichEmbeds,
    countAutoEmbeds,
    snapshotMessage,
    truncate,
} = require('../utils/messageResolver');
const {
    checkBotMessagePermission,
    getBotMessagePermissionDeniedMessage,
} = require('../utils/botMessagePermissions');
const {
    insertHistory,
    getLatestHistory,
    getLogChannelId,
} = require('./botMessageDatabase');

// 编辑已发出的消息时一律不触发提及，避免改个错别字把 @everyone 重新推送一遍
const NO_MENTIONS = { parse: [] };

const ACTION_LABELS = {
    edit_content: '编辑正文',
    edit_embed: '编辑嵌入卡片',
    add_embed: '新增嵌入卡片',
    delete_embed: '删除嵌入卡片',
    replace: '整体替换',
    undo: '撤销上一次改动',
    send: '发送新消息',
};

function messageLink(message) {
    return `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
}

async function replyError(interaction, content) {
    const payload = { content, flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content }).catch(() => {});
    } else {
        await interaction.reply(payload).catch(() => {});
    }
}

/**
 * 统一的权限门禁（所有入口都会先过这一关）
 * @returns {Promise<boolean>} 是否放行
 */
async function ensurePermission(interaction) {
    if (!interaction.guild) {
        await replyError(interaction, '❌ 此指令只能在服务器中使用。');
        return false;
    }
    if (!checkBotMessagePermission(interaction.member)) {
        await replyError(interaction, getBotMessagePermissionDeniedMessage());
        return false;
    }
    return true;
}

// ==================== 操作日志 ====================

/**
 * 向配置的日志频道写一条操作记录（失败不影响主流程）
 */
async function writeAuditLog(interaction, payload) {
    try {
        const guildId = interaction.guild.id;
        const channelId = getLogChannelId(guildId);
        if (!channelId) return;

        const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased?.()) return;

        const botPerms = channel.permissionsFor(interaction.guild.members.me);
        if (!botPerms?.has(PermissionFlagsBits.SendMessages)) {
            console.warn(`[BotMessage] 日志频道 ${channelId} 缺少发言权限，跳过写日志`);
            return;
        }

        const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle(`📝 机器人消息操作：${ACTION_LABELS[payload.action] || payload.action}`)
            .addFields(
                { name: '操作人', value: `<@${interaction.user.id}> (\`${interaction.user.id}\`)`, inline: true },
                { name: '所在频道', value: `<#${payload.channelId}>`, inline: true },
                { name: '目标消息', value: payload.link ? `[点击跳转](${payload.link})` : `\`${payload.messageId}\``, inline: true },
            )
            .setTimestamp();

        if (payload.beforeText) {
            embed.addFields({ name: '变更前', value: `\`\`\`\n${truncate(payload.beforeText, 900) || '（空）'}\n\`\`\`` });
        }
        if (payload.afterText) {
            embed.addFields({ name: '变更后', value: `\`\`\`\n${truncate(payload.afterText, 900) || '（空）'}\n\`\`\`` });
        }
        if (payload.note) {
            embed.addFields({ name: '备注', value: truncate(payload.note, 900) });
        }

        // 变更前内容较长时附带完整备份，便于人工回滚
        const files = [];
        if (payload.beforeText && payload.beforeText.length > 900) {
            files.push(new AttachmentBuilder(
                Buffer.from(payload.beforeText, 'utf8'),
                { name: `before-${payload.messageId}.txt` },
            ));
        }

        await channel.send({ embeds: [embed], files, allowedMentions: NO_MENTIONS });
    } catch (error) {
        console.error('[BotMessage] 写操作日志失败:', error);
    }
}

/**
 * 把快照转成可读文本（用于日志展示）
 */
function snapshotToText(snapshot) {
    if (!snapshot) return '';
    const parts = [];
    if (snapshot.content) parts.push(snapshot.content);
    (snapshot.embeds || []).forEach((embed, i) => {
        const lines = [`[嵌入卡片 #${i + 1}]`];
        if (embed.title) lines.push(`标题：${embed.title}`);
        if (embed.description) lines.push(embed.description);
        if (embed.footer?.text) lines.push(`页脚：${embed.footer.text}`);
        parts.push(lines.join('\n'));
    });
    return parts.join('\n\n');
}

// ==================== 编辑入口：选择要改哪一部分 ====================

/**
 * 构建「要编辑哪一部分」的选择面板
 * @param {import('discord.js').Message} message
 */
function buildEditPicker(message) {
    const embeds = getRichEmbeds(message);
    const autoEmbedCount = countAutoEmbeds(message);
    const hasComponents = (message.components || []).length > 0;

    const lines = [
        `**目标消息：** [点击跳转](${messageLink(message)})　（<#${message.channelId}>）`,
        `**当前构成：** 正文 ${message.content ? `${message.content.length} 字` : '（空）'}　|　嵌入卡片 ${embeds.length} 个`,
        '',
        '请选择要修改的部分：',
    ];

    if (autoEmbedCount > 0) {
        lines.push(
            '',
            `ℹ️ 这条消息还有 ${autoEmbedCount} 个由 Discord 自动生成的链接预览，它们跟随正文里的链接变化，不在可编辑范围内。`,
        );
    }

    if (hasComponents) {
        lines.push(
            '',
            '⚠️ **注意：这条消息带有按钮 / 选择菜单**，很可能是某个功能面板（如投票、自助身份组、赛事面板等）。',
            '手动改动文字不会破坏按钮，但对应系统在刷新面板时可能会把你的改动覆盖掉。',
        );
    }

    const buttons = [
        new ButtonBuilder()
            .setCustomId(`${IDS.BTN_PICK_CONTENT}:${message.channelId}:${message.id}`)
            .setLabel('编辑正文')
            .setEmoji('📝')
            .setStyle(ButtonStyle.Primary),
    ];

    embeds.slice(0, 8).forEach((_, index) => {
        buttons.push(new ButtonBuilder()
            .setCustomId(`${IDS.BTN_PICK_EMBED}:${message.channelId}:${message.id}:${index}`)
            .setLabel(`嵌入卡片 #${index + 1}`)
            .setEmoji('🗂️')
            .setStyle(ButtonStyle.Secondary));
    });

    if (embeds.length < 10) {
        buttons.push(new ButtonBuilder()
            .setCustomId(`${IDS.BTN_PICK_EMBED}:${message.channelId}:${message.id}:new`)
            .setLabel('新增嵌入卡片')
            .setEmoji('➕')
            .setStyle(ButtonStyle.Success));
    }

    buttons.push(new ButtonBuilder()
        .setCustomId(IDS.BTN_CANCEL)
        .setLabel('取消')
        .setStyle(ButtonStyle.Secondary));

    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }

    return { content: lines.join('\n'), components: rows };
}

/**
 * 判断能否跳过选择面板、直接弹出编辑窗口
 */
function canOpenModalDirectly(message) {
    const embeds = getRichEmbeds(message);
    if ((message.components || []).length > 0) return null;
    if (embeds.length === 0) return 'content';
    if (embeds.length === 1 && !message.content) return 'embed0';
    return null;
}

/**
 * 处理选择面板上的按钮点击 → 弹出对应的编辑窗口
 */
async function handlePickerButton(interaction) {
    if (interaction.customId === IDS.BTN_CANCEL) {
        await interaction.update({ content: '已取消。', components: [] });
        return;
    }

    if (!await ensurePermission(interaction)) return;

    const [prefix, channelId, messageId, rawIndex] = interaction.customId.split(':');
    const result = await fetchTargetMessage(interaction, `${channelId}-${messageId}`, { requireEditable: true });
    if (!result.ok) {
        await replyError(interaction, result.error);
        return;
    }

    if (prefix === IDS.BTN_PICK_CONTENT) {
        await interaction.showModal(buildContentModal(result.message));
        return;
    }

    const index = rawIndex === 'new' ? 'new' : Number(rawIndex);
    const modalResult = buildEmbedModal(result.message, index);
    if (!modalResult.ok) {
        await replyError(interaction, modalResult.error);
        return;
    }
    await interaction.showModal(modalResult.modal);
}

// ==================== 编辑执行 ====================

/**
 * 应用一次编辑：写历史 → 改消息 → 记日志
 */
async function applyEdit(interaction, message, editPayload, action, note = null) {
    const before = snapshotMessage(message);

    await message.edit({ ...editPayload, allowedMentions: NO_MENTIONS });

    const after = {
        content: editPayload.content !== undefined ? editPayload.content : before.content,
        embeds: editPayload.embeds !== undefined
            ? editPayload.embeds.map(e => (typeof e.toJSON === 'function' ? e.toJSON() : e))
            : before.embeds,
    };

    try {
        insertHistory({
            guildId: message.guildId,
            channelId: message.channelId,
            messageId: message.id,
            editorId: interaction.user.id,
            action,
            beforeContent: before.content,
            beforeEmbeds: before.embeds,
            afterContent: after.content,
            afterEmbeds: after.embeds,
        });
    } catch (error) {
        console.error('[BotMessage] 写历史记录失败:', error);
    }

    await writeAuditLog(interaction, {
        action,
        channelId: message.channelId,
        messageId: message.id,
        link: messageLink(message),
        beforeText: snapshotToText(before),
        afterText: snapshotToText(after),
        note,
    });

    console.log(`[BotMessage] ${interaction.user.tag} 执行 ${action}：${messageLink(message)}`);
    return { before, after };
}

/**
 * 正文编辑窗口提交
 */
async function handleContentModalSubmit(interaction) {
    if (!await ensurePermission(interaction)) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const [, channelId, messageId] = interaction.customId.split(':');
    const result = await fetchTargetMessage(interaction, `${channelId}-${messageId}`, { requireEditable: true });
    if (!result.ok) {
        await interaction.editReply({ content: result.error });
        return;
    }

    const message = result.message;
    const newContent = interaction.fields.getTextInputValue('content') ?? '';

    if (newContent === (message.content || '')) {
        await interaction.editReply({ content: 'ℹ️ 正文没有变化，未做任何改动。' });
        return;
    }

    if (!newContent && getRichEmbeds(message).length === 0 && message.attachments.size === 0) {
        await interaction.editReply({
            content: '❌ 不能把消息改成完全空白（Discord 不允许既无正文、又无嵌入卡片和附件的消息）。',
        });
        return;
    }

    try {
        await applyEdit(interaction, message, { content: newContent }, 'edit_content');
    } catch (error) {
        console.error('[BotMessage] 编辑正文失败:', error);
        await interaction.editReply({ content: `❌ 编辑失败：${error.message || error}` });
        return;
    }

    await interaction.editReply({
        content: [
            `✅ 已更新消息正文。[点击查看](${messageLink(message)})`,
            '',
            '如果改错了，可以用 `/机器人消息 撤销` 回退到上一版。',
        ].join('\n'),
    });
}

/**
 * 嵌入卡片编辑窗口提交
 */
async function handleEmbedModalSubmit(interaction) {
    if (!await ensurePermission(interaction)) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const [, channelId, messageId, rawIndex] = interaction.customId.split(':');
    const result = await fetchTargetMessage(interaction, `${channelId}-${messageId}`, { requireEditable: true });
    if (!result.ok) {
        await interaction.editReply({ content: result.error });
        return;
    }

    const message = result.message;
    const richEmbeds = getRichEmbeds(message);
    const isNew = rawIndex === 'new';
    const index = isNew ? richEmbeds.length : Number(rawIndex);
    const oldEmbed = isNew ? null : richEmbeds[index]?.toJSON();

    if (!isNew && !oldEmbed) {
        await interaction.editReply({ content: '❌ 目标嵌入卡片已不存在，消息可能刚被改动，请重新执行指令。' });
        return;
    }

    if (isNew && richEmbeds.length >= 10) {
        await interaction.editReply({ content: '❌ 一条消息最多只能有 10 个嵌入卡片。' });
        return;
    }

    const title = interaction.fields.getTextInputValue('title')?.trim() || '';
    const description = interaction.fields.getTextInputValue('description') ?? '';
    const colorRaw = interaction.fields.getTextInputValue('color') ?? '';
    const footer = interaction.fields.getTextInputValue('footer')?.trim() || '';
    const image = interaction.fields.getTextInputValue('image')?.trim() || '';

    const colorResult = parseColor(colorRaw);
    if (!colorResult.ok) {
        await interaction.editReply({ content: colorResult.error });
        return;
    }

    if (image && !/^https?:\/\//i.test(image)) {
        await interaction.editReply({ content: '❌ 图片链接必须以 `http://` 或 `https://` 开头。' });
        return;
    }

    if (description.length > LIMITS.EMBED_DESCRIPTION) {
        await interaction.editReply({ content: `❌ 描述超过 ${LIMITS.EMBED_DESCRIPTION} 字上限。` });
        return;
    }

    const embeds = richEmbeds.map(e => e.toJSON());

    // 标题/描述/图片/页脚全空，且原卡片也没有字段栏、作者、缩略图 → 视为删除这张卡片
    const willBeEmpty = !title && !description && !image && !footer
        && !(oldEmbed?.fields?.length) && !oldEmbed?.author && !oldEmbed?.thumbnail;

    if (willBeEmpty) {
        if (isNew) {
            await interaction.editReply({ content: 'ℹ️ 所有字段都是空的，未新增卡片。' });
            return;
        }
        if (embeds.length === 1 && !message.content && message.attachments.size === 0) {
            await interaction.editReply({
                content: '❌ 删除这张卡片后消息会变成完全空白，Discord 不允许。请先给消息补一段正文，或直接删除整条消息。',
            });
            return;
        }

        embeds.splice(index, 1);
        try {
            await applyEdit(interaction, message, { embeds }, 'delete_embed');
        } catch (error) {
            console.error('[BotMessage] 删除嵌入卡片失败:', error);
            await interaction.editReply({ content: `❌ 操作失败：${error.message || error}` });
            return;
        }
        await interaction.editReply({ content: `🗑️ 已删除嵌入卡片 #${index + 1}。[点击查看](${messageLink(message)})` });
        return;
    }

    const builder = oldEmbed ? EmbedBuilder.from(oldEmbed) : new EmbedBuilder();
    builder.setTitle(title || null);
    builder.setDescription(description || null);
    builder.setColor(colorResult.color === null ? null : colorResult.color);
    builder.setFooter(footer ? { text: footer, iconURL: oldEmbed?.footer?.icon_url || undefined } : null);
    builder.setImage(image || null);

    embeds[index] = builder.toJSON();

    try {
        await applyEdit(interaction, message, { embeds }, isNew ? 'add_embed' : 'edit_embed');
    } catch (error) {
        console.error('[BotMessage] 编辑嵌入卡片失败:', error);
        await interaction.editReply({ content: `❌ 编辑失败：${error.message || error}` });
        return;
    }

    await interaction.editReply({
        content: [
            `✅ 已${isNew ? '新增' : '更新'}嵌入卡片 #${index + 1}。[点击查看](${messageLink(message)})`,
            '',
            '如果改错了，可以用 `/机器人消息 撤销` 回退到上一版。',
        ].join('\n'),
    });
}

// ==================== 整体替换 ====================

/**
 * 用「来源消息」的内容整体覆盖「目标消息」
 */
async function replaceFromSource(interaction, targetInput, sourceInput) {
    const targetResult = await fetchTargetMessage(interaction, targetInput, { requireEditable: true });
    if (!targetResult.ok) {
        await interaction.editReply({ content: targetResult.error });
        return;
    }

    const sourceResult = await fetchTargetMessage(interaction, sourceInput);
    if (!sourceResult.ok) {
        await interaction.editReply({ content: `来源消息读取失败：\n${sourceResult.error}` });
        return;
    }

    const target = targetResult.message;
    const source = sourceResult.message;

    if (target.id === source.id) {
        await interaction.editReply({ content: '❌ 目标消息和来源消息是同一条。' });
        return;
    }

    const newContent = source.content || '';
    const newEmbeds = getRichEmbeds(source).map(e => e.toJSON());

    if (!newContent && newEmbeds.length === 0) {
        await interaction.editReply({
            content: '❌ 来源消息没有任何文字或嵌入卡片内容（纯附件/贴纸无法作为来源，附件不会被复制）。',
        });
        return;
    }

    if (newContent.length > LIMITS.CONTENT) {
        await interaction.editReply({ content: `❌ 来源消息正文 ${newContent.length} 字，超过 ${LIMITS.CONTENT} 字上限。` });
        return;
    }

    try {
        await applyEdit(
            interaction,
            target,
            { content: newContent, embeds: newEmbeds },
            'replace',
            `来源消息：${messageLink(source)}`,
        );
    } catch (error) {
        console.error('[BotMessage] 整体替换失败:', error);
        await interaction.editReply({ content: `❌ 替换失败：${error.message || error}` });
        return;
    }

    const notes = [];
    if (source.attachments.size > 0) {
        notes.push(`⚠️ 来源消息带有 ${source.attachments.size} 个附件，附件不会被复制（Discord 不支持给已发出的消息追加附件）。`);
    }

    await interaction.editReply({
        content: [
            `✅ 已用来源消息的内容整体替换目标消息。[点击查看](${messageLink(target)})`,
            ...notes,
            '',
            '如果改错了，可以用 `/机器人消息 撤销` 回退到上一版。',
        ].join('\n'),
    });
}

// ==================== 撤销 ====================

async function undoLastEdit(interaction, targetInput) {
    const result = await fetchTargetMessage(interaction, targetInput, { requireEditable: true });
    if (!result.ok) {
        await interaction.editReply({ content: result.error });
        return;
    }

    const message = result.message;
    const latest = getLatestHistory(message.guildId, message.id);

    if (!latest) {
        await interaction.editReply({ content: 'ℹ️ 这条消息没有由本模块产生的改动记录，无法撤销。' });
        return;
    }

    if (latest.action === 'send') {
        await interaction.editReply({ content: 'ℹ️ 这条消息是通过本模块发出的，还没有被编辑过，没有可回退的版本。' });
        return;
    }

    const beforeContent = latest.before_content || '';
    const beforeEmbeds = latest.beforeEmbeds || [];

    if (!beforeContent && beforeEmbeds.length === 0 && message.attachments.size === 0) {
        await interaction.editReply({ content: '❌ 上一版内容为空，无法回退（会得到一条完全空白的消息）。' });
        return;
    }

    try {
        await applyEdit(
            interaction,
            message,
            { content: beforeContent, embeds: beforeEmbeds },
            'undo',
            `回退的是 <@${latest.editor_id}> 于 ${latest.created_at} 执行的「${ACTION_LABELS[latest.action] || latest.action}」`,
        );
    } catch (error) {
        console.error('[BotMessage] 撤销失败:', error);
        await interaction.editReply({ content: `❌ 撤销失败：${error.message || error}` });
        return;
    }

    await interaction.editReply({
        content: [
            `↩️ 已回退到上一版本。[点击查看](${messageLink(message)})`,
            `被撤销的改动：<@${latest.editor_id}> 的「${ACTION_LABELS[latest.action] || latest.action}」`,
            '',
            '💡 再次执行「撤销」会回退本次撤销（相当于重做）。',
        ].join('\n'),
    });
}

// ==================== 发送新消息 ====================

/**
 * 校验目标频道是否可发送
 */
async function validateSendChannel(interaction, channel) {
    if (!channel?.isTextBased?.() || channel.isVoiceBased?.()) {
        return '❌ 目标必须是文字频道 / 子区。';
    }

    const memberPerms = channel.permissionsFor(interaction.member);
    if (!memberPerms?.has(PermissionFlagsBits.ViewChannel)) {
        return `❌ 你没有查看 <#${channel.id}> 的权限。`;
    }

    const botPerms = channel.permissionsFor(interaction.guild.members.me);
    if (!botPerms?.has(PermissionFlagsBits.ViewChannel) || !botPerms?.has(PermissionFlagsBits.SendMessages)) {
        return `❌ 机器人没有在 <#${channel.id}> 发言的权限。`;
    }

    return null;
}

/**
 * 真正把消息发出去，并记一条 action=send 的历史
 */
async function deliverMessage(interaction, channel, payload, note = null) {
    const sent = await channel.send({
        ...payload,
        allowedMentions: payload.allowedMentions || NO_MENTIONS,
    });

    try {
        insertHistory({
            guildId: sent.guildId,
            channelId: sent.channelId,
            messageId: sent.id,
            editorId: interaction.user.id,
            action: 'send',
            beforeContent: null,
            beforeEmbeds: null,
            afterContent: sent.content || '',
            afterEmbeds: getRichEmbeds(sent).map(e => e.toJSON()),
        });
    } catch (error) {
        console.error('[BotMessage] 写发送记录失败:', error);
    }

    await writeAuditLog(interaction, {
        action: 'send',
        channelId: sent.channelId,
        messageId: sent.id,
        link: messageLink(sent),
        afterText: snapshotToText(snapshotMessage(sent)),
        note,
    });

    console.log(`[BotMessage] ${interaction.user.tag} 发送了新消息：${messageLink(sent)}`);
    return sent;
}

async function handleSendTextModalSubmit(interaction) {
    if (!await ensurePermission(interaction)) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const [, channelId, allowMentionsFlag] = interaction.customId.split(':');
    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    const channelError = await validateSendChannel(interaction, channel);
    if (channelError) {
        await interaction.editReply({ content: channelError });
        return;
    }

    const content = interaction.fields.getTextInputValue('content');
    if (!content?.trim()) {
        await interaction.editReply({ content: '❌ 消息正文不能为空。' });
        return;
    }

    try {
        const sent = await deliverMessage(interaction, channel, {
            content,
            allowedMentions: allowMentionsFlag === '1' ? undefined : NO_MENTIONS,
        });
        await interaction.editReply({ content: `✅ 已在 <#${channel.id}> 发送消息。[点击查看](${messageLink(sent)})` });
    } catch (error) {
        console.error('[BotMessage] 发送消息失败:', error);
        await interaction.editReply({ content: `❌ 发送失败：${error.message || error}` });
    }
}

async function handleSendEmbedModalSubmit(interaction) {
    if (!await ensurePermission(interaction)) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const [, channelId, allowMentionsFlag] = interaction.customId.split(':');
    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    const channelError = await validateSendChannel(interaction, channel);
    if (channelError) {
        await interaction.editReply({ content: channelError });
        return;
    }

    const title = interaction.fields.getTextInputValue('title')?.trim() || '';
    const description = interaction.fields.getTextInputValue('description') ?? '';
    const colorRaw = interaction.fields.getTextInputValue('color') ?? '';
    const footer = interaction.fields.getTextInputValue('footer')?.trim() || '';
    const image = interaction.fields.getTextInputValue('image')?.trim() || '';

    if (!title && !description && !image) {
        await interaction.editReply({ content: '❌ 标题、描述、图片至少要填一项，否则卡片是空的。' });
        return;
    }

    const colorResult = parseColor(colorRaw);
    if (!colorResult.ok) {
        await interaction.editReply({ content: colorResult.error });
        return;
    }

    if (image && !/^https?:\/\//i.test(image)) {
        await interaction.editReply({ content: '❌ 图片链接必须以 `http://` 或 `https://` 开头。' });
        return;
    }

    const embed = new EmbedBuilder();
    if (title) embed.setTitle(title);
    if (description) embed.setDescription(description);
    if (colorResult.color !== null) embed.setColor(colorResult.color);
    if (footer) embed.setFooter({ text: footer });
    if (image) embed.setImage(image);

    try {
        const sent = await deliverMessage(interaction, channel, {
            embeds: [embed],
            allowedMentions: allowMentionsFlag === '1' ? undefined : NO_MENTIONS,
        });
        await interaction.editReply({ content: `✅ 已在 <#${channel.id}> 发送嵌入卡片。[点击查看](${messageLink(sent)})` });
    } catch (error) {
        console.error('[BotMessage] 发送嵌入卡片失败:', error);
        await interaction.editReply({ content: `❌ 发送失败：${error.message || error}` });
    }
}

/**
 * 从来源消息复制内容并发送到目标频道
 */
async function sendFromSource(interaction, channel, sourceInput, allowMentions) {
    const channelError = await validateSendChannel(interaction, channel);
    if (channelError) {
        await interaction.editReply({ content: channelError });
        return;
    }

    const sourceResult = await fetchTargetMessage(interaction, sourceInput);
    if (!sourceResult.ok) {
        await interaction.editReply({ content: `来源消息读取失败：\n${sourceResult.error}` });
        return;
    }

    const source = sourceResult.message;
    const content = source.content || '';
    const embeds = getRichEmbeds(source).map(e => e.toJSON());

    if (!content && embeds.length === 0) {
        await interaction.editReply({ content: '❌ 来源消息没有任何文字或嵌入卡片内容。' });
        return;
    }

    try {
        const sent = await deliverMessage(
            interaction,
            channel,
            {
                content: content || undefined,
                embeds,
                allowedMentions: allowMentions ? undefined : NO_MENTIONS,
            },
            `来源消息：${messageLink(source)}`,
        );

        const notes = [];
        if (source.attachments.size > 0) {
            notes.push(`⚠️ 来源消息的 ${source.attachments.size} 个附件未被复制。`);
        }

        await interaction.editReply({
            content: [`✅ 已在 <#${channel.id}> 发送消息。[点击查看](${messageLink(sent)})`, ...notes].join('\n'),
        });
    } catch (error) {
        console.error('[BotMessage] 复制发送失败:', error);
        await interaction.editReply({ content: `❌ 发送失败：${error.message || error}` });
    }
}

module.exports = {
    ACTION_LABELS,
    messageLink,
    ensurePermission,
    buildEditPicker,
    canOpenModalDirectly,
    handlePickerButton,
    handleContentModalSubmit,
    handleEmbedModalSubmit,
    handleSendTextModalSubmit,
    handleSendEmbedModalSubmit,
    replaceFromSource,
    undoLastEdit,
    sendFromSource,
    snapshotToText,
};
