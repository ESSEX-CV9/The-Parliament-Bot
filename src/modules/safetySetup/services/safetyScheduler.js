const {
    MAX_INCIDENT_PAUSE_MS,
    RENEW_THRESHOLD_MS,
    calculatePauseUntil,
    pauseInvites,
    resumeInvites,
} = require('./incidentService');
const { withGuildOperationLock } = require('./guildOperationLock');

const RENEW_INTERVAL_MS = 30 * 60 * 1000;
const DUE_INTERVAL_MS = 60 * 1000;
const ALIGNMENT_TOLERANCE_MS = 1000;

async function fetchFreshGuild(client, guildId) {
    const guild = await client.guilds.fetch(guildId);
    if (!guild) throw new Error('Bot 不在该服务器中或无法访问服务器');
    return guild;
}

function getInvitePauseUntilMs(guild) {
    const value = guild.incidentsData?.invitesDisabledUntil;
    if (!value) return null;
    const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function createSafetyScheduler({
    client,
    store,
    now = () => Date.now(),
    logger = console,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
}) {
    let renewalRunning = false;
    let dueRunning = false;
    let renewalTimer = null;
    let dueTimer = null;

    async function runRenewalSweep() {
        if (renewalRunning) return false;
        renewalRunning = true;

        try {
            const nowMs = now();
            const records = store.listManagedGuilds();

            for (const record of records) {
                try {
                    await withGuildOperationLock(record.guild_id, async () => {
                        const currentRecord = store.getManagedGuild(record.guild_id);
                        if (!currentRecord) return;

                        const resumeAtMs = currentRecord.resume_at
                            ? Date.parse(currentRecord.resume_at)
                            : null;
                        if (resumeAtMs !== null &&
                            (!Number.isFinite(resumeAtMs) || resumeAtMs <= nowMs)) {
                            return;
                        }

                        const guild = await fetchFreshGuild(client, currentRecord.guild_id);
                        const currentUntilMs = getInvitePauseUntilMs(guild);
                        const targetUntil = calculatePauseUntil(nowMs, currentRecord.resume_at);
                        const targetUntilMs = targetUntil.getTime();
                        const scheduledInFinalWindow = resumeAtMs !== null &&
                            resumeAtMs <= nowMs + MAX_INCIDENT_PAUSE_MS;

                        let needsUpdate;
                        if (scheduledInFinalWindow) {
                            needsUpdate = currentUntilMs === null ||
                                Math.abs(currentUntilMs - targetUntilMs) > ALIGNMENT_TOLERANCE_MS;
                        } else {
                            needsUpdate = currentUntilMs === null ||
                                currentUntilMs <= nowMs ||
                                currentUntilMs - nowMs <= RENEW_THRESHOLD_MS;
                        }

                        if (!needsUpdate) return;
                        await pauseInvites(guild, { nowMs, resumeAt: currentRecord.resume_at });
                        logger.info?.(
                            `[SafetySetup] 已续期服务器 ${currentRecord.guild_id} 的邀请暂停至 ${targetUntil.toISOString()}`,
                        );
                    });
                } catch (error) {
                    logger.error?.(`[SafetySetup] 续期服务器 ${record.guild_id} 失败:`, error);
                }
            }
            return true;
        } catch (error) {
            logger.error?.('[SafetySetup] 读取托管服务器失败:', error);
            return false;
        } finally {
            renewalRunning = false;
        }
    }

    async function runDueSweep() {
        if (dueRunning) return false;
        dueRunning = true;

        try {
            const nowMs = now();
            const records = store.listDueManagedGuilds(new Date(nowMs).toISOString());

            for (const record of records) {
                try {
                    await withGuildOperationLock(record.guild_id, async () => {
                        const currentRecord = store.getManagedGuild(record.guild_id);
                        if (!currentRecord?.resume_at) return;
                        const resumeAtMs = Date.parse(currentRecord.resume_at);
                        if (!Number.isFinite(resumeAtMs) || resumeAtMs > nowMs) return;

                        const guild = await fetchFreshGuild(client, currentRecord.guild_id);
                        const currentUntilMs = getInvitePauseUntilMs(guild);
                        if (currentUntilMs !== null && currentUntilMs > nowMs) {
                            await resumeInvites(guild);
                        }

                        const removed = store.removeManagedGuildIfRevision(
                            currentRecord.guild_id,
                            currentRecord.revision,
                        );
                        if (removed) {
                            logger.info?.(`[SafetySetup] 服务器 ${currentRecord.guild_id} 已按预约恢复邀请`);
                        }
                    });
                } catch (error) {
                    logger.error?.(
                        `[SafetySetup] 恢复服务器 ${record.guild_id} 的邀请失败，将在下一轮重试:`,
                        error,
                    );
                }
            }
            return true;
        } catch (error) {
            logger.error?.('[SafetySetup] 读取到期预约失败:', error);
            return false;
        } finally {
            dueRunning = false;
        }
    }

    function start() {
        stop();
        void runDueSweep();
        void runRenewalSweep();
        dueTimer = setIntervalFn(() => void runDueSweep(), DUE_INTERVAL_MS);
        renewalTimer = setIntervalFn(() => void runRenewalSweep(), RENEW_INTERVAL_MS);
    }

    function stop() {
        if (dueTimer) clearIntervalFn(dueTimer);
        if (renewalTimer) clearIntervalFn(renewalTimer);
        dueTimer = null;
        renewalTimer = null;
    }

    return { start, stop, runRenewalSweep, runDueSweep };
}

let activeScheduler = null;

function startSafetyScheduler(client, store, options = {}) {
    if (activeScheduler) return activeScheduler;
    activeScheduler = createSafetyScheduler({ client, store, ...options });
    activeScheduler.start();
    return activeScheduler;
}

function stopSafetyScheduler() {
    if (activeScheduler) activeScheduler.stop();
    activeScheduler = null;
}

module.exports = {
    RENEW_INTERVAL_MS,
    DUE_INTERVAL_MS,
    createSafetyScheduler,
    startSafetyScheduler,
    stopSafetyScheduler,
};
