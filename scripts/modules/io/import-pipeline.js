export function createImportPipelineQueue(options = {}) {
    const makeAbortError = typeof options.makeAbortError === 'function'
        ? options.makeAbortError
        : (message = 'Import operation aborted') => {
            try {
                return new DOMException(message, 'AbortError');
            } catch (_) {
                const err = new Error(message);
                err.name = 'AbortError';
                return err;
            }
        };

    let tail = Promise.resolve();
    let pendingCount = 0;

    function getAbortError(signal, message) {
        const reason = signal?.reason || null;
        if (reason?.name === 'AbortError') return reason;
        return makeAbortError(message);
    }

    function throwIfCanceled(options = {}) {
        const signal = options.signal || null;
        const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : null;
        const abortMessage = options.abortMessage || 'Import operation aborted';
        if (signal?.aborted) throw getAbortError(signal, abortMessage);
        if (isCurrent && !isCurrent()) throw makeAbortError(abortMessage);
    }

    function enqueue(operation, options = {}) {
        if (typeof operation !== 'function') return Promise.resolve(undefined);
        pendingCount += 1;
        const run = tail
            .catch(() => {})
            .then(async () => {
                throwIfCanceled(options);
                return operation();
            });
        tail = run
            .finally(() => {
                pendingCount = Math.max(0, pendingCount - 1);
            })
            .catch(() => {});
        return run;
    }

    return Object.freeze({
        enqueue,
        getPendingCount: () => pendingCount,
    });
}
