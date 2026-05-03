export function createZIPWorkerClient(options = {}) {
    const workerUrl = (() => {
        if (options.workerUrl) return options.workerUrl;
        try {
            return new URL('../../zip-worker.js', import.meta.url);
        } catch (_) {
            return null;
        }
    })();

    let supported = typeof Worker !== 'undefined' && !!workerUrl;
    let workerInstance = null;
    let reqId = 0;
    let disposed = false;
    const pending = new Map();

    function makeAbortError(message = 'ZIP worker job aborted') {
        try {
            return new DOMException(message, 'AbortError');
        } catch (_) {
            const err = new Error(message);
            err.name = 'AbortError';
            return err;
        }
    }

    function cleanupJob(job) {
        if (!job?.signal || !job?.abortHandler) return;
        try {
            job.signal.removeEventListener('abort', job.abortHandler);
        } catch (_) {}
    }

    function rejectPending(err) {
        pending.forEach((job) => {
            cleanupJob(job);
            try {
                job.reject(err);
            } catch (_) {}
        });
        pending.clear();
    }

    function terminateWorker() {
        try {
            workerInstance?.terminate?.();
        } catch (_) {}
        workerInstance = null;
    }

    function disable(reason = null) {
        if (disposed) return;
        supported = false;
        const err = reason instanceof Error ? reason : reason ? new Error(String(reason)) : new Error('ZIP worker disabled');
        rejectPending(err);
        terminateWorker();
    }

    function ensureZIPWorker() {
        if (disposed) return null;
        if (!supported) return null;
        if (workerInstance) return workerInstance;
        try {
            workerInstance = new Worker(workerUrl, { type: 'module' });
            const worker = workerInstance;
            workerInstance.onmessage = (event) => {
                if (disposed || workerInstance !== worker) return;
                const msg = event.data || {};
                const job = pending.get(msg.id);
                if (!job) return;
                job.chain = job.chain
                    .then(() => job.handleMessage(msg))
                    .catch((err) => {
                        pending.delete(msg.id);
                        cleanupJob(job);
                        job.reject(err);
                        if (!disposed && workerInstance === worker) {
                            terminateWorker();
                        }
                    });
            };
            workerInstance.onerror = (event) => {
                if (disposed || workerInstance !== worker) return;
                event.preventDefault?.();
                const err = event?.error || (event?.message ? new Error(event.message) : new Error('ZIP worker error'));
                disable(err);
            };
        } catch (err) {
            console.warn('ZIP worker init failed', err);
            disable(err);
        }
        return workerInstance;
    }

    function unpackZIPInWorker(file, handlers = {}, options = {}) {
        if (disposed) return Promise.reject(makeAbortError('ZIP worker client disposed'));
        const worker = ensureZIPWorker();
        if (!worker) return null;
        const signal = options?.signal || null;
        if (signal?.aborted) return Promise.reject(makeAbortError());
        const id = ++reqId;

        const promise = new Promise((resolve, reject) => {
            const job = {
                id,
                resolve,
                reject,
                signal,
                abortHandler: null,
                chain: Promise.resolve(),
                async handleMessage(msg) {
                    if (disposed || workerInstance !== worker) throw makeAbortError('ZIP worker client disposed');
                    if (signal?.aborted) throw makeAbortError();
                    if (msg.type === 'error') {
                        pending.delete(id);
                        cleanupJob(this);
                        reject(new Error(msg.error || 'ZIP worker error'));
                        return;
                    }
                    if (msg.type === 'done') {
                        pending.delete(id);
                        cleanupJob(this);
                        resolve(msg);
                        return;
                    }
                    if (msg.type === 'progress') {
                        try {
                            handlers.onProgress?.(msg);
                        } catch (_) {}
                        return;
                    }
                    if (msg.type === 'meta') {
                        try {
                            handlers.onMeta?.(msg);
                        } catch (_) {}
                        return;
                    }
                    if (msg.type === 'geojson') {
                        await handlers.onGeoJSON?.(msg);
                        return;
                    }
                    if (msg.type === 'fbx') {
                        if (signal?.aborted) throw makeAbortError();
                        await handlers.onFBX?.(msg);
                        if (!signal?.aborted && workerInstance === worker) {
                            worker.postMessage({ id, type: 'ack', seq: msg.seq });
                        }
                        return;
                    }
                    if (msg.type === 'image') {
                        if (signal?.aborted) throw makeAbortError();
                        await handlers.onImage?.(msg);
                        if (!signal?.aborted && workerInstance === worker) {
                            worker.postMessage({ id, type: 'ack', seq: msg.seq });
                        }
                        return;
                    }
                },
            };
            if (signal?.addEventListener) {
                job.abortHandler = () => {
                    const err = makeAbortError();
                    rejectPending(err);
                    terminateWorker();
                };
                signal.addEventListener('abort', job.abortHandler, { once: true });
            }
            pending.set(id, job);
        });

        (async () => {
            try {
                if (disposed || signal?.aborted) throw makeAbortError(disposed ? 'ZIP worker client disposed' : undefined);
                const buffer = await file.arrayBuffer();
                if (disposed || signal?.aborted || workerInstance !== worker) {
                    throw makeAbortError(disposed ? 'ZIP worker client disposed' : undefined);
                }
                worker.postMessage({ id, zipName: file.name, buffer }, [buffer]);
            } catch (err) {
                const job = pending.get(id);
                pending.delete(id);
                cleanupJob(job);
                if (job) job.reject(err);
                else if (!disposed && !signal?.aborted) handlers.onError?.(err);
            }
        })();

        return promise;
    }

    function isSupported() {
        return !disposed && supported;
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        supported = false;
        rejectPending(makeAbortError('ZIP worker client disposed'));
        terminateWorker();
    }

    return Object.freeze({
        ensureZIPWorker,
        unpackZIPInWorker,
        isSupported,
        disable,
        dispose,
    });
}
