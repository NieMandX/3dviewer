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
            const nativeCreateElement = document.createElement.bind(document);
            const NativeOffscreenCanvas = globalThis.OffscreenCanvas;
            const conversionCanvases = [];
            const referenceBitmap = await nativeBitmap(blob);
            ctx.clearRect(0, 0, 2, 2);
            ctx.drawImage(referenceBitmap, 0, 0);
            referenceBitmap.close();
            const reference = Array.from(ctx.getImageData(0, 0, 2, 2).data);
            const nativeObjectUrl = URL.createObjectURL.bind(URL);
            const nativeRevokeUrl = URL.revokeObjectURL.bind(URL);
            const temporaryUrls = new Set();
            URL.createObjectURL = blob => {
                const url = nativeObjectUrl(blob);
                temporaryUrls.add(url);
                return url;
            };
            URL.revokeObjectURL = url => {
                temporaryUrls.delete(url);
                nativeRevokeUrl(url);
            };
            document.createElement = function (tag, ...args) {
                const element = nativeCreateElement(tag, ...args);
                if (String(tag).toLowerCase() === 'canvas') conversionCanvases.push(element);
                return element;
            };
            if (NativeOffscreenCanvas) globalThis.OffscreenCanvas = class extends NativeOffscreenCanvas {
                constructor(...args) { super(...args); conversionCanvases.push(this); }
            };
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
            const constantUrls = [];
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
                const pixels = (texture) => {
                    const c = nativeCreateElement('canvas');
                    c.width = c.height = 2;
                    const cx = c.getContext('2d');
                    cx.drawImage(texture.image, 0, 0);
                    const result = Array.from(cx.getImageData(0, 0, 2, 2).data);
                    c.width = c.height = 0;
                    return result;
                };
                const packed = material.roughnessMap;
                const details = {
                    decodes, peak, warnings: warnings.length,
                    reference, packed: pixels(packed), emissive: pixels(material.emissiveMap),
                    shared: packed === material.metalnessMap,
                    noColorSpace: packed.colorSpace === THREE.NoColorSpace,
                    linearEmissive: material.emissiveMap.colorSpace === THREE.LinearSRGBColorSpace,
                    flipY: [packed.flipY, material.emissiveMap.flipY],
                    outputImages: new Set([material.roughnessMap.image, material.metalnessMap.image, material.emissiveMap.image]).size,
                    packedCompressedImage: packed.image instanceof HTMLImageElement && packed.image.complete,
                    pendingConversionUrls: temporaryUrls.size,
                    readbackSurfaces: conversionCanvases.filter(c => c.getContext('2d').getContextAttributes().willReadFrequently)
                        .map(c => [c.width, c.height]),
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
                // Include nonzero constants and a one-pixel difference: this is
                // exact channel compaction, never threshold-based downsampling.
                details.constants = [];
                for (const [red, changedPixel] of [[0, false], [93, false], [255, false], [93, true]]) {
                    canvas.width = 8; canvas.height = 4;
                    const source = ctx.createImageData(8, 4);
                    for (let i = 0; i < source.data.length; i += 4) {
                        source.data.set([red, i % 256, 255 - i % 256, 255], i);
                    }
                    if (changedPixel) source.data[source.data.length - 4]++;
                    ctx.putImageData(source, 0, 0);
                    const fixtureUrl = URL.createObjectURL(await new Promise(resolve => canvas.toBlob(resolve)));
                    constantUrls.push(fixtureUrl);
                    const root = createRoot();
                    await binder.autoBindVPMForModel(root, index(fixtureUrl));
                    const mat = root.children[0].material;
                    const image = mat.emissiveMap.image;
                    const output = Array.from(image.getContext('2d').getImageData(0, 0, image.width, image.height).data);
                    const expected = changedPixel
                        ? Array.from(source.data, (value, i) => i % 4 === 3 ? 255 : source.data[i - i % 4])
                        : [red, red, red, 255];
                    details.constants.push({ red, changedPixel, size: [image.width, image.height], output, expected,
                        packedSize: [mat.roughnessMap.image.width, mat.roughnessMap.image.height],
                        shared: mat.roughnessMap === mat.metalnessMap });
                }
                // A pixel-read failure must not keep its decoded CPU surface or
                // publish a half-built material. The next queued job can recover.
                const faultRoot = createRoot();
                const faultMaterial = faultRoot.children[0].material;
                const readPrototypes = [CanvasRenderingContext2D.prototype];
                if (NativeOffscreenCanvas) readPrototypes.push(OffscreenCanvasRenderingContext2D.prototype);
                const nativeReads = readPrototypes.map(proto => proto.getImageData);
                try {
                    readPrototypes.forEach((proto, i) => { proto.getImageData = function (...args) {
                        if (this.getContextAttributes().willReadFrequently) throw Error('Injected pixel read failure');
                        return nativeReads[i].apply(this, args);
                    }; });
                    await binder.autoBindVPMForModel(faultRoot, index(url));
                } finally { readPrototypes.forEach((proto, i) => { proto.getImageData = nativeReads[i]; }); }
                details.readFailurePreservedMaterial = faultRoot.children[0].material === faultMaterial;
                details.allReadbackReleased = conversionCanvases
                    .filter(c => c.getContext('2d').getContextAttributes().willReadFrequently)
                    .every(c => c.width === 0 && c.height === 0);
                await binder.autoBindVPMForModel(faultRoot, index(url));
                details.readFailureRecovered = !!faultRoot.children[0].material.roughnessMap;
                const beforeDecodeFailure = faultRoot.children[0].material;
                const urlsBeforeFailure = temporaryUrls.size;
                const nativeToBlob = HTMLCanvasElement.prototype.toBlob;
                const nativeConvert = globalThis.OffscreenCanvas?.prototype.convertToBlob;
                try {
                    HTMLCanvasElement.prototype.toBlob = callback => callback(new Blob(['invalid packed PNG'], { type: 'image/png' }));
                    if (nativeConvert) OffscreenCanvas.prototype.convertToBlob = async () => new Blob(['invalid packed PNG'], { type: 'image/png' });
                    await binder.autoBindVPMForModel(faultRoot, index(url));
                } finally {
                    HTMLCanvasElement.prototype.toBlob = nativeToBlob;
                    if (nativeConvert) OffscreenCanvas.prototype.convertToBlob = nativeConvert;
                }
                details.decodeFailurePreservedMaterial = faultRoot.children[0].material === beforeDecodeFailure;
                details.decodeFailureUrlReleased = temporaryUrls.size === urlsBeforeFailure;
                return details;
            } finally {
                releaseFirst?.();
                globalThis.createImageBitmap = nativeBitmap;
                document.createElement = nativeCreateElement;
                globalThis.OffscreenCanvas = NativeOffscreenCanvas;
                for (const root of roots) {
                    root.children[0].geometry.dispose();
                    disposeUnusedMaterialTree(root.children[0].material);
                }
                URL.revokeObjectURL(url); URL.revokeObjectURL(badUrl);
                constantUrls.forEach(url => URL.revokeObjectURL(url));
                URL.createObjectURL = nativeObjectUrl;
                URL.revokeObjectURL = nativeRevokeUrl;
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
        assert.equal(result.packedCompressedImage, true, 'ERM retained a full-resolution canvas as the packed texture');
        assert.equal(result.pendingConversionUrls, 0, 'ERM retained a conversion Blob URL after image decode');
        assert.equal(result.readbackSurfaces.length, 2, 'ERM readback cleanup was not exercised');
        assert.ok(result.readbackSurfaces.every(([w, h]) => w === 0 && h === 0), 'ERM retained a temporary readback bitmap');
        assert.equal(result.readFailurePreservedMaterial, true, 'ERM read failure published a partial material');
        assert.equal(result.allReadbackReleased, true, 'ERM read failure retained a temporary CPU bitmap');
        assert.equal(result.readFailureRecovered, true, 'ERM queue failed to recover from pixel read failure');
        assert.equal(result.decodeFailurePreservedMaterial, true, 'ERM decode failure replaced the current material');
        assert.equal(result.decodeFailureUrlReleased, true, 'ERM decode failure leaked a conversion Blob URL');
        assert.equal(result.disposedWithMetalnessUser, 0, 'Replacing roughness disposed the active metalness map');
        assert.equal(result.disposedWithoutUsers, 1, 'Unused packed texture was not disposed exactly once');
        const packed = result.reference.map((value, i) => i % 4 === 3 ? 255 : value);
        const emissive = result.reference.map((value, i, src) => i % 4 === 3 ? 255 : src[i - i % 4]);
        assert.deepEqual(result.packed, packed, 'ERM packed channels/orientation changed');
        assert.deepEqual(result.emissive, emissive, 'ERM emissive intensity/orientation changed');
        for (const fixture of result.constants) {
            assert.deepEqual(fixture.size, fixture.changedPixel ? [8, 4] : [1, 1], 'Constant-channel detection changed spatial detail');
            assert.deepEqual(fixture.output, fixture.expected, 'Constant-channel value changed');
            assert.deepEqual(fixture.packedSize, [8, 4], 'Packed roughness/metalness resolution changed');
            assert.equal(fixture.shared, true);
        }
    } finally { await page.close(); }
}
