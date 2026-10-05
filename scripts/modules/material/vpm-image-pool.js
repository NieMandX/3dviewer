// VPM maps keep independent Texture objects (names, UVs and editing), but
// byte-identical encoded files can share one decoded image/Three Source.
// Entries are owned by live textures, never by a global Three.Cache entry.
export function createVPMImagePool(THREE) {
    const entries = new Map();

    async function load(texture, url, isCurrent = () => true) {
        if (!isCurrent()) return;
        const controller = new AbortController();
        let disposed = false;
        let owned = null;
        const release = () => {
            disposed = true;
            controller.abort();
            texture.removeEventListener('dispose', release);
            if (owned && --owned.users === 0) entries.delete(owned.key);
        };
        texture.addEventListener('dispose', release);
        const live = () => !disposed && isCurrent();
        try {
            const response = await fetch(url, { signal: controller.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            if (!live()) return;
            // Hash compressed bytes, not a full-resolution pixel readback.
            // If crypto is unavailable, keep the ordinary independent image.
            let key = null;
            if (globalThis.crypto?.subtle) {
                const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
                key = `${blob.type}:${blob.size}:${Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')}`;
            }
            if (!live()) return;
            let entry = key ? entries.get(key) : null;
            if (!entry) {
                const image = await decode(blob, controller.signal);
                if (!live()) return;
                // Another caller may have decoded the same file in the meantime.
                entry = (key ? entries.get(key) : null) || { key, source: new THREE.TextureSource(image), users: 0 };
            }
            if (!live()) return;
            owned = entry;
            entry.users++;
            if (key) entries.set(key, entry);
            texture.source = entry.source;
            texture.needsUpdate = true;
        } finally {
            if (!owned) release();
        }
    }

    function decode(blob, signal) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            const url = URL.createObjectURL(blob);
            const clear = () => {
                image.onload = image.onerror = null;
                signal.removeEventListener('abort', cancel);
                URL.revokeObjectURL(url);
            };
            const cancel = () => {
                clear(); image.removeAttribute('src');
                reject(new DOMException('VPM image loading aborted', 'AbortError'));
            };
            image.onload = () => { clear(); resolve(image); };
            image.onerror = () => { clear(); image.removeAttribute('src'); reject(new Error('VPM image loading failed')); };
            signal.addEventListener('abort', cancel, { once: true });
            if (signal.aborted) { cancel(); return; }
            image.src = url;
        });
    }

    return { load, get size() { return entries.size; } };
}
