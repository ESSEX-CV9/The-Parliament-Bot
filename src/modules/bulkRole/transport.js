const { REST, Routes } = require('discord.js');

// Use the official singular role endpoints (idempotent PUT/DELETE, no member PATCH).
// A separate REST manager prevents hidden 429/5xx retries from bypassing our
// durable retry budget and fresh authorization checks, without changing client.rest.
class Transport {
    constructor(client, { makeRequest } = {}) {
        this.client = client;
        this.rest = new REST({
            version: '10', retries: 0, timeout: 15000,
            rejectOnRateLimit: () => true,
            ...(makeRequest ? { makeRequest } : {}),
        });
    }

    async change(job, userId) {
        this.rest.setToken(this.client.token);
        const route = Routes.guildMemberRole(job.guildId, userId, job.roleId);
        const options = { reason: `BulkRole task=${job.id} actor=${job.actorId} action=${job.action}` };
        if (job.action === 'add') await this.rest.put(route, options);
        else if (job.action === 'remove') await this.rest.delete(route, options);
        else throw new Error('无效批量身份组操作。');
    }

    close() { this.rest.clearHashSweeper(); this.rest.clearHandlerSweeper(); }
}
module.exports = { Transport };
