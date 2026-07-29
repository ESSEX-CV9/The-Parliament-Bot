// src/modules/botMessage/services/botMessageService.js
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    AttachmentBuilder,
    MessageFlags,
    PermissionFlagsBits,
    ChannelType,
    ChannelFlags,
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
    parseChannelReference,
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
const { unarchiveIfNeeded, restoreArchiveState } = require('../utils/threadArchive');

// 编辑已发出的消息时一律不触发提及，避免改个错别字把 @everyone 重新推送一遍
const NO_MENTIONS = { parse: [] };

// 「允许提及」开启时使用：显式放行三类提及。
// 注意不能用 undefined 表示「走默认」——上层一旦做 `|| NO_MENTIONS` 之类的回退就会被吃掉。
const ALLOW_MENTIONS = { parse: ['users', 'roles', 'everyone'] };

const ACTION_LABELS = {
    edit_content: '编辑正文',
    edit_embed: '编辑嵌入卡片',
    add_embed: '新增嵌入卡片',
    delete_embed: '删除嵌入卡片',
    replace: '整体替换',
    undo: '撤销上一次改动',
    send: '发送新消息',
    create_thread: '发布论坛帖子',
};

function messageLink(message) {
    return `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
}

/**
 * 在可能已归档的子区里安全地响应交互
 *
 * Discord 会拒绝一切发往已归档子区的交互响应（连 ephemeral 也不行，报 50083），
 * 所以要先临时解除归档、回复完再归档回去。
 */
async function safeRespond(interaction, payload) {
    const archiveState = await unarchiveIfNeeded(
        interaction.channel,
        `响应机器人消息交互（操作人 ${interaction.user.tag}）`,
    );

    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(payload);
        } else {
            await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
        }
    } catch (err) {
        console.error('[BotMessage] 响应交互失败:', err.message);
    } finally {
        await restoreArchiveState(archiveState, '交互响应完成，恢复归档');
    }
}

async function replyError(interaction, content) {
    await safeRespond(interaction, { content });
}

/**
 * 模态窗口提交的统一开场
 *
 * 必须先解除归档再 deferReply —— 否则第一个响应就会被 Discord 403 拒绝，
 * 用户只会看到弹窗里那句无信息量的「出现错误，请重试。」（该文案由 Discord 客户端写死，无法自定义）。
 *
 * @returns {Promise<{ok: boolean, finish: () => Promise<any>}>}
 */
async function beginModalResponse(interaction) {
    const noop = { ok: false, finish: async () => {} };

    const archiveState = await unarchiveIfNeeded(
        interaction.channel,
        `响应机器人消息编辑交互（操作人 ${interaction.user.tag}）`,
    );

    if (archiveState.wasArchived && !archiveState.ok) {
        console.error(
            `[BotMessage] 无法在已归档子区 ${interaction.channelId} 响应交互，编辑已中止：${archiveState.error}`,
        );
        return noop;
    }

    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (err) {
        console.error('[BotMessage] deferReply 失败，编辑已中止:', err.message);
        await restoreArchiveState(archiveState, '交互响应失败，恢复归档');
        return noop;
    }

    return {
        ok: true,
        // 供回执文案使用：交互所在子区是否由我们临时解除了归档
        wasArchived: Boolean(archiveState.wasArchived && archiveState.ok),
        finish: () => restoreArchiveState(archiveState, '机器人消息编辑完成，恢复归档'),
    };
}

/**
 * 编辑结果里关于「临时解归档」的补充说明
 */
function formatArchiveNote(...sources) {
    const unarchived = sources.some(s => s?.threadUnarchived || s?.wasArchived);
    if (!unarchived) return '';
    return '\n\n🗄️ 该消息所在子区处于归档状态，已临时解除归档完成编辑，随后恢复原状。';
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

    // 目标消息在已归档子区里时，先临时解除归档，改完立刻归档回去。
    // 若交互本身就发生在该子区，beginModalResponse 已经解除过，这里会识别为「无需处理」，
    // 由外层在回复完成后统一恢复，避免过早归档导致后续回复失败。
    const archiveState = await unarchiveIfNeeded(
        message.channel,
        `编辑机器人消息（操作人 ${interaction.user.tag}）`,
    );

    if (archiveState.wasArchived && !archiveState.ok) {
        throw new Error(archiveState.error);
    }

    try {
        await message.edit({ ...editPayload, allowedMentions: NO_MENTIONS });
    } finally {
        await restoreArchiveState(archiveState, '机器人消息编辑完成，恢复归档');
    }

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
    return { before, after, threadUnarchived: archiveState.wasArchived };
}

/**
 * 正文编辑窗口提交
 */
async function handleContentModalSubmit(interaction) {
    const session = await beginModalResponse(interaction);
    if (!session.ok) return;

    try {
        await runContentModalSubmit(interaction, session);
    } finally {
        await session.finish();
    }
}

async function runContentModalSubmit(interaction, session) {
    if (!await ensurePermission(interaction)) return;

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

    let editResult;
    try {
        editResult = await applyEdit(interaction, message, { content: newContent }, 'edit_content');
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
        ].join('\n') + formatArchiveNote(editResult, session),
    });
}

/**
 * 嵌入卡片编辑窗口提交
 */
async function handleEmbedModalSubmit(interaction) {
    const session = await beginModalResponse(interaction);
    if (!session.ok) return;

    try {
        await runEmbedModalSubmit(interaction, session);
    } finally {
        await session.finish();
    }
}

async function runEmbedModalSubmit(interaction, session) {
    if (!await ensurePermission(interaction)) return;

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
        let deleteResult;
        try {
            deleteResult = await applyEdit(interaction, message, { embeds }, 'delete_embed');
        } catch (error) {
            console.error('[BotMessage] 删除嵌入卡片失败:', error);
            await interaction.editReply({ content: `❌ 操作失败：${error.message || error}` });
            return;
        }
        await interaction.editReply({
            content: `🗑️ 已删除嵌入卡片 #${index + 1}。[点击查看](${messageLink(message)})`
                + formatArchiveNote(deleteResult, session),
        });
        return;
    }

    const builder = oldEmbed ? EmbedBuilder.from(oldEmbed) : new EmbedBuilder();
    builder.setTitle(title || null);
    builder.setDescription(description || null);
    builder.setColor(colorResult.color === null ? null : colorResult.color);
    builder.setFooter(footer ? { text: footer, iconURL: oldEmbed?.footer?.icon_url || undefined } : null);
    builder.setImage(image || null);

    embeds[index] = builder.toJSON();

    let editResult;
    try {
        editResult = await applyEdit(interaction, message, { embeds }, isNew ? 'add_embed' : 'edit_embed');
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
        ].join('\n') + formatArchiveNote(editResult, session),
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

    let result;
    try {
        result = await applyEdit(
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
        ].join('\n') + formatArchiveNote(result),
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

    let editResult;
    try {
        editResult = await applyEdit(
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
        ].join('\n') + formatArchiveNote(editResult),
    });
}

// ==================== 发送新消息 ====================

/**
 * 解析「发送」的目标：频道选择器 / 文本输入 / 默认当前频道
 *
 * Discord 的频道选择器不会列出论坛帖与子区，所以额外提供文本输入路径。
 * @returns {Promise<{ok: true, channel: object} | {ok: false, error: string}>}
 */
async function resolveSendTarget(interaction, channelOption, targetInput) {
    // 两个都填时以文本输入为准（它能表达选择器表达不了的目标）
    if (targetInput) {
        const ref = parseChannelReference(targetInput);
        if (!ref) {
            return {
                ok: false,
                error: [
                    '❌ 无法识别「帖子或频道」的内容。',
                    '',
                    '**支持的填写方式：**',
                    '• 帖子/频道链接：`https://discord.com/channels/服务器ID/频道ID`（右键帖子 → 复制链接）',
                    '• 帖子里任意一条消息的链接',
                    '• `<#频道ID>` 形式的提及',
                    '• 纯频道ID / 帖子ID',
                ].join('\n'),
            };
        }

        if (ref.guildId && ref.guildId !== interaction.guild.id) {
            return { ok: false, error: '❌ 目标不在本服务器，出于安全考虑不允许跨服务器发送。' };
        }

        const channel = await interaction.guild.channels.fetch(ref.channelId).catch(() => null);
        if (!channel) {
            return { ok: false, error: `❌ 找不到频道或帖子 \`${ref.channelId}\`，或机器人没有权限访问它。` };
        }
        return { ok: true, channel };
    }

    if (channelOption) {
        const channel = await interaction.guild.channels.fetch(channelOption.id).catch(() => null);
        if (!channel) {
            return { ok: false, error: '❌ 无法访问所选频道。' };
        }
        return { ok: true, channel };
    }

    // 都没填 → 发到当前所在的频道 / 帖子
    const current = interaction.channel
        || await interaction.client.channels.fetch(interaction.channelId).catch(() => null);
    if (!current) {
        return { ok: false, error: '❌ 请指定「频道」或「帖子或频道」其中之一。' };
    }
    return { ok: true, channel: current };
}

/**
 * 校验目标频道是否可发送
 */
async function validateSendChannel(interaction, channel) {
    if (channel?.type === ChannelType.GuildForum || channel?.type === ChannelType.GuildMedia) {
        return `❌ <#${channel.id}> 是论坛频道，不能直接往里发消息。\n请改用 \`/机器人消息 发帖\` 开新帖，或指定论坛里的某个具体帖子。`;
    }

    if (!channel?.isTextBased?.() || channel.isVoiceBased?.()) {
        return '❌ 目标必须是文字频道 / 子区 / 论坛帖。';
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
 * 「允许提及」开着、但实际 ping 不出去时给出解释
 *
 * 常见两种：正文里写了 @everyone/@here 但机器人没有该权限；
 * 或者内容只在嵌入卡片里——卡片内的提及永远只渲染不推送，这是 Discord 的规则。
 */
function formatMentionNotes(interaction, channel, content, allowMentions, embedOnly = false) {
    if (!allowMentions) return '';

    const notes = [];

    if (embedOnly) {
        notes.push('⚠️ 嵌入卡片里的提及只会显示成高亮文字，**永远不会推送通知**，「允许提及」对卡片内容无效。');
    }

    if (content && /@everyone|@here/.test(content)) {
        const botPerms = channel.permissionsFor(interaction.guild.members.me);
        if (!botPerms?.has(PermissionFlagsBits.MentionEveryone)) {
            notes.push(`⚠️ 正文里有 @everyone/@here，但机器人在 <#${channel.id}> 没有「提及所有人」权限，这部分不会真正推送。`);
        }
    }

    return notes.length ? `\n\n${notes.join('\n')}` : '';
}

/**
 * 真正把消息发出去，并记一条 action=send 的历史
 */
async function deliverMessage(interaction, channel, payload, note = null) {
    // 目标是已归档的帖子时，先临时解除归档，发完再归回去
    const archiveState = await unarchiveIfNeeded(
        channel,
        `机器人消息模块发送消息（操作人 ${interaction.user.tag}）`,
    );
    if (archiveState.wasArchived && !archiveState.ok) {
        throw new Error(archiveState.error);
    }

    // 调用方必须显式给出 allowedMentions（ALLOW_MENTIONS 或 NO_MENTIONS）。
    // 这里只在完全没传时兜底为「不提及」，不再用 || 回退——否则会把显式放行也当成假值吃掉。
    let sent;
    try {
        sent = await channel.send({
            ...payload,
            allowedMentions: payload.allowedMentions ?? NO_MENTIONS,
        });
    } finally {
        await restoreArchiveState(archiveState, '发送完成，恢复归档');
    }

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
    sent.__threadUnarchived = archiveState.wasArchived;
    return sent;
}

async function handleSendTextModalSubmit(interaction) {
    // 指令可能是在归档帖里敲的，必须先解归档才能响应交互
    const session = await beginModalResponse(interaction);
    if (!session.ok) return;

    try {
        await runSendTextModalSubmit(interaction);
    } finally {
        await session.finish();
    }
}

async function runSendTextModalSubmit(interaction) {
    if (!await ensurePermission(interaction)) return;

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

    const allowMentions = allowMentionsFlag === '1';

    try {
        const sent = await deliverMessage(interaction, channel, {
            content,
            allowedMentions: allowMentions ? ALLOW_MENTIONS : NO_MENTIONS,
        });
        await interaction.editReply({
            content: `✅ 已在 <#${channel.id}> 发送消息。[点击查看](${messageLink(sent)})`
                + formatMentionNotes(interaction, channel, content, allowMentions),
        });
    } catch (error) {
        console.error('[BotMessage] 发送消息失败:', error);
        await interaction.editReply({ content: `❌ 发送失败：${error.message || error}` });
    }
}

async function handleSendEmbedModalSubmit(interaction) {
    const session = await beginModalResponse(interaction);
    if (!session.ok) return;

    try {
        await runSendEmbedModalSubmit(interaction);
    } finally {
        await session.finish();
    }
}

async function runSendEmbedModalSubmit(interaction) {
    if (!await ensurePermission(interaction)) return;

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

    const allowMentions = allowMentionsFlag === '1';

    try {
        const sent = await deliverMessage(interaction, channel, {
            embeds: [embed],
            allowedMentions: allowMentions ? ALLOW_MENTIONS : NO_MENTIONS,
        });
        await interaction.editReply({
            content: `✅ 已在 <#${channel.id}> 发送嵌入卡片。[点击查看](${messageLink(sent)})`
                + formatMentionNotes(interaction, channel, null, allowMentions, true),
        });
    } catch (error) {
        console.error('[BotMessage] 发送嵌入卡片失败:', error);
        await interaction.editReply({ content: `❌ 发送失败：${error.message || error}` });
    }
}

// ==================== 论坛发帖 ====================

const FORUM_TITLE_MAX = 100;

/**
 * 论坛发帖的暂存态
 *
 * 帖子标题可长达 100 字符，塞不进上限 100 的 customId，
 * 所以指令阶段先把参数存下来，弹窗只带一个短 key。
 * 交互令牌 15 分钟过期，这里按 20 分钟清理。
 */
const pendingForumPosts = new Map();
const FORUM_STATE_TTL_MS = 20 * 60 * 1000;

function stashForumPost(key, state) {
    pendingForumPosts.set(key, { ...state, createdAt: Date.now() });

    // 顺手清理过期项，避免长期运行时无限增长
    for (const [k, v] of pendingForumPosts) {
        if (Date.now() - v.createdAt > FORUM_STATE_TTL_MS) {
            pendingForumPosts.delete(k);
        }
    }
}

function takeForumPost(key) {
    const state = pendingForumPosts.get(key);
    if (state) pendingForumPosts.delete(key);
    return state || null;
}

/**
 * 校验论坛频道是否可发帖
 * @returns {string|null} 错误信息，可发帖则返回 null
 */
function validateForumChannel(interaction, forum) {
    if (!forum || (forum.type !== ChannelType.GuildForum && forum.type !== ChannelType.GuildMedia)) {
        return '❌ 目标必须是论坛频道或媒体频道。';
    }

    const memberPerms = forum.permissionsFor(interaction.member);
    if (!memberPerms?.has(PermissionFlagsBits.ViewChannel)) {
        return `❌ 你没有查看 <#${forum.id}> 的权限。`;
    }

    const botPerms = forum.permissionsFor(interaction.guild.members.me);
    if (!botPerms?.has(PermissionFlagsBits.ViewChannel)) {
        return `❌ 机器人看不到 <#${forum.id}>。`;
    }
    if (!botPerms.has(PermissionFlagsBits.CreatePublicThreads)) {
        return `❌ 机器人在 <#${forum.id}> 缺少「创建公开帖子」权限，无法发帖。`;
    }
    if (!botPerms.has(PermissionFlagsBits.SendMessagesInThreads)) {
        return `❌ 机器人在 <#${forum.id}> 缺少「在帖子中发言」权限，无法写首楼。`;
    }

    return null;
}

/**
 * 解析用户填写的标签（支持标签ID或标签名，逗号分隔）
 * @returns {{ok: true, tagIds: string[]} | {ok: false, error: string}}
 */
function resolveForumTags(forum, input) {
    const available = forum.availableTags || [];
    const requireTag = Boolean(forum.flags?.has?.(ChannelFlags.RequireTag));

    const raw = (input || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);

    if (raw.length === 0) {
        if (requireTag) {
            const list = available.length
                ? available.map(t => `\`${t.name}\``).join('、')
                : '（该论坛没有可用标签，请联系管理员检查论坛设置）';
            return { ok: false, error: `❌ <#${forum.id}> 要求每个帖子至少有一个标签。\n可用标签：${list}` };
        }
        return { ok: true, tagIds: [] };
    }

    const tagIds = [];
    const unknown = [];

    for (const token of raw) {
        const hit = available.find(t => t.id === token || t.name === token
            || t.name.toLowerCase() === token.toLowerCase());
        if (hit) {
            if (!tagIds.includes(hit.id)) tagIds.push(hit.id);
        } else {
            unknown.push(token);
        }
    }

    if (unknown.length > 0) {
        const list = available.length
            ? available.map(t => `\`${t.name}\``).join('、')
            : '（该论坛没有可用标签）';
        return { ok: false, error: `❌ 找不到标签：${unknown.map(t => `\`${t}\``).join('、')}\n可用标签：${list}` };
    }

    // Discord 限制一个帖子最多 5 个标签
    if (tagIds.length > 5) {
        return { ok: false, error: '❌ 一个帖子最多只能有 5 个标签。' };
    }

    return { ok: true, tagIds };
}

/**
 * 真正创建论坛帖，并把首楼记进历史
 *
 * @param {object} state 暂存的发帖参数
 * @param {object} messagePayload 首楼内容（content / embeds）
 */
async function createForumThread(interaction, forum, state, messagePayload, note = null) {
    const thread = await forum.threads.create({
        name: state.title,
        message: {
            ...messagePayload,
            allowedMentions: state.allowMentions ? ALLOW_MENTIONS : NO_MENTIONS,
        },
        appliedTags: state.tagIds || [],
        reason: `机器人消息模块发帖（操作人 ${interaction.user.tag}）`,
    });

    // 首楼消息就是本模块之后可以编辑的对象
    const starter = await thread.fetchStarterMessage().catch(() => null);

    if (starter) {
        try {
            insertHistory({
                guildId: starter.guildId,
                channelId: starter.channelId,
                messageId: starter.id,
                editorId: interaction.user.id,
                action: 'create_thread',
                beforeContent: null,
                beforeEmbeds: null,
                afterContent: starter.content || '',
                afterEmbeds: getRichEmbeds(starter).map(e => e.toJSON()),
            });
        } catch (error) {
            console.error('[BotMessage] 写发帖记录失败:', error);
        }

        await writeAuditLog(interaction, {
            action: 'create_thread',
            channelId: starter.channelId,
            messageId: starter.id,
            link: messageLink(starter),
            afterText: snapshotToText(snapshotMessage(starter)),
            note: [`论坛：<#${forum.id}>`, `标题：${state.title}`, note].filter(Boolean).join('\n'),
        });
    }

    console.log(`[BotMessage] ${interaction.user.tag} 在论坛 ${forum.id} 发布了帖子 ${thread.id}`);
    return { thread, starter };
}

/**
 * 发帖成功后的回执
 */
function buildForumSuccessReply(interaction, forum, thread, starter, state, extraNotes = []) {
    const lines = [
        `✅ 已在 <#${forum.id}> 发布帖子 <#${thread.id}>。`,
        `**标题：** ${state.title}`,
    ];

    if (state.tagIds?.length) {
        const names = (forum.availableTags || [])
            .filter(t => state.tagIds.includes(t.id))
            .map(t => `\`${t.name}\``);
        if (names.length) lines.push(`**标签：** ${names.join('、')}`);
    }

    lines.push(...extraNotes);

    if (starter) {
        lines.push(
            '',
            `首楼由机器人发出，之后可以直接用「右键消息 → 应用 → 编辑机器人消息」或 \`/机器人消息 编辑\` 修改。`,
            `[跳转到首楼](${messageLink(starter)})`,
        );
    } else {
        lines.push('', 'ℹ️ 帖子已建好，但没取到首楼消息对象（不影响使用，稍后仍可用消息链接编辑）。');
    }

    return lines.join('\n');
}

/**
 * 指令阶段：校验参数 → 存暂存态 → 弹窗 / 直接复制发帖
 */
async function startForumPost(interaction, forum, options) {
    const { title, tagsInput, allowMentions, mode, sourceInput } = options;

    const channelError = validateForumChannel(interaction, forum);
    if (channelError) return { ok: false, error: channelError };

    const trimmedTitle = (title || '').trim();
    if (!trimmedTitle) {
        return { ok: false, error: '❌ 帖子标题不能为空。' };
    }
    if (trimmedTitle.length > FORUM_TITLE_MAX) {
        return { ok: false, error: `❌ 帖子标题最长 ${FORUM_TITLE_MAX} 字，当前 ${trimmedTitle.length} 字。` };
    }

    const tagResult = resolveForumTags(forum, tagsInput);
    if (!tagResult.ok) return { ok: false, error: tagResult.error };

    return {
        ok: true,
        state: {
            forumId: forum.id,
            title: trimmedTitle,
            tagIds: tagResult.tagIds,
            allowMentions: Boolean(allowMentions),
            mode,
            sourceInput,
        },
    };
}

/**
 * 复制来源消息内容直接发帖（无需弹窗）
 */
async function createForumPostFromSource(interaction, forum, state) {
    const sourceResult = await fetchTargetMessage(interaction, state.sourceInput);
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

    if (content.length > LIMITS.CONTENT) {
        await interaction.editReply({ content: `❌ 来源消息正文 ${content.length} 字，超过 ${LIMITS.CONTENT} 字上限。` });
        return;
    }

    try {
        const { thread, starter } = await createForumThread(
            interaction,
            forum,
            state,
            { content: content || undefined, embeds },
            `来源消息：${messageLink(source)}`,
        );

        const notes = [];
        if (source.attachments.size > 0) {
            notes.push(`⚠️ 来源消息的 ${source.attachments.size} 个附件未被复制。`);
        }
        const mentionNote = formatMentionNotes(
            interaction, forum, content, state.allowMentions, !content && embeds.length > 0,
        );

        await interaction.editReply({
            content: buildForumSuccessReply(interaction, forum, thread, starter, state, notes) + mentionNote,
        });
    } catch (error) {
        console.error('[BotMessage] 复制发帖失败:', error);
        await interaction.editReply({ content: `❌ 发帖失败：${error.message || error}` });
    }
}

/**
 * 论坛帖首楼（纯文本）弹窗提交
 */
async function handleForumTextModalSubmit(interaction) {
    const session = await beginModalResponse(interaction);
    if (!session.ok) return;

    try {
        if (!await ensurePermission(interaction)) return;

        const [, key] = interaction.customId.split(':');
        const state = takeForumPost(key);
        if (!state) {
            await interaction.editReply({ content: '❌ 本次发帖会话已过期（超过 20 分钟），请重新执行 `/机器人消息 发帖`。' });
            return;
        }

        const forum = await interaction.guild.channels.fetch(state.forumId).catch(() => null);
        const channelError = validateForumChannel(interaction, forum);
        if (channelError) {
            await interaction.editReply({ content: channelError });
            return;
        }

        const content = interaction.fields.getTextInputValue('content');
        if (!content?.trim()) {
            await interaction.editReply({ content: '❌ 首楼正文不能为空。' });
            return;
        }

        const { thread, starter } = await createForumThread(interaction, forum, state, { content });
        await interaction.editReply({
            content: buildForumSuccessReply(interaction, forum, thread, starter, state)
                + formatMentionNotes(interaction, forum, content, state.allowMentions),
        });
    } catch (error) {
        console.error('[BotMessage] 论坛发帖失败:', error);
        await interaction.editReply({ content: `❌ 发帖失败：${error.message || error}` }).catch(() => {});
    } finally {
        await session.finish();
    }
}

/**
 * 论坛帖首楼（嵌入卡片）弹窗提交
 */
async function handleForumEmbedModalSubmit(interaction) {
    const session = await beginModalResponse(interaction);
    if (!session.ok) return;

    try {
        if (!await ensurePermission(interaction)) return;

        const [, key] = interaction.customId.split(':');
        const state = takeForumPost(key);
        if (!state) {
            await interaction.editReply({ content: '❌ 本次发帖会话已过期（超过 20 分钟），请重新执行 `/机器人消息 发帖`。' });
            return;
        }

        const forum = await interaction.guild.channels.fetch(state.forumId).catch(() => null);
        const channelError = validateForumChannel(interaction, forum);
        if (channelError) {
            await interaction.editReply({ content: channelError });
            return;
        }

        const built = buildEmbedFromFields(interaction);
        if (!built.ok) {
            await interaction.editReply({ content: built.error });
            return;
        }

        const { thread, starter } = await createForumThread(interaction, forum, state, { embeds: [built.embed] });
        await interaction.editReply({
            content: buildForumSuccessReply(interaction, forum, thread, starter, state)
                + formatMentionNotes(interaction, forum, null, state.allowMentions, true),
        });
    } catch (error) {
        console.error('[BotMessage] 论坛发帖（卡片）失败:', error);
        await interaction.editReply({ content: `❌ 发帖失败：${error.message || error}` }).catch(() => {});
    } finally {
        await session.finish();
    }
}

/**
 * 从模态窗口的 5 个字段构建一个新的嵌入卡片
 * @returns {{ok: true, embed: EmbedBuilder} | {ok: false, error: string}}
 */
function buildEmbedFromFields(interaction) {
    const title = interaction.fields.getTextInputValue('title')?.trim() || '';
    const description = interaction.fields.getTextInputValue('description') ?? '';
    const colorRaw = interaction.fields.getTextInputValue('color') ?? '';
    const footer = interaction.fields.getTextInputValue('footer')?.trim() || '';
    const image = interaction.fields.getTextInputValue('image')?.trim() || '';

    if (!title && !description && !image) {
        return { ok: false, error: '❌ 标题、描述、图片至少要填一项，否则卡片是空的。' };
    }

    const colorResult = parseColor(colorRaw);
    if (!colorResult.ok) return { ok: false, error: colorResult.error };

    if (image && !/^https?:\/\//i.test(image)) {
        return { ok: false, error: '❌ 图片链接必须以 `http://` 或 `https://` 开头。' };
    }

    const embed = new EmbedBuilder();
    if (title) embed.setTitle(title);
    if (description) embed.setDescription(description);
    if (colorResult.color !== null) embed.setColor(colorResult.color);
    if (footer) embed.setFooter({ text: footer });
    if (image) embed.setImage(image);

    return { ok: true, embed };
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
                allowedMentions: allowMentions ? ALLOW_MENTIONS : NO_MENTIONS,
            },
            `来源消息：${messageLink(source)}`,
        );

        const notes = [];
        if (source.attachments.size > 0) {
            notes.push(`⚠️ 来源消息的 ${source.attachments.size} 个附件未被复制。`);
        }

        await interaction.editReply({
            content: [`✅ 已在 <#${channel.id}> 发送消息。[点击查看](${messageLink(sent)})`, ...notes].join('\n')
                + formatMentionNotes(interaction, channel, content, allowMentions, !content && embeds.length > 0),
        });
    } catch (error) {
        console.error('[BotMessage] 复制发送失败:', error);
        await interaction.editReply({ content: `❌ 发送失败：${error.message || error}` });
    }
}

module.exports = {
    ACTION_LABELS,
    messageLink,
    safeRespond,
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
    resolveSendTarget,
    validateSendChannel,
    snapshotToText,

    // 论坛发帖
    startForumPost,
    stashForumPost,
    createForumPostFromSource,
    handleForumTextModalSubmit,
    handleForumEmbedModalSubmit,
    validateForumChannel,
};
