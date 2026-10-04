import { extractImagesFromFBXToBuffers } from './modules/fbx/embedded-images-core.js';
import { readFBXOrientationFromTree } from './modules/fbx/orientation-tree.js';
import { tagFBXModelIds } from './modules/fbx/source-identity.js';
import { installConsoleDiagnosticsGate } from './modules/utils/console-diagnostics.js';
import { serializeFBXTransfer } from './modules/workers/fbx-transfer.js';

// Module workers do not inherit the document's import map. The ESM build has
// fully resolved imports, including the exact same Three release below.
const FBX_LOADER_MODULE = 'https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/loaders/FBXLoader.js/+esm';
const THREE_MODULE = 'https://cdn.jsdelivr.net/npm/three@0.186.0/+esm';

let FBXLoaderCtor = null;
let workerThree = null;
const activeJobs = new Set();
const canceledJobs = new Set();

installConsoleDiagnosticsGate();

async function ensureLoader() {
    if (!FBXLoaderCtor) {
        const [fbx, three] = await Promise.all([import(FBX_LOADER_MODULE), import(THREE_MODULE)]);
        FBXLoaderCtor = fbx.FBXLoader;
        workerThree = three;
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

function parseScene(loader, buffer) {
    const images = new Map(), blobs = new Map();
    const originalLoad = workerThree.TextureLoader.prototype.load;
    const originalCreateURL = URL.createObjectURL;
    // FBXLoader is synchronous. Defer DOM image loading to the main thread;
    // capture compressed embedded files without creating any worker Blob URLs.
    URL.createObjectURL = blob => {
        const url = `blob:fbx-transfer-${blobs.size}`;
        blobs.set(url, blob);
        return url;
    };
    workerThree.TextureLoader.prototype.load = function (url) {
        const texture = new workerThree.Texture();
        const resolved = this.manager.resolveURL((this.path || '') + url);
        images.set(texture.source, blobs.has(resolved) ? { blob: blobs.get(resolved) } : { url: resolved });
        return texture;
    };
    try {
        return { obj: loader.parse(buffer, ''), images };
    } finally {
        workerThree.TextureLoader.prototype.load = originalLoad;
        URL.createObjectURL = originalCreateURL;
    }
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
        let { obj, images } = parseScene(loader, buffer);
        const end = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (isCanceled(id)) return;
        tagFBXModelIds(obj);
        const serializeStart = performance.now();
        const { json, transfer, stats } = serializeFBXTransfer(obj, images);
        stats.serializeMs = performance.now() - serializeStart;
        obj = null;
        images = null;
        const duration = end - start;
        if (isCanceled(id)) return;

        const wantEmbedded = features?.embedded !== false;
        const wantOrientation = features?.orientation !== false;

        const orientation = wantOrientation ? readFBXOrientationFromTree(loader?.fbxTree) : null;
        if (isCanceled(id)) return;
        const embedded = wantEmbedded ? await extractImagesFromFBXToBuffers(buffer) : [];
        if (isCanceled(id)) return;

        for (const entry of embedded) {
            if (entry?.buffer instanceof ArrayBuffer) transfer.push(entry.buffer);
        }

        self.postMessage({ id, ok: true, transport: 1, json, duration, embedded, orientation, stats }, transfer);
    } catch (err) {
        if (!isCanceled(id)) {
            self.postMessage({ id, ok: false, error: err?.message || String(err) });
        }
    } finally {
        activeJobs.delete(id);
        canceledJobs.delete(id);
    }
};
