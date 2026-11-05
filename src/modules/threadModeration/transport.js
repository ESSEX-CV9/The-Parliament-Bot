const { REST, Routes } = require('discord.js');

function messageBody(payload) {
    return {
        embeds: payload.embeds?.map(embed => embed.toJSON ? embed.toJSON() : embed),
        allowed_mentions: { parse: [], replied_user: false },
        ...(payload.nonce ? { nonce: payload.nonce, enforce_nonce: true } : {}),
    };
}

// The bot's shared REST instance retries network errors/5xx/429 internally.
// Moderation writes must return control to the service before any retry so it
// can reauthorize and inspect state. Never change legacy client REST settings.
class Transport {
    static options(client, overrides = {}) {
        return { version: '10', timeout: client?.rest?.options?.timeout || 15000,
            ...overrides, retries: 0, rejectOnRateLimit: () => true };
    }

    constructor(client, { rest } = {}) {
        this.rest = rest || new REST(Transport.options(client)).setToken(client.token);
    }

    editThread(thread, { locked, archived, reason }) {
        // SDK ThreadChannel.edit also submits a cached name, which could undo
        // an unrelated rename. Only these two fields belong to this feature.
        return this.rest.patch(Routes.channel(thread.id), { body: { locked, archived }, reason });
    }

    send(thread, payload) {
        return this.rest.post(Routes.channelMessages(thread.id), { body: messageBody(payload) });
    }

    editMessage(op, message, payload) {
        return this.rest.patch(Routes.channelMessage(op.threadId, message.id), { body: messageBody(payload) });
    }

    deleteMessage(op, message) {
        return this.rest.delete(Routes.channelMessage(op.threadId, message.id));
    }

    close() {
        this.rest.clearHashSweeper();
        this.rest.clearHandlerSweeper();
    }
}

module.exports = { Transport };
