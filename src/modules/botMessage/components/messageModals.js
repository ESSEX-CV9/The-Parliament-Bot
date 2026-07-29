// src/modules/botMessage/components/messageModals.js
const {
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
} = require('discord.js');

const { getRichEmbeds } = require('../utils/messageResolver');

// Discord 侧的硬性上限
const LIMITS = {
    CONTENT: 2000,
    EMBED_TITLE: 256,
    EMBED_DESCRIPTION: 4096,
    EMBED_FOOTER: 2048,
    // 模态窗口单个输入框最多 4000 字符，比 embed 描述上限（4096）略小
    MODAL_INPUT: 4000,
};

// customId 前缀（interactionCreate 依据这些前缀路由）
const IDS = {
    MODAL_EDIT_CONTENT: 'botmsg_m_content',
    MODAL_EDIT_EMBED: 'botmsg_m_embed',
    MODAL_SEND_TEXT: 'botmsg_m_send_text',
    MODAL_SEND_EMBED: 'botmsg_m_send_embed',
    BTN_PICK_CONTENT: 'botmsg_b_content',
    BTN_PICK_EMBED: 'botmsg_b_embed',
    BTN_CANCEL: 'botmsg_b_cancel',
};

function row(input) {
    return new ActionRowBuilder().addComponents(input);
}

/**
 * 把 embed 的整数颜色转成 #RRGGBB 文本
 */
function colorToHex(color) {
    if (color === null || color === undefined) return '';
    const num = Number(color);
    if (!Number.isFinite(num) || num < 0) return '';
    return `#${num.toString(16).padStart(6, '0').toUpperCase()}`;
}

/**
 * 解析用户填写的颜色
 * @returns {{ok: true, color: number|null} | {ok: false, error: string}}
 */
function parseColor(input) {
    const text = (input || '').trim();
    if (!text) return { ok: true, color: null };

    const hex = text.replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
        return { ok: true, color: parseInt(hex, 16) };
    }
    if (/^[0-9a-fA-F]{3}$/.test(hex)) {
        const expanded = hex.split('').map(c => c + c).join('');
        return { ok: true, color: parseInt(expanded, 16) };
    }
    if (/^\d+$/.test(text)) {
        const num = parseInt(text, 10);
        if (num >= 0 && num <= 0xffffff) {
            return { ok: true, color: num };
        }
    }

    return { ok: false, error: '❌ 颜色格式不正确，请填写十六进制色值（如 `#5865F2`）或留空。' };
}

/**
 * 编辑「消息正文」的模态窗口
 * @param {import('discord.js').Message} message
 */
function buildContentModal(message) {
    const modal = new ModalBuilder()
        .setCustomId(`${IDS.MODAL_EDIT_CONTENT}:${message.channelId}:${message.id}`)
        .setTitle('编辑机器人消息正文');

    const input = new TextInputBuilder()
        .setCustomId('content')
        .setLabel('消息正文')
        .setPlaceholder('直接修改下面的文本，支持 Markdown。留空表示清空正文。')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(LIMITS.CONTENT)
        .setRequired(false)
        .setValue(message.content || '');

    modal.addComponents(row(input));
    return modal;
}

/**
 * 编辑 / 新增「嵌入卡片」的模态窗口
 *
 * @param {import('discord.js').Message} message
 * @param {number|'new'} index embed 下标，'new' 表示新增
 * @returns {{ok: true, modal: ModalBuilder} | {ok: false, error: string}}
 */
function buildEmbedModal(message, index) {
    const isNew = index === 'new';
    const embed = isNew ? null : getRichEmbeds(message)[index]?.toJSON();

    if (!isNew && !embed) {
        return { ok: false, error: '❌ 找不到对应的嵌入卡片，消息可能已被改动，请重新执行指令。' };
    }

    const description = embed?.description || '';
    if (description.length > LIMITS.MODAL_INPUT) {
        return {
            ok: false,
            error: [
                `❌ 该嵌入卡片的描述有 ${description.length} 字，超过模态窗口 ${LIMITS.MODAL_INPUT} 字的上限，无法在弹窗里编辑。`,
                '',
                '请改用：`/机器人消息 替换 目标消息:<链接> 来源消息:<草稿消息链接>`（先在任意频道写好草稿消息，再整体替换）。',
            ].join('\n'),
        };
    }

    const modal = new ModalBuilder()
        .setCustomId(`${IDS.MODAL_EDIT_EMBED}:${message.channelId}:${message.id}:${isNew ? 'new' : index}`)
        .setTitle(isNew ? '新增嵌入卡片' : `编辑嵌入卡片 #${index + 1}`);

    modal.addComponents(
        row(new TextInputBuilder()
            .setCustomId('title')
            .setLabel('标题')
            .setPlaceholder('留空表示不显示标题')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(LIMITS.EMBED_TITLE)
            .setRequired(false)
            .setValue(embed?.title || '')),
        row(new TextInputBuilder()
            .setCustomId('description')
            .setLabel('描述正文')
            .setPlaceholder('卡片的主体文字，支持 Markdown')
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(LIMITS.MODAL_INPUT)
            .setRequired(false)
            .setValue(description)),
        row(new TextInputBuilder()
            .setCustomId('color')
            .setLabel('左侧色条（如 #5865F2）')
            .setPlaceholder('留空表示不设置颜色')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(20)
            .setRequired(false)
            .setValue(colorToHex(embed?.color))),
        row(new TextInputBuilder()
            .setCustomId('footer')
            .setLabel('页脚文字')
            .setPlaceholder('留空表示不显示页脚')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(LIMITS.EMBED_FOOTER)
            .setRequired(false)
            .setValue(embed?.footer?.text || '')),
        row(new TextInputBuilder()
            .setCustomId('image')
            .setLabel('大图链接（标题/描述/图片全空=删除本卡片）')
            .setPlaceholder('https://... 留空表示不显示图片')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(1024)
            .setRequired(false)
            .setValue(embed?.image?.url || '')),
    );

    return { ok: true, modal };
}

/**
 * 发送新的纯文本消息的模态窗口
 * @param {string} channelId 目标频道
 * @param {boolean} allowMentions 是否允许触发提及
 */
function buildSendTextModal(channelId, allowMentions) {
    const modal = new ModalBuilder()
        .setCustomId(`${IDS.MODAL_SEND_TEXT}:${channelId}:${allowMentions ? '1' : '0'}`)
        .setTitle('用机器人发送消息');

    modal.addComponents(row(new TextInputBuilder()
        .setCustomId('content')
        .setLabel('消息正文')
        // 弹窗输入框没有 @ 自动补全，直接打「@名字」只是普通文字，不会 ping 到人
        .setPlaceholder('支持 Markdown。提及要写成 <@用户ID> 或 <@&身份组ID>，最多 2000 字')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(LIMITS.CONTENT)
        .setRequired(true)));

    return modal;
}

/**
 * 发送新的嵌入卡片消息的模态窗口
 */
function buildSendEmbedModal(channelId, allowMentions) {
    const modal = new ModalBuilder()
        .setCustomId(`${IDS.MODAL_SEND_EMBED}:${channelId}:${allowMentions ? '1' : '0'}`)
        .setTitle('用机器人发送嵌入卡片');

    modal.addComponents(
        row(new TextInputBuilder()
            .setCustomId('title')
            .setLabel('标题')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(LIMITS.EMBED_TITLE)
            .setRequired(false)),
        row(new TextInputBuilder()
            .setCustomId('description')
            .setLabel('描述正文')
            .setPlaceholder('卡片的主体文字，支持 Markdown')
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(LIMITS.MODAL_INPUT)
            .setRequired(false)),
        row(new TextInputBuilder()
            .setCustomId('color')
            .setLabel('左侧色条（如 #5865F2）')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(20)
            .setRequired(false)),
        row(new TextInputBuilder()
            .setCustomId('footer')
            .setLabel('页脚文字')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(LIMITS.EMBED_FOOTER)
            .setRequired(false)),
        row(new TextInputBuilder()
            .setCustomId('image')
            .setLabel('大图链接')
            .setPlaceholder('https://...')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(1024)
            .setRequired(false)),
    );

    return modal;
}

module.exports = {
    LIMITS,
    IDS,
    colorToHex,
    parseColor,
    buildContentModal,
    buildEmbedModal,
    buildSendTextModal,
    buildSendEmbedModal,
};
