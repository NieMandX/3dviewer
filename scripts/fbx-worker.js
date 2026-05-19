import { extractImagesFromFBXToBuffers } from './modules/fbx/embedded-images-core.js';
import { readFBXOrientationFromTree } from './modules/fbx/orientation-tree.js';
import { installConsoleDiagnosticsGate } from './modules/utils/console-diagnostics.js';

const FBX_LOADER_MODULE = 'https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/loaders/FBXLoader.js?module';

let FBXLoaderCtor = null;
const activeJobs = new Set();
const canceledJobs = new Set();

installConsoleDiagnosticsGate();

async function ensureLoader() {
    if (!FBXLoaderCtor) {
        FBXLoaderCtor = (await import(FBX_LOADER_MODULE)).FBXLoader;
    }
}

function cancelJob(id) {
    if (id == null || !activeJobs.has(id)) return false;
    canceledJobs.add(id);
    return true;
}

function isCanceled(id) {
    return canceledJobs.has(id);
}

self.onmessage = async (event) => {
    const msg = event.data || {};

    if (msg.type === 'cancel') {
        cancelJob(msg.id);
        return;
    }

    const { id, buffer, features } = msg;
    if (id == null || !buffer) return;

    activeJobs.add(id);
    try {
        await ensureLoader();
        if (isCanceled(id)) return;
        const loader = new FBXLoaderCtor();
        const start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        let obj = loader.parse(buffer, '');
        const end = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (isCanceled(id)) return;
        const json = obj.toJSON();
        obj = null;
        const duration = end - start;
        if (isCanceled(id)) return;

        const wantEmbedded = features?.embedded !== false;
        const wantOrientation = features?.orientation !== false;

        const orientation = wantOrientation ? readFBXOrientationFromTree(loader?.fbxTree) : null;
        if (isCanceled(id)) return;
        const embedded = wantEmbedded ? await extractImagesFromFBXToBuffers(buffer) : [];
        if (isCanceled(id)) return;

        const transfer = [];
        for (const entry of embedded) {
            if (entry?.buffer instanceof ArrayBuffer) transfer.push(entry.buffer);
        }

        self.postMessage({ id, ok: true, json, duration, embedded, orientation }, transfer);
    } catch (err) {
        if (!isCanceled(id)) {
            self.postMessage({ id, ok: false, error: err?.message || String(err) });
        }
    } finally {
        activeJobs.delete(id);
        canceledJobs.delete(id);
    }
};
