import { extractImagesFromFBXToBuffers } from './modules/fbx/embedded-images-core.js';
import { readFBXOrientationFromTree } from './modules/fbx/orientation-tree.js';

const FBX_LOADER_MODULE = 'https://cdn.jsdelivr.net/npm/three@0.183.0/examples/jsm/loaders/FBXLoader.js?module';

let FBXLoaderCtor = null;

async function ensureLoader() {
    if (!FBXLoaderCtor) {
        FBXLoaderCtor = (await import(FBX_LOADER_MODULE)).FBXLoader;
    }
}

self.onmessage = async (event) => {
    const { id, buffer, features } = event.data || {};
    if (id == null || !buffer) return;

    try {
        await ensureLoader();
        const loader = new FBXLoaderCtor();
        const start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        let obj = loader.parse(buffer, '');
        const end = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const json = obj.toJSON();
        obj = null;
        const duration = end - start;

        const wantEmbedded = features?.embedded !== false;
        const wantOrientation = features?.orientation !== false;

        const orientation = wantOrientation ? readFBXOrientationFromTree(loader?.fbxTree) : null;
        const embedded = wantEmbedded ? await extractImagesFromFBXToBuffers(buffer) : [];

        const transfer = [];
        for (const entry of embedded) {
            if (entry?.buffer instanceof ArrayBuffer) transfer.push(entry.buffer);
        }

        self.postMessage({ id, ok: true, json, duration, embedded, orientation }, transfer);
    } catch (err) {
        self.postMessage({ id, ok: false, error: err?.message || String(err) });
    }
};
