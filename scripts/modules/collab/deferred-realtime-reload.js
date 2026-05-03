export function createDeferredRealtimeReload(options = {}) {
    const reload = typeof options.reload === 'function' ? options.reload : null;
    const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
    const isMuted = typeof options.isMuted === 'function' ? options.isMuted : () => false;
    const onError = typeof options.onError === 'function' ? options.onError : null;

    let dirty = false;
    let inFlight = false;
    let queued = false;
    let lastContext = null;
    let lifecycleGeneration = 0;
    let activeRunId = 0;

    function normalizeContext(context = {}) {
        return { ...(context || {}) };
    }

    function remember(context) {
        lastContext = normalizeContext(context);
        return lastContext;
    }

    function markDirty(context = {}) {
        const nextContext = normalizeContext(context);
        if (!isCurrent(nextContext)) return false;
        remember(nextContext);
        dirty = true;
        return true;
    }

    function clear() {
        lifecycleGeneration += 1;
        dirty = false;
        inFlight = false;
        queued = false;
        lastContext = null;
    }

    async function run(context) {
        const runGeneration = lifecycleGeneration;
        const runId = activeRunId + 1;
        activeRunId = runId;
        inFlight = true;
        try {
            if (reload && isCurrent(context)) {
                await reload(context);
            }
        } catch (err) {
            const stillCurrentRun = activeRunId === runId
                && lifecycleGeneration === runGeneration
                && isCurrent(context);
            if (stillCurrentRun) {
                if (onError) onError(err, context);
                else console.error('Deferred realtime reload failed', err);
            }
        } finally {
            if (activeRunId === runId && lifecycleGeneration === runGeneration) {
                inFlight = false;
                if (queued || (dirty && !isMuted())) {
                    const nextContext = lastContext || context;
                    dirty = false;
                    queued = false;
                    request(nextContext);
                }
            }
        }
    }

    function request(context = {}) {
        const nextContext = normalizeContext(context);
        if (!isCurrent(nextContext)) return false;
        remember(nextContext);
        if (isMuted()) {
            dirty = true;
            return false;
        }
        if (inFlight) {
            queued = true;
            return false;
        }
        dirty = false;
        queued = false;
        void run(nextContext);
        return true;
    }

    function flush(context = {}) {
        if (!dirty) return false;
        const nextContext = lastContext || normalizeContext(context);
        if (!isCurrent(nextContext) || isMuted()) return false;
        return request(nextContext);
    }

    return Object.freeze({
        request,
        markDirty,
        flush,
        clear,
        isDirty: () => dirty,
        isInFlight: () => inFlight,
        isQueued: () => queued,
        getLastContext: () => (lastContext ? { ...lastContext } : null),
    });
}
