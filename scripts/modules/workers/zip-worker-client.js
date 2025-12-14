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
    const pending = new Map();

    function disable(reason = null) {
        supported = false;
        const err = reason instanceof Error ? reason : reason ? new Error(String(reason)) : new Error('ZIP worker disabled');
        pending.forEach((job) => {
            try {
                job.reject(err);
            } catch (_) {}
        });
        pending.clear();
        try {
            workerInstance?.terminate?.();
        } catch (_) {}
        workerInstance = null;
    }

    function ensureZIPWorker() {
        if (!supported) return null;
        if (workerInstance) return workerInstance;
        try {
            workerInstance = new Worker(workerUrl, { type: 'module' });
            workerInstance.onmessage = (event) => {
                const msg = event.data || {};
                const job = pending.get(msg.id);
                if (!job) return;
                job.chain = job.chain
                    .then(() => job.handleMessage(msg))
                    .catch((err) => {
                        pending.delete(msg.id);
                        job.reject(err);
                    });
            };
            workerInstance.onerror = (event) => {
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

    function unpackZIPInWorker(file, handlers = {}) {
        const worker = ensureZIPWorker();
        if (!worker) return null;
        const id = ++reqId;

        const promise = new Promise((resolve, reject) => {
            const job = {
                id,
                resolve,
                reject,
                chain: Promise.resolve(),
                async handleMessage(msg) {
                    if (msg.type === 'error') {
                        pending.delete(id);
                        reject(new Error(msg.error || 'ZIP worker error'));
                        return;
                    }
                    if (msg.type === 'done') {
                        pending.delete(id);
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
                        try {
                            await handlers.onFBX?.(msg);
                        } finally {
                            worker.postMessage({ id, type: 'ack', seq: msg.seq });
                        }
                        return;
                    }
                    if (msg.type === 'image') {
                        try {
                            await handlers.onImage?.(msg);
                        } finally {
                            worker.postMessage({ id, type: 'ack', seq: msg.seq });
                        }
                        return;
                    }
                },
            };
            pending.set(id, job);
        });

        (async () => {
            try {
                const buffer = await file.arrayBuffer();
                worker.postMessage({ id, zipName: file.name, buffer }, [buffer]);
            } catch (err) {
                const job = pending.get(id);
                pending.delete(id);
                if (job) job.reject(err);
                else handlers.onError?.(err);
            }
        })();

        return promise;
    }

    function isSupported() {
        return supported;
    }

    return Object.freeze({
        ensureZIPWorker,
        unpackZIPInWorker,
        isSupported,
        disable,
    });
}

