import * as THREE from 'three';

export function createFBXWorkerClient(options = {}) {
    const workerUrl = (() => {
        if (options.workerUrl) return options.workerUrl;
        try {
            return new URL('../../fbx-worker.js', import.meta.url);
        } catch (_) {
            return null;
        }
    })();

    let supported = typeof Worker !== 'undefined' && !!workerUrl;
    let workerInstance = null;
    let reqId = 0;
    let disposed = false;
    const pending = new Map();

    function makeAbortError(message = 'FBX worker job aborted') {
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

    function rejectJob(id, job, err) {
        if (!pending.has(id)) return false;
        pending.delete(id);
        cleanupJob(job);
        try {
            job.reject(err);
        } catch (_) {}
        return true;
    }

    function terminateWorker() {
        try {
            workerInstance?.terminate?.();
        } catch (_) {}
        workerInstance = null;
    }

    function disposeParsedObject(root) {
        if (!root?.traverse) return;
        const geometries = new Set();
        const materials = new Set();
        const textures = new Set();
        root.traverse((node) => {
            if (node?.geometry?.dispose && !geometries.has(node.geometry)) {
                geometries.add(node.geometry);
                node.geometry.dispose();
            }
            const mats = Array.isArray(node?.material) ? node.material : [node?.material];
            mats.filter(Boolean).forEach((material) => {
                if (materials.has(material)) return;
                materials.add(material);
                Object.values(material).forEach((value) => {
                    if (!value?.isTexture || textures.has(value)) return;
                    textures.add(value);
                    value.dispose?.();
                });
                material.dispose?.();
            });
        });
    }

    function disable(reason = null) {
        if (disposed) return;
        supported = false;
        const err = reason instanceof Error ? reason : reason ? new Error(String(reason)) : new Error('FBX worker disabled');
        rejectPending(err);
        terminateWorker();
    }

    function ensureFBXWorker() {
        if (disposed) return null;
        if (!supported) return null;
        if (workerInstance) return workerInstance;
        try {
            workerInstance = new Worker(workerUrl, { type: 'module' });
            const worker = workerInstance;
            workerInstance.onmessage = (event) => {
                if (disposed || workerInstance !== worker) return;
                const { id, ok, json, error, duration, embedded, orientation } = event.data || {};
                const job = pending.get(id);
                if (!job) return;
                pending.delete(id);
                cleanupJob(job);
                if (ok) job.resolve({ json, duration, embedded, orientation });
                else job.reject(new Error(error || 'FBX worker error'));
            };
            workerInstance.onerror = (event) => {
                if (disposed || workerInstance !== worker) return;
                event.preventDefault?.();
                const err = event?.error || (event?.message ? new Error(event.message) : new Error('FBX worker error'));
                disable(err);
            };
        } catch (err) {
            console.warn('FBX worker init failed', err);
            disable(err);
        }
        return workerInstance;
    }

    async function parseFBXInWorker(buffer, features = null, options = {}) {
        if (disposed) throw makeAbortError('FBX worker client disposed');
        const worker = ensureFBXWorker();
        if (!worker) throw new Error('worker not available');
        const signal = options?.signal || null;
        if (signal?.aborted) throw makeAbortError();
        const id = ++reqId;
        const promise = new Promise((resolve, reject) => {
            const job = { resolve, reject, signal, abortHandler: null };
            if (signal?.addEventListener) {
                job.abortHandler = () => {
                    const err = makeAbortError();
                    if (!rejectJob(id, job, err)) return;
                    if (pending.size === 0) {
                        terminateWorker();
                    }
                };
                signal.addEventListener('abort', job.abortHandler, { once: true });
            }
            pending.set(id, job);
        });
        try {
            worker.postMessage({ id, buffer, features: features || { embedded: true, orientation: true } }, [buffer]);
        } catch (err) {
            const job = pending.get(id);
            pending.delete(id);
            cleanupJob(job);
            throw err;
        }
        const { json, duration, embedded, orientation } = await promise;
        if (disposed || signal?.aborted) throw makeAbortError(disposed ? 'FBX worker client disposed' : undefined);
        const loader = new THREE.ObjectLoader();
        let parsed = null;
        try {
            parsed = loader.parse(json);
            if (disposed || signal?.aborted) {
                throw makeAbortError(disposed ? 'FBX worker client disposed' : undefined);
            }
            if (json.animations?.length) {
                const clips = json.animations.map(THREE.AnimationClip.parse).filter(Boolean);
                if (clips.length) parsed.animations = clips;
            }
            if (disposed || signal?.aborted) {
                throw makeAbortError(disposed ? 'FBX worker client disposed' : undefined);
            }
            return { obj: parsed, duration: duration || 0, embedded: embedded || [], orientationInfo: orientation || null };
        } catch (err) {
            disposeParsedObject(parsed);
            throw err;
        }
    }

    function isSupported() {
        return !disposed && supported;
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        supported = false;
        rejectPending(makeAbortError('FBX worker client disposed'));
        terminateWorker();
    }

    return Object.freeze({
        ensureFBXWorker,
        parseFBXInWorker,
        isSupported,
        disable,
        dispose,
    });
}
