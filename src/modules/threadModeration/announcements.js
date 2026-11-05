const { EmbedBuilder } = require('discord.js');

const MENTIONS = { parse: [], repliedUser: false };
const marker = op => `thread-moderation:${op.id}`;

function announcementPayload(op, failure = null) {
    const lock = op.action === 'lock';
    const embed = new EmbedBuilder()
        .setColor(failure ? 0xe6a23c : lock ? 0xe74c3c : 0x2ecc71)
        .setTitle(failure ? '⚠️ 子区操作未完成' : lock ? '🔒 子区已锁定' : '🔓 子区已解锁')
        .setDescription([
            lock ? `锁帖原因：${op.reason}` : '',
            `操作人：<@${op.actorId}>`,
            `操作时间：<t:${Math.floor(op.createdAt / 1000)}:F>`,
            '',
            failure || (lock ? '该子区已锁定并归档，普通成员无法继续回复。' : '该子区已解除锁定，可以继续正常交流。'),
        ].filter(line => line !== '').join('\n'))
        .setFooter({ text: marker(op) });
    return { embeds: [embed], allowedMentions: MENTIONS };
}

function matches(message, op, botId) {
    return message?.author?.id === botId && message.embeds?.some(embed => embed.footer?.text === marker(op));
}

// Never resend a message whose POST outcome is unknown. Locate by persisted ID
// or the unique operation footer, including messages beyond the first page.
async function findAnnouncement(thread, op, botId) {
    if (!op.sendAttempted && !op.messageId) return { message: null, complete: true };
    if (op.messageId) {
        try {
            const message = await thread.messages.fetch({ message: op.messageId, force: true });
            if (!matches(message, op, botId)) return { message: null, complete: false };
            return { message, complete: true };
        } catch (error) {
            if (error.code === 10008) return { message: null, complete: true };
            throw error;
        }
    }
    let before;
    for (let page = 0; page < 20; page++) {
        const messages = await thread.messages.fetch({ limit: 100, before, cache: false });
        const found = messages.find(message => matches(message, op, botId));
        if (found) return { message: found, complete: true };
        const oldest = messages.last();
        if (messages.size < 100 || oldest?.createdTimestamp < op.createdAt - 5000) return { message: null, complete: true };
        if (!oldest || oldest.id === before) return { message: null, complete: false };
        before = oldest.id;
    }
    return { message: null, complete: false };
}

async function correctAnnouncement(message, op, state, transport, fence) {
    if (!message) return true;
    const payload = announcementPayload(op, `本次操作未完成。核验时状态：${state.locked ? '锁定' : '未锁定'}、${state.archived ? '已归档' : '未归档'}。请以帖子当前实际状态为准。`);
    try { fence(); await transport.editMessage(op, message, payload); return true; }
    catch (_) {
        try { fence(); await transport.deleteMessage(op, message); return true; }
        catch (error) { return error.code === 10008; }
    }
}

module.exports = { MENTIONS, marker, announcementPayload, findAnnouncement, correctAnnouncement };
