// src/modules/channelArchive/services/webhookTransport.js
const { WEBHOOK_NAME, WEBHOOK_SENDER_NAME, WEBHOOK_SEND_INTERVAL_MS } = require('../utils/constants');
const { sleep } = require('../utils/text');

function retryAfterMs(error) {
    const value = error?.retryAfter
        ?? error?.rawError?.retry_after
        ?? error?.rawError?.retryAfter
        ?? null;
    return value == null ? null : Number(value) * 1000;
}

class WebhookTransport {
    constructor(forumChannel, { intervalMs = WEBHOOK_SEND_INTERVAL_MS } = {}) {
        this.channel = forumChannel;
        this.intervalMs = intervalMs;
        this.webhook = null;
        this.nextAt = 0;
    }

    async initialize() {
        if (this.webhook) return this.webhook;
        const hooks = await this.channel.fetchWebhooks();
        const existing = hooks.find(hook => hook.name === WEBHOOK_NAME && hook.token);
        this.webhook = existing || await this.channel.createWebhook({
            name: WEBHOOK_NAME,
            reason: '频道归档拟态还原',
        });
        return this.webhook;
    }

    async waitTurn() {
        const now = Date.now();
        const waitMs = Math.max(0, this.nextAt - now);
        this.nextAt = Math.max(now, this.nextAt) + this.intervalMs;
        if (waitMs > 0) await sleep(waitMs);
    }

    async send(threadId, payload) {
        await this.initialize();
        await this.waitTurn();

        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                return await this.webhook.send({
                    ...payload,
                    threadId,
                    allowedMentions: { parse: [], repliedUser: false },
                });
            } catch (error) {
                lastError = error;
                const retry = retryAfterMs(error);
                if (retry != null) {
                    await sleep(retry + 300);
                } else {
                    await sleep(1200 * (attempt + 1));
                }
            }
        }
        throw lastError;
    }

    async sendSystem(threadId, content) {
        return this.send(threadId, {
            content,
            username: WEBHOOK_SENDER_NAME,
        });
    }
}

module.exports = {
    WebhookTransport,
};
