import * as THREE from 'three';
import { collectMaterialTextures } from '../material/texture-utils.js';
import { parseFBXTransfer } from './fbx-transfer-loader.js';

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
    const hydrations = new Set();
    let completed = 0;
    let lastParse = null;
    let idleTimer = null;
    const idleTimeoutMs = options.idleTimeoutMs ?? 5000;

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
        clearTimeout(idleTimer);
        idleTimer = null;
        try {
            workerInstance?.terminate?.();
        } catch (_) {}
        workerInstance = null;
    }

    function retireIdleWorker(worker) {
        clearTimeout(idleTimer);
        if (idleTimeoutMs === 0) { terminateWorker(); return; }
        // Reuse the realm for a batch. Creating/terminating one worker per FBX
        // can outpace WebKit's native memory reclamation on a large ZIP set.
        idleTimer = setTimeout(() => {
            idleTimer = null;
            if (workerInstance === worker && pending.size === 0) terminateWorker();
        }, idleTimeoutMs);
    }

    function disposeParsedObject(root) {
        if (!root?.traverse) return;
        const geometries = new Set();
        const materials = new Set();
        const textures = new Set();
        const skeletons = new Set();
        root.traverse((node) => {
            const skeleton = node?.skeleton || null;
            if (skeleton?.dispose && !skeletons.has(skeleton)) {
                skeletons.add(skeleton);
                skeleton.dispose();
            }
            if (node?.geometry?.dispose && !geometries.has(node.geometry)) {
                geometries.add(node.geometry);
                node.geometry.dispose();
            }
            const mats = Array.isArray(node?.material) ? node.material : [node?.material];
            mats.filter(Boolean).forEach((material) => {
                if (materials.has(material)) return;
                materials.add(material);
                collectMaterialTextures(material).forEach((value) => {
                    if (textures.has(value)) return;
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
        for (const controller of hydrations) controller.abort();
        terminateWorker();
    }

    function ensureFBXWorker() {
        if (disposed) return null;
        if (!supported) return null;
        if (workerInstance) {
            clearTimeout(idleTimer); idleTimer = null;
            return workerInstance;
        }
        try {
            workerInstance = new Worker(workerUrl, { type: 'module' });
            const worker = workerInstance;
            workerInstance.onmessage = (event) => {
                if (disposed || workerInstance !== worker) return;
                const { id, ok, json, error, duration, embedded, orientation, transport, stats } = event.data || {};
                const job = pending.get(id);
                if (!job) return;
                pending.delete(id);
                cleanupJob(job);
                // FBXLoader retains its parsed tree in module globals. Retiring
                // an idle worker releases that tree and its uncompressed arrays.
                if (pending.size === 0) retireIdleWorker(worker);
                if (ok) job.resolve({ json, duration, embedded, orientation, transport, stats });
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
        const signal = options?.signal || null;
        if (signal?.aborted) throw makeAbortError();
        const worker = ensureFBXWorker();
        if (!worker) throw new Error('worker not available');
        const id = ++reqId;
        const promise = new Promise((resolve, reject) => {
            const job = { resolve, reject, signal, abortHandler: null };
            if (signal?.addEventListener) {
                job.abortHandler = () => {
                    const err = makeAbortError();
                    if (!rejectJob(id, job, err)) return;
                    if (pending.size === 0) {
                        terminateWorker();
                    } else if (!disposed && workerInstance === worker) {
                        try {
                            worker.postMessage({ id, type: 'cancel' });
                        } catch (_) {}
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
        const { json, duration, embedded, orientation, transport, stats } = await promise;
        if (disposed || signal?.aborted) throw makeAbortError(disposed ? 'FBX worker client disposed' : undefined);
        const loader = new THREE.ObjectLoader();
        const hydration = new AbortController();
        const abortHydration = () => hydration.abort();
        signal?.addEventListener('abort', abortHydration, { once: true });
        hydrations.add(hydration);
        const rebuildStart = performance.now();
        let parsed = null;
        try {
            parsed = transport === 1 ? await parseFBXTransfer(json, { signal: hydration.signal }) : loader.parse(json);
            if (disposed || signal?.aborted) {
                throw makeAbortError(disposed ? 'FBX worker client disposed' : undefined);
            }
            if (transport !== 1 && json.animations?.length) {
                const clips = json.animations.map(THREE.AnimationClip.parse).filter(Boolean);
                if (clips.length) parsed.animations = clips;
            }
            if (disposed || signal?.aborted) {
                throw makeAbortError(disposed ? 'FBX worker client disposed' : undefined);
            }
            completed++;
            lastParse = { transport: transport || 0, parseMs: duration || 0, rebuildMs: performance.now() - rebuildStart, ...stats };
            return { obj: parsed, duration: duration || 0, embedded: embedded || [], orientationInfo: orientation || null };
        } catch (err) {
            disposeParsedObject(parsed);
            throw err;
        } finally {
            hydrations.delete(hydration);
            signal?.removeEventListener('abort', abortHydration);
        }
    }

    function isSupported() {
        return !disposed && supported;
    }

    function getDiagnostics() {
        return {
            supported: isSupported(),
            disposed,
            workerActive: !!workerInstance,
            pending: pending.size,
            hydrating: hydrations.size,
            completed,
            lastParse,
        };
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        supported = false;
        rejectPending(makeAbortError('FBX worker client disposed'));
        for (const controller of hydrations) controller.abort();
        terminateWorker();
    }

    return Object.freeze({
        ensureFBXWorker,
        parseFBXInWorker,
        isSupported,
        getDiagnostics,
        disable,
        dispose,
    });
}
