import assert from 'node:assert/strict';

// Real browser canvas/bitmap conversion, queue cancellation and shared-slot lifetime.
export async function runVPMMemorySmoke(browser, baseUrl) {
    const page = await browser.newPage();
    try {
        await page.goto(`${baseUrl}/__smoke_blank`);
        const result = await page.evaluate(async () => {
            const THREE = await import('three');
            const { createVPMBinder } = await import('/scripts/modules/material/vpm-autobind.js');
            const { disposeUnusedMaterialTree } = await import('/scripts/modules/material/texture-utils.js');
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 2;
            const ctx = canvas.getContext('2d');
            ctx.putImageData(new ImageData(new Uint8ClampedArray([
                24, 80, 160, 255, 160, 224, 40, 63,
                200, 8, 96, 255, 72, 144, 248, 255,
            ]), 2, 2), 0, 0);
            const blob = await new Promise((resolve) => canvas.toBlob(resolve));
            const url = URL.createObjectURL(blob);
            const badUrl = URL.createObjectURL(new Blob(['invalid image']));
            const nativeBitmap = globalThis.createImageBitmap;
            const referenceBitmap = await nativeBitmap(blob);
            ctx.clearRect(0, 0, 2, 2);
            ctx.drawImage(referenceBitmap, 0, 0);
            referenceBitmap.close();
            const reference = Array.from(ctx.getImageData(0, 0, 2, 2).data);
            let decodes = 0, active = 0, peak = 0;
            let releaseFirst;
            globalThis.createImageBitmap = async (...args) => {
                decodes += 1;
                active += 1;
                peak = Math.max(peak, active);
                try {
                    if (decodes === 1) await new Promise((resolve) => { releaseFirst = resolve; });
                    return await nativeBitmap(...args);
                } finally { active -= 1; }
            };
            const models = [];
            const roots = [];
            const warnings = [];
            const binder = createVPMBinder({
                THREE, loadedModels: models,
                labelFromURL: () => 'T_test_case_ERM_1.1001.png',
                logBind: (text, level) => { if (level === 'warn') warnings.push(text); },
            });
            function createRoot() {
                const root = new THREE.Group();
                root.userData._fbxFileName = 'SM_test_case.fbx';
                const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial());
                root.add(mesh); roots.push(root); models.push({ obj: root });
                return root;
            }
            const index = (image) => new Map([['test_case', new Map([['1.1001', { ERM: image }]])]]);
            try {
                const first = createRoot();
                const skipped = createRoot();
                const failed = createRoot();
                const last = createRoot();
                const skippedMaterial = skipped.children[0].material;
                const failedMaterial = failed.children[0].material;
                const jobs = [
                    binder.autoBindVPMForModel(first, index(url)),
                    binder.autoBindVPMForModel(skipped, index(url)),
                    binder.autoBindVPMForModel(failed, index(badUrl)),
                    binder.autoBindVPMForModel(last, index(url)),
                ];
                for (let i = 0; i < 100 && !releaseFirst; i++) await new Promise((r) => setTimeout(r, 5));
                if (!releaseFirst) throw Error('ERM decode did not start');
                // Allow other jobs to reach their decoders if serialization regresses.
                await new Promise((r) => setTimeout(r, 30));
                models.splice(models.findIndex((m) => m.obj === skipped), 1);
                releaseFirst();
                await Promise.all(jobs);
                const material = first.children[0].material;
                const pixels = (texture) => Array.from(texture.image.getContext('2d').getImageData(0, 0, 2, 2).data);
                const packed = material.roughnessMap;
                const details = {
                    decodes, peak, warnings: warnings.length,
                    reference, packed: pixels(packed), emissive: pixels(material.emissiveMap),
                    shared: packed === material.metalnessMap,
                    noColorSpace: packed.colorSpace === THREE.NoColorSpace,
                    linearEmissive: material.emissiveMap.colorSpace === THREE.LinearSRGBColorSpace,
                    flipY: [packed.flipY, material.emissiveMap.flipY],
                    outputImages: new Set([material.roughnessMap.image, material.metalnessMap.image, material.emissiveMap.image]).size,
                    skipped: skipped.children[0].material === skippedMaterial,
                    failed: failed.children[0].material === failedMaterial,
                    recovered: !!last.children[0].material.emissiveMap,
                };
                let packedDisposed = 0;
                packed.addEventListener('dispose', () => { packedDisposed++; });
                const edited = material.clone();
                edited.roughnessMap = null;
                first.children[0].material = edited;
                disposeUnusedMaterialTree(material, { root: first });
                details.disposedWithMetalnessUser = packedDisposed;
                const editedAgain = edited.clone();
                editedAgain.metalnessMap = null;
                first.children[0].material = editedAgain;
                disposeUnusedMaterialTree(edited, { root: first });
                details.disposedWithoutUsers = packedDisposed;
                return details;
            } finally {
                releaseFirst?.();
                globalThis.createImageBitmap = nativeBitmap;
                for (const root of roots) {
                    root.children[0].geometry.dispose();
                    disposeUnusedMaterialTree(root.children[0].material);
                }
                URL.revokeObjectURL(url); URL.revokeObjectURL(badUrl);
            }
        });
        assert.equal(result.peak, 1, 'ERM decodes overlapped across concurrent model binds');
        assert.equal(result.decodes, 3, 'Stale queued bind decoded an image');
        assert.equal(result.warnings, 1, 'Failed image did not report exactly one warning');
        for (const key of ['shared', 'noColorSpace', 'linearEmissive', 'skipped', 'failed', 'recovered']) {
            assert.equal(result[key], true, `ERM ${key} contract failed`);
        }
        assert.deepEqual(result.flipY, [false, false]);
        assert.equal(result.outputImages, 2, 'ERM retained redundant channel images');
        assert.equal(result.disposedWithMetalnessUser, 0, 'Replacing roughness disposed the active metalness map');
        assert.equal(result.disposedWithoutUsers, 1, 'Unused packed texture was not disposed exactly once');
        const packed = result.reference.map((value, i) => i % 4 === 3 ? 255 : value);
        const emissive = result.reference.map((value, i, src) => i % 4 === 3 ? 255 : src[i - i % 4]);
        assert.deepEqual(result.packed, packed, 'ERM packed channels/orientation changed');
        assert.deepEqual(result.emissive, emissive, 'ERM emissive intensity/orientation changed');
    } finally { await page.close(); }
}
