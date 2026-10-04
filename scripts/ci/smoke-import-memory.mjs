import assert from 'node:assert/strict';

export async function runImportMemorySmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
        await page.goto(`${baseUrl}/__smoke_blank`);
        const geometry = await page.evaluate(async () => {
            const THREE = await import('three');
            const { splitMeshByUDIM } = await import('/scripts/modules/fbx/udim-split.js');
            const positions = [0, 0, 0, 2, 0, 0, 0, 2, 0, 4, 0, 0, 6, 0, 0, 4, 2, 0];
            const uv = [.1, .1, .8, .1, .1, .8, 1.1, .1, 1.8, .1, 1.1, .8];
            const outcomes = [];
            for (const indexed of [false, true]) {
                const g = new THREE.BufferGeometry();
                g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
                g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
                if (indexed) g.setIndex([0, 1, 2, 3, 4, 5, 0, 1, 2]);
                g.computeVertexNormals();
                const originalUV = g.attributes.uv.array;
                const mat = new THREE.MeshStandardMaterial();
                const mesh = new THREE.Mesh(g, mat);
                mesh.name = 'SM_fixture'; mesh.userData.sourceFBXModelId = '12345';
                mesh.position.set(9, 8, 7); mesh.castShadow = mesh.receiveShadow = true;
                const root = new THREE.Group(); const before = new THREE.Group(), after = new THREE.Group();
                root.add(before, mesh, after);
                g.clone = g.toNonIndexed = () => { throw Error('UDIM allocated a full geometry copy'); };
                const didSplit = splitMeshByUDIM(mesh);
                const holder = root.children[1];
                const children = holder.children.map((tile) => tile.children[0]);
                outcomes.push({ indexed, didSplit,
                    order: root.children[0] === before && root.children[2] === after,
                    transform: holder.position.toArray(),
                    tiles: children.map((child) => ({
                        tile: child.userData.udim, source: child.userData.sourceFBXModelId,
                        pos: Array.from(child.geometry.attributes.position.array),
                        uv: Array.from(child.geometry.attributes.uv.array),
                        shadows: child.castShadow && child.receiveShadow,
                    })),
                    expectedUV: [Array.from(originalUV.slice(0, 6)), Array.from(originalUV.slice(6)).map((v, i) => i % 2 ? v : Math.fround(v - 1))],
                });
                for (const child of children) { child.geometry.dispose(); child.material.dispose(); }
                mat.dispose();
            }
            const g = new THREE.PlaneGeometry(); const material = new THREE.MeshStandardMaterial();
            const mesh = new THREE.Mesh(g, material), root = new THREE.Group(); root.add(mesh);
            const pos = g.attributes.position, uvAttr = g.attributes.uv, index = g.index;
            g.clone = g.toNonIndexed = () => { throw Error('No-op UDIM copied geometry'); };
            const unchanged = !splitMeshByUDIM(mesh) && mesh.geometry === g && mesh.material === material
                && g.attributes.position === pos && g.attributes.uv === uvAttr && g.index === index;
            g.dispose(); material.dispose();
            return { outcomes, unchanged };
        });
        assert.equal(geometry.unchanged, true, 'One-tile geometry must retain original buffers');
        for (const r of geometry.outcomes) {
            assert.equal(r.didSplit && r.order, true);
            assert.deepEqual(r.transform, [9, 8, 7]);
            assert.deepEqual(r.tiles.map((t) => t.tile), [1001, 1002]);
            const first = [0, 0, 0, 2, 0, 0, 0, 2, 0];
            assert.deepEqual(r.tiles[0].pos, r.indexed ? [...first, ...first] : first);
            assert.deepEqual(r.tiles[1].pos, [4, 0, 0, 6, 0, 0, 4, 2, 0]);
            assert.deepEqual(r.tiles[0].uv, r.indexed ? [...r.expectedUV[0], ...r.expectedUV[0]] : r.expectedUV[0]);
            assert.deepEqual(r.tiles[1].uv, r.expectedUV[1]);
            assert.ok(r.tiles.every((t) => t.source === '12345' && t.shadows));
        }
        const gallery = await page.evaluate(async () => {
            const { createTextureGalleryController } = await import('/scripts/modules/ui/texture-gallery.js');
            const nativeIO = globalThis.IntersectionObserver;
            const nativeBitmap = globalThis.createImageBitmap;
            const source = document.createElement('canvas'); source.width = 2048; source.height = 1024;
            source.getContext('2d').fillStyle = '#c02040'; source.getContext('2d').fillRect(0, 0, 2048, 1024);
            const url = source.toDataURL(); source.width = source.height = 0;
            const gallery = document.createElement('div'); document.body.append(gallery);
            gallery.style.cssText = 'width:300px;height:200px;overflow:auto';
            let notify, observed = new Set(), decodes = 0, active = 0, peak = 0, closed = 0, release;
            globalThis.IntersectionObserver = class {
                constructor(fn) { notify = fn; }
                observe(el) { observed.add(el); }
                unobserve(el) { observed.delete(el); }
                disconnect() { observed.clear(); }
            };
            const visible = () => notify([...observed].map((target) => ({ target, isIntersecting: true })));
            const waitFor = async (fn) => {
                for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 5)); }
                throw Error('Thumbnail test timeout');
            };
            globalThis.createImageBitmap = async (...args) => {
                decodes++; active++; peak = Math.max(peak, active);
                const bitmap = await nativeBitmap(...args);
                const close = bitmap.close.bind(bitmap);
                bitmap.close = () => { closed++; close(); };
                if (decodes === 1) await new Promise((r) => { release = r; });
                active--; return bitmap;
            };
            const opened = [];
            const controller = createTextureGalleryController({ galleryEl: gallery, onOpen: (entry) => opened.push(entry) });
            try {
                const old = { short: 'old', url }; controller.render([old]);
                await new Promise((r) => setTimeout(r, 20)); const lazy = decodes === 0;
                const staleThumb = gallery.querySelector('.thumb'), staleCanvas = gallery.querySelector('canvas');
                visible(); await waitFor(() => release);
                controller.reset();
                const entries = Array.from({ length: 4 }, (_, i) => ({ short: `new ${i}`, url }));
                controller.render(entries); visible();
                release();
                await waitFor(() => [...gallery.querySelectorAll('canvas')].every((c) => c.width === 256));
                staleThumb.click(); gallery.querySelector('.thumb').click();
                const canvases = [...gallery.querySelectorAll('canvas')];
                const dimensions = canvases.map((c) => [c.width, c.height]);
                const pixel = Array.from(canvases[0].getContext('2d').getImageData(100, 50, 1, 1).data);
                const serial = { decodes, peak, closed };
                // Decode failure must release the queue and leave other entries usable.
                controller.render([{ short: 'broken', url: 'data:image/png;base64,AA==' }, { short: 'good', url }]);
                visible(); await waitFor(() => gallery.querySelector('.broken') && gallery.querySelector('canvas')?.width === 256);
                const recovered = !!gallery.querySelector('.broken .ph');
                globalThis.createImageBitmap = undefined;
                controller.render([{ short: 'fallback', url }]); visible();
                await waitFor(() => gallery.querySelector('canvas')?.width === 256);
                const fallback = gallery.querySelector('canvas').height === 128;
                const lastCanvas = gallery.querySelector('canvas'); controller.dispose();
                const cleared = [...canvases, staleCanvas, lastCanvas].every((c) => c.width === 0 && c.height === 0);
                globalThis.IntersectionObserver = nativeIO;
                globalThis.createImageBitmap = async (...args) => { decodes++; return nativeBitmap(...args); };
                const live = createTextureGalleryController({ galleryEl: gallery });
                gallery.style.display = 'none'; const beforeHidden = decodes;
                live.render([{ short: 'hidden', url }]); await new Promise((r) => setTimeout(r, 60));
                const hiddenSkipped = beforeHidden === decodes;
                gallery.style.display = 'block';
                await waitFor(() => gallery.querySelector('canvas')?.width === 256);
                live.dispose();
                return { lazy, dimensions, pixel, serial, staleWidth: staleCanvas.width,
                    originalOpened: opened.length === 1 && opened[0] === entries[0], recovered, fallback, cleared, hiddenSkipped };
            } finally {
                release?.(); controller.dispose(); gallery.remove();
                globalThis.IntersectionObserver = nativeIO; globalThis.createImageBitmap = nativeBitmap;
            }
        });
        assert.equal(gallery.lazy && gallery.hiddenSkipped, true, 'Hidden previews must not decode');
        assert.deepEqual(gallery.dimensions, Array(4).fill([256, 128]));
        assert.deepEqual(gallery.pixel, [192, 32, 64, 255]);
        assert.deepEqual(gallery.serial, { decodes: 5, peak: 1, closed: 5 }, 'Thumbnail decode or stale bitmap leaked');
        assert.equal(gallery.staleWidth, 0);
        assert.ok(gallery.originalOpened && gallery.recovered && gallery.fallback && gallery.cleared);
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
}
