export function createRoomModelLoadQueue(options = {}) {
    const loadModelNow = typeof options.loadModelNow === 'function' ? options.loadModelNow : null;
    const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
    const onError = typeof options.onError === 'function' ? options.onError : null;

    const pending = new Map();
    let activeKey = '';
    let activeContext = null;
    let draining = false;
    let queueGeneration = 0;
    let activeRunId = 0;

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

    function enqueue(model, context = {}) {
        const nextContext = normalizeContext(model, context);
        if (!model || !isContextCurrent(nextContext)) return false;
        if (activeKey && activeKey === nextContext.key && isContextCurrent(activeContext)) return false;
        pending.set(nextContext.key, { model, context: nextContext });
        return true;
    }

    function deletePending(context = {}) {
        const nextContext = normalizeContext({ id: context.modelId }, context);
        if (!nextContext.key) return false;
        return pending.delete(nextContext.key);
    }

    function clear() {
        pending.clear();
    }

    function reset() {
        queueGeneration += 1;
        pending.clear();
        activeKey = '';
        activeContext = null;
        draining = false;
    }

    async function runNow(model, context) {
        const runGeneration = queueGeneration;
        const runId = activeRunId + 1;
        activeRunId = runId;
        activeKey = context.key;
        activeContext = context;
        pending.delete(context.key);
        try {
            if (!loadModelNow || !isContextCurrent(context)) return false;
            const loaded = !!await loadModelNow(model, context);
            if (activeRunId !== runId || queueGeneration !== runGeneration || !isContextCurrent(context)) return false;
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
            if (activeRunId === runId && queueGeneration === runGeneration) {
                activeKey = '';
                activeContext = null;
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
                await runNow(entry.model, entry.context);
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

    function getPendingModelIds() {
        return Array.from(pending.values()).map((entry) => entry.context.modelId);
    }

    return Object.freeze({
        load,
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
