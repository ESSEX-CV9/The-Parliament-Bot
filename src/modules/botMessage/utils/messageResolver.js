// src/modules/botMessage/utils/messageResolver.js
const { PermissionFlagsBits } = require('discord.js');

const MESSAGE_LINK_PATTERN = /(?:https?:\/\/)?(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d{17,20}|@me)\/(\d{17,20})\/(\d{17,20})/;
const CHANNEL_MESSAGE_ID_PATTERN = /^(\d{17,20})[-_](\d{17,20})$/;
const RAW_ID_PATTERN = /^(\d{17,20})$/;

/**
 * 解析用户输入的消息定位信息
 *
 * 支持三种写法：
 * - 完整消息链接 https://discord.com/channels/<guild>/<channel>/<message>
 * - 客户端「复制消息ID」得到的 <channelId>-<messageId>
 * - 纯消息ID（默认在当前频道查找）
 *
 * @param {string} input 用户输入
 * @param {string} fallbackChannelId 当输入不含频道信息时使用的频道ID
 * @returns {{guildId: string|null, channelId: string, messageId: string}|null}
 */
function parseMessageReference(input, fallbackChannelId = null) {
    if (!input || typeof input !== 'string') return null;
    const text = input.trim();
    if (!text) return null;

    const linkMatch = text.match(MESSAGE_LINK_PATTERN);
    if (linkMatch) {
        const [, guildId, channelId, messageId] = linkMatch;
        return {
            guildId: guildId === '@me' ? null : guildId,
            channelId,
            messageId,
        };
    }

    const pairMatch = text.match(CHANNEL_MESSAGE_ID_PATTERN);
    if (pairMatch) {
        return { guildId: null, channelId: pairMatch[1], messageId: pairMatch[2] };
    }

    const rawMatch = text.match(RAW_ID_PATTERN);
    if (rawMatch && fallbackChannelId) {
        return { guildId: null, channelId: fallbackChannelId, messageId: rawMatch[1] };
    }

    return null;
}

/**
 * 根据用户输入拉取消息，并做服务器/频道可见性校验
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {string} input 消息链接 / ID
 * @param {object} [options]
 * @param {boolean} [options.requireEditable] 是否要求该消息可被本机器人编辑
 * @returns {Promise<{ok: boolean, message?: import('discord.js').Message, error?: string}>}
 */
async function fetchTargetMessage(interaction, input, options = {}) {
    const { requireEditable = false } = options;

    const ref = parseMessageReference(input, interaction.channelId);
    if (!ref) {
        return {
            ok: false,
            error: [
                '❌ 无法识别消息定位信息。',
                '',
                '**支持的填写方式：**',
                '• 消息链接：`https://discord.com/channels/服务器ID/频道ID/消息ID`（右键消息 → 复制消息链接）',
                '• `频道ID-消息ID`（开启开发者模式后右键消息 → 复制消息ID）',
                '• 纯消息ID（会在当前频道查找）',
            ].join('\n'),
        };
    }

    if (ref.guildId && ref.guildId !== interaction.guild.id) {
        return { ok: false, error: '❌ 这条消息不在本服务器，出于安全考虑不允许跨服务器操作。' };
    }

    let channel;
    try {
        channel = await interaction.guild.channels.fetch(ref.channelId);
    } catch (_) {
        channel = null;
    }

    if (!channel) {
        return { ok: false, error: `❌ 找不到频道 \`${ref.channelId}\`，或机器人没有权限访问它。` };
    }

    if (!channel.isTextBased?.()) {
        return { ok: false, error: '❌ 目标频道不是文字频道。' };
    }

    // 防止越权：操作者必须自己能看到该频道
    try {
        const memberPerms = channel.permissionsFor(interaction.member);
        if (!memberPerms || !memberPerms.has(PermissionFlagsBits.ViewChannel)) {
            return { ok: false, error: `❌ 你没有查看 <#${channel.id}> 的权限，不能操作该频道内的消息。` };
        }
    } catch (error) {
        console.error('[BotMessage] 校验操作者频道权限时出错:', error);
    }

    let message;
    try {
        message = await channel.messages.fetch(ref.messageId);
    } catch (error) {
        return {
            ok: false,
            error: `❌ 在 <#${channel.id}> 里找不到消息 \`${ref.messageId}\`（可能已被删除，或链接里的频道不对）。`,
        };
    }

    if (requireEditable) {
        const botId = interaction.client.user.id;
        if (message.author?.id !== botId) {
            return {
                ok: false,
                error: [
                    `❌ 这条消息不是由本机器人（<@${botId}>）发出的，无法编辑。`,
                    '',
                    'Discord 只允许机器人编辑自己发出的消息。若消息由其他机器人 / Webhook / 用户发出，只能由对方修改。',
                ].join('\n'),
            };
        }

        if (!message.editable) {
            return {
                ok: false,
                error: '❌ 这条消息当前不可编辑（常见原因：所在子区已归档或被锁定，请先解除归档/锁定后重试）。',
            };
        }
    }

    return { ok: true, message };
}

/**
 * 取出消息里「机器人自己发的嵌入卡片」
 *
 * 消息正文含链接时，Discord 会自动生成预览 embed（type 为 link/image/video/article 等），
 * 它同样出现在 message.embeds 里。这类预览由 Discord 依据正文实时生成，
 * 既不该给管理员编辑，也不能在 edit 时回写（否则会被固化成真正的卡片）。
 *
 * @param {import('discord.js').Message} message
 * @returns {import('discord.js').Embed[]} 仅包含 rich 类型的卡片
 */
function getRichEmbeds(message) {
    return (message.embeds || []).filter(embed => {
        const type = embed?.data?.type;
        return !type || type === 'rich';
    });
}

/**
 * 统计消息里由 Discord 自动生成的链接预览数量
 */
function countAutoEmbeds(message) {
    return (message.embeds || []).length - getRichEmbeds(message).length;
}

/**
 * 生成消息内容快照（用于历史记录与撤销）
 * @param {import('discord.js').Message} message
 */
function snapshotMessage(message) {
    return {
        content: message.content ?? '',
        embeds: getRichEmbeds(message).map(embed => embed.toJSON()),
    };
}

/**
 * 截断文本用于日志/预览展示
 */
function truncate(text, max = 1000) {
    if (!text) return '';
    const str = String(text);
    if (str.length <= max) return str;
    return `${str.slice(0, max - 3)}...`;
}

module.exports = {
    parseMessageReference,
    fetchTargetMessage,
    getRichEmbeds,
    countAutoEmbeds,
    snapshotMessage,
    truncate,
};
