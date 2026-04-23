import { extractImagesFromFBXToBuffers } from './modules/fbx/embedded-images-core.js';
import { readFBXOrientationFromTree } from './modules/fbx/orientation-tree.js';

const FBX_LOADER_MODULE = 'https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/loaders/FBXLoader.js?module';
const FBX_Z_UP_WARNING = 'THREE.FBXLoader: You are loading an asset with a Z-UP coordinate system.';
const FBX_Z_UP_WARNING_PARTIAL = 'The vertex data are not converted.';

let FBXLoaderCtor = null;

function withFilteredFBXWarnings(task) {
    const warn = console.warn.bind(console);
    const error = console.error.bind(console);

    console.warn = (...args) => {
        const msg = (typeof args[0] === 'string' ? args[0] : args[0]?.message) || '';
        if (typeof msg === 'string' && msg.includes(FBX_Z_UP_WARNING) && msg.includes(FBX_Z_UP_WARNING_PARTIAL)) {
            return;
        }
        warn(...args);
    };

    console.error = (...args) => {
        const msg = (typeof args[0] === 'string' ? args[0] : args[0]?.message) || '';
        if (typeof msg === 'string' && msg.includes('THREE.FBXLoader') && msg.includes('Z-UP coordinate system')) {
            return;
        }
        error(...args);
    };

    try {
        return task();
    } finally {
        console.warn = warn;
        console.error = error;
    }
}

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
        let obj = withFilteredFBXWarnings(() => loader.parse(buffer, ''));
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
