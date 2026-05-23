export function createRoomModelLoadQueue(options = {}) {
    const loadModelNow = typeof options.loadModelNow === 'function' ? options.loadModelNow : null;
    const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
    const onError = typeof options.onError === 'function' ? options.onError : null;

    const pending = new Map();
    let activeKey = '';
    let activeContext = null;
    let activeWaiters = [];
    let draining = false;
    let queueGeneration = 0;
    let activeRunId = 0;

    function createWaiter() {
        let resolve = null;
        let settled = false;
        const promise = new Promise((nextResolve) => {
            resolve = nextResolve;
        });
        return {
            promise,
            resolve(value) {
                if (settled) return;
                settled = true;
                resolve(!!value);
            },
        };
    }

    function resolveWaiters(waiters, value) {
        if (!Array.isArray(waiters) || !waiters.length) return;
        waiters.forEach((waiter) => waiter?.resolve?.(value));
        waiters.length = 0;
    }

    function normalizeContext(model, context = {}) {
        const modelId = String(context.modelId || model?.id || '').trim();
        const roomId = String(context.roomId || '').trim();
        const generation = Number.isFinite(context.generation) ? context.generation : 0;
        return {
            ...context,
            modelId,
            roomId,
            generation,
            key: roomId && modelId ? `${roomId}:${modelId}` : '',
        };
    }

    function isContextCurrent(context) {
        return !!context?.key && isCurrent(context);
    }

    function upsertPending(model, context) {
        const existing = pending.get(context.key);
        if (existing) {
            existing.model = model;
            existing.context = context;
            return existing;
        }
        const entry = { model, context, waiters: [] };
        pending.set(context.key, entry);
        return entry;
    }

    function enqueue(model, context = {}) {
        const nextContext = normalizeContext(model, context);
        if (!model || !isContextCurrent(nextContext)) return false;
        if (activeKey && activeKey === nextContext.key && isContextCurrent(activeContext)) return false;
        upsertPending(model, nextContext);
        return true;
    }

    function deletePending(context = {}) {
        const nextContext = normalizeContext({ id: context.modelId }, context);
        if (!nextContext.key) return false;
        const entry = pending.get(nextContext.key);
        if (!entry) return false;
        pending.delete(nextContext.key);
        resolveWaiters(entry.waiters, false);
        return true;
    }

    function clear() {
        pending.forEach((entry) => resolveWaiters(entry.waiters, false));
        pending.clear();
    }

    function reset() {
        queueGeneration += 1;
        clear();
        resolveWaiters(activeWaiters, false);
        activeKey = '';
        activeContext = null;
        activeWaiters = [];
        draining = false;
    }

    async function runNow(model, context, waiters = []) {
        const runGeneration = queueGeneration;
        const runId = activeRunId + 1;
        activeRunId = runId;
        activeKey = context.key;
        activeContext = context;
        activeWaiters = waiters;
        pending.delete(context.key);
        let runResult = false;
        try {
            if (!loadModelNow || !isContextCurrent(context)) return false;
            const loaded = !!await loadModelNow(model, context);
            if (activeRunId !== runId || queueGeneration !== runGeneration || !isContextCurrent(context)) return false;
            runResult = loaded;
            return loaded;
        } catch (err) {
            const stillCurrentRun = activeRunId === runId
                && queueGeneration === runGeneration
                && isContextCurrent(context);
            if (stillCurrentRun) {
                if (onError) onError(err, { model, context });
                else console.error('Room model queued load failed', err);
            }
            return false;
        } finally {
            resolveWaiters(waiters, runResult);
            if (activeRunId === runId && queueGeneration === runGeneration) {
                activeKey = '';
                activeContext = null;
                activeWaiters = [];
                if (!draining) {
                    await drain();
                }
            }
        }
    }

    function shiftNextPending() {
        for (const [key, entry] of pending.entries()) {
            if (!isContextCurrent(entry.context)) {
                pending.delete(key);
                resolveWaiters(entry.waiters, false);
                continue;
            }
            pending.delete(key);
            return entry;
        }
        return null;
    }

    async function drain() {
        if (draining || activeKey) return false;
        const drainGeneration = queueGeneration;
        draining = true;
        let loadedAny = false;
        try {
            while (!activeKey && queueGeneration === drainGeneration) {
                const entry = shiftNextPending();
                if (!entry) break;
                loadedAny = true;
                await runNow(entry.model, entry.context, entry.waiters);
            }
        } finally {
            draining = false;
        }
        return loadedAny;
    }

    async function load(model, context = {}) {
        const nextContext = normalizeContext(model, context);
        if (!model || !isContextCurrent(nextContext)) return false;
        if (activeKey) {
            enqueue(model, nextContext);
            return false;
        }
        return runNow(model, nextContext);
    }

    function loadAndWait(model, context = {}) {
        const nextContext = normalizeContext(model, context);
        if (!model || !isContextCurrent(nextContext)) return Promise.resolve(false);
        if (activeKey) {
            const waiter = createWaiter();
            if (activeKey === nextContext.key && isContextCurrent(activeContext)) {
                activeWaiters.push(waiter);
            } else {
                const entry = upsertPending(model, nextContext);
                entry.waiters.push(waiter);
            }
            return waiter.promise;
        }
        return runNow(model, nextContext);
    }

    function getPendingModelIds() {
        return Array.from(pending.values()).map((entry) => entry.context.modelId);
    }

    return Object.freeze({
        load,
        loadAndWait,
        enqueue,
        delete: deletePending,
        clear,
        reset,
        drain,
        isActive: () => !!activeKey,
        getActiveContext: () => (activeContext ? { ...activeContext } : null),
        getPendingCount: () => pending.size,
        getPendingModelIds,
    });
}
