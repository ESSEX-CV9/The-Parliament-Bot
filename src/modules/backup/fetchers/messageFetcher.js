const config = require('../config');

function serializeMessage(msg) {
  return {
    id: msg.id,
    author: {
      id: msg.author.id,
      username: msg.author.username,
      discriminator: msg.author.discriminator,
      bot: msg.author.bot,
      avatar: msg.author.avatar,
      nickname: msg.member?.nickname ?? null,
    },
    content: msg.content,
    timestamp: msg.createdAt.toISOString(),
    editedTimestamp: msg.editedAt ? msg.editedAt.toISOString() : null,
    attachments: msg.attachments.map(a => ({
      id: a.id,
      filename: a.name,
      url: a.url,
      size: a.size,
      contentType: a.contentType,
    })),
    embeds: msg.embeds.map(e => e.toJSON()),
    pinned: msg.pinned,
    type: msg.type,
    flags: msg.flags?.bitfield ?? 0,
    reference: msg.reference ? {
      messageId: msg.reference.messageId ?? null,
      channelId: msg.reference.channelId,
      guildId: msg.reference.guildId ?? null,
    } : null,
    stickers: msg.stickers.map(s => ({ id: s.id, name: s.name })),
    components: msg.components.map(row => row.toJSON()),
    webhookId: msg.webhookId ?? null,
  };
}

async function fetchAllMessages(channel, onBatch) {
  let lastId = null;
  let totalFetched = 0;

  while (true) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;

    let messages;
    try {
      messages = await channel.messages.fetch(options);
    } catch (err) {
      if (err.status === 429) {
        const retryAfter = err.retryAfter || 5000;
        await sleep(retryAfter + Math.random() * 1000);
        continue;
      }
      throw err;
    }

    if (messages.size === 0) break;

    const batch = [...messages.values()].map(serializeMessage);
    totalFetched += batch.length;

    if (onBatch) await onBatch(batch, totalFetched);

    lastId = messages.last().id;
    await sleep(config.messageFetchDelay);
  }

  return totalFetched;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { fetchAllMessages };
