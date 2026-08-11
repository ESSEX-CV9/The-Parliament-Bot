const DEFAULT_DELETE_DELAY_MS = 5_000;
const DEFAULT_DISABLE_PAYLOAD = Object.freeze({ components: [] });

function contextLabel(context) {
    if (typeof context === 'string' && context) return context;
    if (!context) return 'unspecified';
    if (typeof context.action === 'string' && context.action) return context.action;
    return 'unspecified';
}

function createPanelLifecycle({ setTimeoutImpl = setTimeout, logger = console } = {}) {
    const states = new WeakMap();

    function stateFor(message) {
        let state = states.get(message);
        if (!state) {
            state = {};
            states.set(message, state);
        }
        return state;
    }

    function logFailure(operation, context, error) {
        try {
            logger?.error?.(
                `[MysteryPanelLifecycle] ${operation} failed (context=${contextLabel(context)}):`,
                error
            );
        } catch {
            // Logging must not turn best-effort panel cleanup into a game failure.
        }
    }

    function deleteMessageAfter(message, delayMs, context) {
        if (!message || (typeof message !== 'object' && typeof message !== 'function')) return null;
        const state = stateFor(message);
        if (state.deleteTimer) return state.deleteTimer;

        try {
            const timer = setTimeoutImpl(async () => {
                try {
                    if (typeof message.delete !== 'function') return false;
                    await message.delete();
                    return true;
                } catch (error) {
                    logFailure('delete', context, error);
                    return false;
                }
            }, delayMs);
            timer?.unref?.();
            state.deleteTimer = timer;
            return timer;
        } catch (error) {
            logFailure('schedule delete', context, error);
            return null;
        }
    }

    function invalidatePanel(message, {
        delayMs = DEFAULT_DELETE_DELAY_MS,
        disablePayload = DEFAULT_DISABLE_PAYLOAD,
        keepMessage = false,
        context,
    } = {}) {
        if (!message || (typeof message !== 'object' && typeof message !== 'function')) {
            return Promise.resolve(false);
        }

        const state = stateFor(message);
        if (state.invalidationPromise) return state.invalidationPromise;

        state.invalidationPromise = Promise.resolve()
            .then(async () => {
                if (typeof message.edit !== 'function') return false;
                try {
                    await message.edit(disablePayload);
                    return true;
                } catch (error) {
                    logFailure('edit', context, error);
                    return false;
                }
            })
            .then(result => {
                if (!keepMessage) deleteMessageAfter(message, delayMs, context);
                return result;
            })
            .catch(error => {
                logFailure('invalidate', context, error);
                if (!keepMessage) deleteMessageAfter(message, delayMs, context);
                return false;
            });
        return state.invalidationPromise;
    }

    return { invalidatePanel, deleteMessageAfter };
}

const defaultLifecycle = createPanelLifecycle();

function createPanelRegistry({ lifecycle = defaultLifecycle } = {}) {
    const entries = new Map();

    function track(message, options = {}) {
        if (!message || (typeof message !== 'object' && typeof message !== 'function')) {
            return false;
        }
        if (!entries.has(message)) entries.set(message, { ...options });
        return true;
    }

    async function retire(message, options = {}) {
        const tracked = entries.get(message);
        if (!tracked) return false;
        entries.delete(message);
        return lifecycle.invalidatePanel(message, {
            ...tracked,
            ...options,
            keepMessage: false,
        });
    }

    async function stageAll() {
        await Promise.all([...entries].map(([message, options]) => (
            lifecycle.invalidatePanel(message, {
                ...options,
                keepMessage: true,
            })
        )));
    }

    function preserve(message) {
        return entries.delete(message);
    }

    function armAll({ delayMs = DEFAULT_DELETE_DELAY_MS } = {}) {
        for (const [message, options] of entries) {
            lifecycle.deleteMessageAfter(
                message,
                options.delayMs ?? delayMs,
                options.context
            );
        }
        entries.clear();
    }

    return {
        track,
        retire,
        preserve,
        stageAll,
        armAll,
        get size() {
            return entries.size;
        },
    };
}

module.exports = {
    createPanelLifecycle,
    createPanelRegistry,
    invalidatePanel: defaultLifecycle.invalidatePanel,
    deleteMessageAfter: defaultLifecycle.deleteMessageAfter,
};
