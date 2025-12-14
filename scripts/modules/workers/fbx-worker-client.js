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
    const pending = new Map();

    function disable(reason = null) {
        supported = false;
        const err = reason instanceof Error ? reason : reason ? new Error(String(reason)) : new Error('FBX worker disabled');
        pending.forEach(({ reject }) => {
            try {
                reject(err);
            } catch (_) {}
        });
        pending.clear();
        try {
            workerInstance?.terminate?.();
        } catch (_) {}
        workerInstance = null;
    }

    function ensureFBXWorker() {
        if (!supported) return null;
        if (workerInstance) return workerInstance;
        try {
            workerInstance = new Worker(workerUrl, { type: 'module' });
            workerInstance.onmessage = (event) => {
                const { id, ok, json, error, duration, embedded, orientation } = event.data || {};
                const job = pending.get(id);
                if (!job) return;
                pending.delete(id);
                if (ok) job.resolve({ json, duration, embedded, orientation });
                else job.reject(new Error(error || 'FBX worker error'));
            };
            workerInstance.onerror = (event) => {
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

    async function parseFBXInWorker(buffer, features = null) {
        const worker = ensureFBXWorker();
        if (!worker) throw new Error('worker not available');
        const id = ++reqId;
        const promise = new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
        });
        worker.postMessage({ id, buffer, features: features || { embedded: true, orientation: true } }, [buffer]);
        const { json, duration, embedded, orientation } = await promise;
        const loader = new THREE.ObjectLoader();
        const parsed = loader.parse(json);
        if (json.animations?.length) {
            const clips = json.animations.map(THREE.AnimationClip.parse).filter(Boolean);
            if (clips.length) parsed.animations = clips;
        }
        return { obj: parsed, duration: duration || 0, embedded: embedded || [], orientationInfo: orientation || null };
    }

    function isSupported() {
        return supported;
    }

    return Object.freeze({
        ensureFBXWorker,
        parseFBXInWorker,
        isSupported,
        disable,
    });
}

