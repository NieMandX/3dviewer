import assert from 'node:assert/strict';

export async function runVPMImagesSmoke(browser, baseUrl, { webgpu = false } = {}) {
    const page = await browser.newPage();
    try {
        await page.goto(`${baseUrl}/__smoke_blank`);
        const result = await page.evaluate(async webgpu => {
            const T = await import('three');
            const { createVPMImagePool } = await import('/scripts/modules/material/vpm-image-pool.js');
            const check = (condition, message) => { if (!condition) throw Error(message); };
            const pool = createVPMImagePool(T), textures = [], urls = [];
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
            const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(8, 8);
            for (let i = 0; i < pixels.data.length; i += 4) pixels.data.set([i, 255 - i, i / 2, i % 12 ? 255 : 95], i);
            ctx.putImageData(pixels, 0, 0);
            const blob = await new Promise(resolve => canvas.toBlob(resolve));
            const url = URL.createObjectURL(blob), alias = URL.createObjectURL(blob);
            urls.push(url, alias);
            const nativeURL = URL.createObjectURL.bind(URL), nativeRevoke = URL.revokeObjectURL.bind(URL), liveURLs = new Set();
            URL.createObjectURL = value => { const result = nativeURL(value); liveURLs.add(result); return result; };
            URL.revokeObjectURL = value => { liveURLs.delete(value); nativeRevoke(value); };
            const texture = () => { const t = new T.Texture(); textures.push(t); return t; };
            const a = texture(), b = texture(); a.name = 'building A'; b.name = 'building B';
            await pool.load(a, url); await pool.load(b, alias);
            check(a !== b && a.source === b.source && a.image === b.image && pool.size === 1, 'byte-identical aliases not shared');
            b.repeat.set(2, 3); b.offset.set(.25, .5); b.flipY = false;
            check(a.repeat.x === 1 && a.offset.x === 0 && a.flipY && a.name === 'building A', 'texture settings/name coupled');

            // Change an opaque pixel so premultiplied canvas rounding cannot
            // erase the intended one-value difference before PNG encoding.
            pixels.data[4]++;
            ctx.putImageData(pixels, 0, 0);
            const different = URL.createObjectURL(await new Promise(resolve => canvas.toBlob(resolve))); urls.push(different);
            const c = texture(); await pool.load(c, different);
            check(c.source !== a.source && pool.size === 2, 'one-pixel difference was merged'); c.dispose();
            const bad = URL.createObjectURL(new Blob(['invalid PNG'], { type: 'image/png' })); urls.push(bad);
            check(await pool.load(texture(), bad).then(() => false, () => true), 'bad image accepted');
            check(pool.size === 1, 'failed decode leaked a pool entry');
            await pool.load(texture(), url, () => false); check(pool.size === 1, 'stale job acquired an image');

            const nativeFetch = globalThis.fetch;
            let pendingSignal, started, resume;
            const waiting = new Promise(resolve => { started = resolve; });
            globalThis.fetch = (_url, { signal }) => {
                pendingSignal = signal; started();
                return new Promise((resolve, reject) => {
                    resume = () => resolve(new Response(blob));
                    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
                });
            };
            try {
                const d = texture(); const job = pool.load(d, url).catch(error => error.name);
                await waiting; d.dispose();
                check(await job === 'AbortError' && pendingSignal.aborted, 'dispose did not cancel fetch');
                let current = true;
                const e = texture(), stale = pool.load(e, url, () => current);
                current = false; resume(); await stale;
                check(e.image === null && pool.size === 1, 'late generation published an image');
            } finally { globalThis.fetch = nativeFetch; }

            const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
            try {
                Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
                const noHash = texture(); await pool.load(noHash, url);
                check(noHash.image.width === 8 && noHash.source !== a.source && pool.size === 1, 'no-crypto fallback failed');
                noHash.dispose();
            } finally { Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); }
            check([...liveURLs].every(url => urls.includes(url)), 'conversion Blob URL retained after decode/failure');

            const renderer = webgpu ? new (await import('three/webgpu')).WebGPURenderer() : new T.WebGLRenderer();
            if (webgpu) { await renderer.init(); check(renderer.backend.isWebGPUBackend, 'hardware WebGPU required'); }
            renderer.setSize(64, 64);
            const target = webgpu ? new T.RenderTarget(64, 64) : new T.WebGLRenderTarget(64, 64);
            const scene = new T.Scene(), camera = new T.OrthographicCamera(-1, 1, 1, -1, .1, 10);
            camera.position.z = 2;
            const geometry = new T.PlaneGeometry(1, 2), materialA = new T.MeshStandardMaterial({ roughness: .7 }), materialB = materialA.clone();
            const left = new T.Mesh(geometry, materialA), right = new T.Mesh(geometry, materialB);
            left.position.x = -.5; right.position.x = .5; scene.add(left, right, new T.HemisphereLight(0xffffff, 0x223344, 3));
            const light = new T.DirectionalLight(0xffffff, 2); light.position.set(1, 1, 2); scene.add(light);
            const loader = new T.TextureLoader();
            const originalA = await loader.loadAsync(url), originalB = await loader.loadAsync(alias); textures.push(originalA, originalB);
            // Different sampler/upload keys and UV transforms must remain independent
            // even when the renderer can share one Source's compatible GPU storage.
            const render = async (x, y) => {
                materialA.map = x; materialB.map = y; materialA.normalMap = x; materialB.normalMap = y;
                materialA.needsUpdate = materialB.needsUpdate = true;
                renderer.setRenderTarget(target); renderer.render(scene, camera);
                return webgpu ? renderer.readRenderTargetPixelsAsync(target, 0, 0, 64, 64)
                    : renderer.readRenderTargetPixelsAsync(target, 0, 0, 64, 64, new Uint8Array(64 * 64 * 4));
            };
            for (const mixed of [false, true]) {
                for (const t of [a, b, originalA, originalB]) {
                    t.colorSpace = T.SRGBColorSpace; t.flipY = true; t.wrapS = t.wrapT = T.RepeatWrapping;
                    t.repeat.set(1, 1); t.offset.set(0, 0); t.needsUpdate = true;
                }
                if (mixed) for (const t of [b, originalB]) {
                    t.colorSpace = T.LinearSRGBColorSpace; t.flipY = false; t.wrapS = T.ClampToEdgeWrapping;
                    t.repeat.set(2, 3); t.offset.set(.25, .5); t.rotation = .3; t.needsUpdate = true;
                }
                const reference = await render(originalA, originalB), shared = await render(a, b);
                check(reference.every((v, i) => v === shared[i]), `rendered pixels changed (mixed=${mixed})`);
            }
            a.dispose(); check(pool.size === 1 && b.image.width === 8, 'first owner disposed the other image');
            b.dispose(); check(pool.size === 0, 'last owner retained pool entry');
            // Recreate with final settings, isolating retained-image availability
            // from r186's in-place color-space changes (also seen with TextureLoader).
            const restored = b.clone(), referenceRestored = originalB.clone();
            textures.push(restored, referenceRestored);
            const before = await render(referenceRestored, referenceRestored), after = await render(restored, restored);
            check(before.every((v, i) => v === after[i]), 'reupload lost image data');
            for (const t of textures) t.dispose();
            target.dispose(); geometry.dispose(); materialA.dispose(); materialB.dispose(); renderer.dispose();
            urls.forEach(url => URL.revokeObjectURL(url)); canvas.width = canvas.height = 0;
            check(liveURLs.size === 0, 'Blob URL leaked');
            URL.createObjectURL = nativeURL; URL.revokeObjectURL = nativeRevoke;
            return { webgpu, passed: true };
        }, webgpu);
        assert.equal(result.passed, true);
    } finally { await page.close(); }
}
