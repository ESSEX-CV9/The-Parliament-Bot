const MAX_TIMER_MS = 2 ** 31 - 1;

function lockKey(guildId, userId) {
    return `${guildId}:${userId}`;
}

function createMysteryNicknameLockService({
    store,
    now = Date.now,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
}) {
    let clientRef = null;
    const timers = new Map();
    const operationTails = new Map();
    let mutationQueue = Promise.resolve();

    function logFailure(operation, error) {
        console.error(`[mysteryNicknameLockService] ${operation} failed:`, error);
    }

    function enqueue(guildId, userId, operation) {
        const key = lockKey(guildId, userId);
        const previous = operationTails.get(key) || Promise.resolve();
        const next = previous.catch(() => undefined).then(operation);
        operationTails.set(key, next);
        return next.finally(() => {
            if (operationTails.get(key) === next) operationTails.delete(key);
        });
    }

    function enqueueMutation(operation) {
        const next = mutationQueue.catch(() => undefined).then(operation);
        mutationQueue = next;
        return next;
    }

    function serializeMutation(guildId, userId, operation) {
        return enqueueMutation(() => enqueue(guildId, userId, operation));
    }

    function clearTimer(guildId, userId) {
        const key = lockKey(guildId, userId);
        const entry = timers.get(key);
        if (entry !== undefined) {
            clearTimeoutImpl(entry.handle);
            timers.delete(key);
        }
    }

    // 每个 key 只保留一个 timer；schedule 用 generation 标记当前 timer。
    // 旧 timer callback 若已进入 event loop（clearTimeout 无法取消），
    // 触发时通过 generation 比对安全 no-op，绝不误释放更新后的 lock。
    function schedule(record) {
        const key = lockKey(record.guildId, record.userId);
        const previous = timers.get(key);
        const generation = (previous?.generation ?? 0) + 1;
        if (previous) clearTimeoutImpl(previous.handle);
        const delay = Math.max(0, Math.min(MAX_TIMER_MS, record.expiresAt - now()));
        const handle = setTimeoutImpl(() => {
            const current = timers.get(key);
            if (!current || current.generation !== generation) return false;
            timers.delete(key);
            return serializeMutation(record.guildId, record.userId, async () => {
                const active = store.get(record.guildId, record.userId);
                if (!active) return false;
                if (now() < active.expiresAt) {
                    schedule(active);
                    return false;
                }
                return releaseLockInternal(active);
            }).catch(error => logFailure('nickname lock timer failed', error));
        }, delay);
        handle?.unref?.();
        timers.set(key, { handle, generation });
    }

    function managementFailure(member) {
        if (!member?.guild?.members?.me?.permissions?.has?.('ManageNicknames')) {
            return 'missing_permission';
        }
        if (member.manageable !== true) return 'not_manageable';
        return null;
    }

    async function fetchGuild(guildId) {
        if (!clientRef?.guilds) return null;
        const cached = clientRef.guilds.cache?.get?.(guildId);
        if (cached) return cached;
        try {
            return await clientRef.guilds.fetch?.(guildId);
        } catch (error) {
            return null;
        }
    }

    async function fetchMember(guildId, userId) {
        const guild = await fetchGuild(guildId);
        if (!guild?.members) return null;
        const cached = guild.members.cache?.get?.(userId);
        if (cached) return cached;
        try {
            return await guild.members.fetch?.(userId);
        } catch (error) {
            return null;
        }
    }

    async function restoreNickname(record, member) {
        const target = member || await fetchMember(record.guildId, record.userId);
        if (!target || target.nickname !== record.enforcedNickname) return false;
        if (managementFailure(target)) return false;
        try {
            await target.setNickname(record.originalNickname ?? null, record.restoreReason);
            return true;
        } catch (error) {
            logFailure('restoring nickname', error);
            return false;
        }
    }

    async function releaseLockInternal(record, member) {
        clearTimer(record.guildId, record.userId);
        try {
            if (!await store.remove(record.guildId, record.userId)) return false;
        } catch (error) {
            schedule(record);
            throw error;
        }
        await restoreNickname(record, member);
        return true;
    }

    function hasLock(guildId, userId) {
        if (typeof guildId === 'object') {
            userId = guildId?.id;
            guildId = guildId?.guild?.id;
        }
        return Boolean(guildId && userId && store.get(guildId, userId));
    }

    async function createLock({
        member,
        type,
        enforcedNickname,
        expiresAt,
        originalNickname,
        applyReason,
        restoreReason,
        enforceReason,
        channelId,
    }) {
        const guildId = member?.guild?.id;
        const userId = member?.id;
        if (!guildId || !userId || typeof type !== 'string' || !type || typeof enforcedNickname !== 'string' || !enforcedNickname || !Number.isFinite(expiresAt)) {
            return { created: false, reason: 'invalid_lock' };
        }

        return serializeMutation(guildId, userId, async () => {
            if (hasLock(guildId, userId)) return { created: false, reason: 'existing_lock' };

            const failure = managementFailure(member);
            if (failure) return { created: false, reason: failure };

            const previousNickname = member.nickname ?? null;
            try {
                await member.setNickname(enforcedNickname, applyReason);
            } catch (error) {
                logFailure('applying nickname lock', error);
                return { created: false, reason: 'nickname_update_failed' };
            }

            const record = {
                guildId,
                userId,
                type,
                originalNickname: originalNickname ?? previousNickname,
                enforcedNickname,
                expiresAt,
                applyReason,
                restoreReason,
                enforceReason,
                ...(channelId ? { channelId } : {}),
            };

            let created;
            try {
                created = await store.create(record);
            } catch (error) {
                logFailure('persisting nickname lock', error);
                await compensateCreateFailure({ member, record, previousNickname });
                return { created: false, reason: 'persistence_failed' };
            }
            if (!created) {
                const winningRecord = await compensateCreateFailure({ member, record, previousNickname });
                return { created: false, reason: winningRecord ? 'existing_lock' : 'persistence_failed' };
            }
            schedule(record);
            return { created: true, record: { ...record } };
        });
    }

    async function compensateCreateFailure({ member, record, previousNickname }) {
        const winningRecord = store.get(record.guildId, record.userId);
        const nickname = winningRecord?.enforcedNickname ?? previousNickname;
        if (member.nickname === nickname) return winningRecord;
        try {
            await member.setNickname(nickname, winningRecord?.enforceReason ?? record.restoreReason);
        } catch (error) {
            logFailure('compensating failed nickname lock', error);
        }
        return winningRecord;
    }

    async function releaseLock(guildId, userId, member) {
        if (typeof guildId === 'object') {
            member = guildId.member;
            userId = guildId.userId;
            guildId = guildId.guildId;
        }
        if (!guildId || !userId) return false;
        return serializeMutation(guildId, userId, async () => {
            const record = store.get(guildId, userId);
            if (!record) return false;
            return releaseLockInternal(record, member);
        });
    }

    // durable serialized update：在全局 + per-key 串行边界内读取当前 record、
    // 应用受限 updater、durable write 成功后才替换 timer；失败保持旧状态。
    async function updateLock(guildId, userId, updater) {
        if (!guildId || !userId || typeof updater !== 'function') {
            return { updated: false, reason: 'invalid' };
        }
        return serializeMutation(guildId, userId, async () => {
            const current = store.get(guildId, userId);
            if (!current) return { updated: false, reason: 'not_found' };

            let stored;
            try {
                stored = await store.update(guildId, userId, updater);
            } catch (error) {
                logFailure('updating nickname lock', error);
                if (
                    String(error?.message || '').startsWith('immutable lock field changed')
                    || error?.message === 'invalid updated lock record'
                ) {
                    return { updated: false, reason: 'invalid' };
                }
                return { updated: false, reason: 'persistence_failed' };
            }
            if (!stored) return { updated: false, reason: 'not_found' };

            schedule(stored);
            return { updated: true, record: { ...stored } };
        });
    }

    async function handleGuildMemberUpdate(oldMember, newMember) {
        const guildId = newMember?.guild?.id;
        const userId = newMember?.id;
        if (!guildId || !userId || oldMember?.nickname === newMember?.nickname) return false;

        return serializeMutation(guildId, userId, async () => {
            const record = store.get(guildId, userId);
            if (!record) return false;
            if (now() >= record.expiresAt) return releaseLockInternal(record, newMember);
            if (newMember.nickname === record.enforcedNickname) return false;
            if (managementFailure(newMember)) return false;
            try {
                await newMember.setNickname(record.enforcedNickname, record.enforceReason);
                return true;
            } catch (error) {
                logFailure('re-enforcing nickname lock', error);
                return false;
            }
        });
    }

    async function handleGuildMemberRemove(member) {
        const guildId = member?.guild?.id;
        const userId = member?.id;
        if (!guildId || !userId) return false;
        return serializeMutation(guildId, userId, async () => {
            const record = store.get(guildId, userId);
            if (!record) return false;
            clearTimer(guildId, userId);
            return store.remove(guildId, userId);
        });
    }

    async function initialize(client) {
        return enqueueMutation(async () => {
            clientRef = client || clientRef;
            const records = await store.load();
            await Promise.all(records.map(record => enqueue(record.guildId, record.userId, async () => {
                const active = store.get(record.guildId, record.userId);
                if (!active) return false;
                if (now() >= active.expiresAt) return releaseLockInternal(active);

                schedule(active);
                const member = await fetchMember(active.guildId, active.userId);
                if (!member || member.nickname === active.enforcedNickname || managementFailure(member)) return true;
                try {
                    await member.setNickname(active.enforcedNickname, active.enforceReason);
                } catch (error) {
                    logFailure('restoring active nickname lock', error);
                }
                return true;
            })));
        });
    }

    function resetForTests() {
        for (const entry of timers.values()) clearTimeoutImpl(entry.handle);
        timers.clear();
        operationTails.clear();
        mutationQueue = Promise.resolve();
        clientRef = null;
    }

    return {
        initialize,
        hasLock,
        createLock,
        releaseLock,
        updateLock,
        handleGuildMemberUpdate,
        handleGuildMemberRemove,
        resetForTests,
    };
}

module.exports = { createMysteryNicknameLockService };
