const FBX_LOADER_MODULE = 'https://unpkg.com/three@0.179.1/examples/jsm/loaders/FBXLoader.js?module';

let FBXLoaderCtor = null;

async function ensureLoader() {
    if (!FBXLoaderCtor) {
        FBXLoaderCtor = (await import(FBX_LOADER_MODULE)).FBXLoader;
    }
}

self.onmessage = async (event) => {
    const { id, buffer } = event.data || {};
    if (id == null || !buffer) return;

    try {
        await ensureLoader();
        const loader = new FBXLoaderCtor();
        const start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const obj = loader.parse(buffer, '');
        const end = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const json = obj.toJSON();
        const duration = end - start;
        self.postMessage({ id, ok: true, json, duration });
    } catch (err) {
        self.postMessage({ id, ok: false, error: err?.message || String(err) });
    }
};
