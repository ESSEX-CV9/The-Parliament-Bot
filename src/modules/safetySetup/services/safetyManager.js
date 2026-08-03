const { pauseInvites, resumeInvites } = require('./incidentService');
const { withGuildOperationLock } = require('./guildOperationLock');

function resolveStore(store) {
    return store || require('../utils/safetyDatabase');
}

async function closeManagedGuild({
    guild,
    guildId,
    enabledBy,
    resumeAt = null,
    nowMs = Date.now(),
    now = () => Date.now(),
    store = null,
}) {
    const operationStartedAtMs = now();
    return withGuildOperationLock(guildId, async () => {
        const persistence = resolveStore(store);
        const operationGuild = typeof guild.fetch === 'function'
            ? await guild.fetch()
            : guild;
        const previousPauseValue = operationGuild.incidentsData?.invitesDisabledUntil;
        const previousPauseMs = previousPauseValue instanceof Date
            ? previousPauseValue.getTime()
            : Date.parse(previousPauseValue);
        const invitesDisabledUntil = await pauseInvites(operationGuild, { nowMs, resumeAt });

        try {
            persistence.upsertManagedGuild({
                guildId,
                resumeAt: resumeAt || null,
                enabledBy,
                nowIso: new Date(nowMs).toISOString(),
            });
        } catch (persistenceError) {
            try {
                const elapsedMs = Math.max(0, now() - operationStartedAtMs);
                const rollbackNowMs = nowMs + elapsedMs;
                if (Number.isFinite(previousPauseMs) && previousPauseMs > rollbackNowMs) {
                    await operationGuild.setIncidentActions({
                        invitesDisabledUntil: new Date(previousPauseMs),
                    });
                } else {
                    await resumeInvites(operationGuild);
                }
            } catch (rollbackError) {
                throw new Error(
                    `保存托管状态失败，且无法恢复之前的邀请状态：${persistenceError.message}；` +
                    `恢复失败：${rollbackError.message}`,
                    { cause: persistenceError },
                );
            }
            throw persistenceError;
        }

        return invitesDisabledUntil;
    });
}

async function openManagedGuild({ guild, guildId, store = null }) {
    return withGuildOperationLock(guildId, async () => {
        const persistence = resolveStore(store);
        const record = persistence.getManagedGuild(guildId);
        if (!record) return { managed: false };

        const removed = persistence.removeManagedGuildIfRevision(guildId, record.revision);
        if (!removed) return { managed: false };

        await resumeInvites(guild);
        return { managed: true };
    });
}

async function disableManagedGuild({ guildId, store = null }) {
    return withGuildOperationLock(guildId, async () => {
        const persistence = resolveStore(store);
        const record = persistence.getManagedGuild(guildId);
        if (!record) return { managed: false };
        const removed = persistence.removeManagedGuildIfRevision(guildId, record.revision);
        return { managed: removed };
    });
}

module.exports = {
    closeManagedGuild,
    openManagedGuild,
    disableManagedGuild,
};
