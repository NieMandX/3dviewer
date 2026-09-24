import assert from 'node:assert/strict';

export async function runDepthPrioritySmoke(browser, baseUrl) {
    const page = await browser.newPage();
    try {
        await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded' });
        const result = await page.evaluate(async () => {
            const T = await import('three');
            const { createMaterialsPanelController } = await import('/scripts/modules/ui/materials-panel.js');
            const { createRenderer } = await import('/scripts/modules/render/renderer-init.js');
            const { installDepthBiasCacheFix } = await import('/scripts/modules/render/depth-bias-cache.js');
            const { getDepthPriority, setDepthPriority } = await import('/scripts/modules/material/depth-priority.js');
            const rendererOwner = createRenderer({ THREE: T });
            const renderer = rendererOwner.renderer;
            renderer.setPixelRatio(1);
            renderer.setSize(128, 128);
            const scene = new T.Scene();
            const world = new T.Group();
            scene.add(world);
            const camera = new T.PerspectiveCamera(60, 1, 0.05, 10000);
            camera.position.z = 3;
            const geometry = new T.PlaneGeometry(2, 2);
            const red = new T.MeshBasicMaterial({ color: 0xff0000 });
            const blue = new T.MeshBasicMaterial({ color: 0x0000ff });
            const green = new T.MeshBasicMaterial({ color: 0x00ff00 });
            const backend = {
                isWebGPUBackend: true,
                getRenderCacheKey() { return 'same-shader-and-render-state'; },
                needsRenderUpdate() { return false; },
            };
            const originalKeyMethod = backend.getRenderCacheKey;
            const originalUpdateMethod = backend.needsRenderUpdate;
            const restoreBackend = installDepthBiasCacheFix({ backend });
            const renderObject = { material: red };
            backend.needsRenderUpdate(renderObject);
            const stableCache = !backend.needsRenderUpdate(renderObject);
            const noBiasKey = backend.getRenderCacheKey(renderObject);
            setDepthPriority(red, 1);
            const distinctCache = noBiasKey !== backend.getRenderCacheKey(renderObject);
            const changedCache = backend.needsRenderUpdate(renderObject);
            setDepthPriority(red, 0);
            const resetCache = backend.needsRenderUpdate(renderObject)
                && noBiasKey === backend.getRenderCacheKey(renderObject);
            restoreBackend();
            const backendRestored = backend.getRenderCacheKey === originalKeyMethod
                && backend.needsRenderUpdate === originalUpdateMethod;
            const front = new T.Mesh(geometry, red);
            const coincident = new T.Mesh(geometry, blue);
            const shared = new T.Mesh(geometry, red);
            const occluder = new T.Mesh(geometry, green);
            coincident.renderOrder = 1;
            shared.position.x = 10;
            occluder.position.set(0.55, 0, 0.4);
            occluder.scale.setScalar(0.15);
            world.add(front, coincident, shared, occluder);
            const loadedModels = [{ obj: world, name: 'overlapping-surfaces.glb' }];
            const outEl = document.createElement('div');
            document.body.append(outEl);
            let renderRequests = 0;
            const panel = createMaterialsPanelController({
                world, loadedModels, outEl,
                requestRender: () => { renderRequests += 1; },
            });
            panel.renderMaterialsPanel();
            const control = outEl.querySelector(`[data-uuid="${front.uuid}"].depth-priority-input`);
            const sharedControl = outEl.querySelector(`[data-uuid="${shared.uuid}"].depth-priority-input`);
            const read = (x = 64) => {
                renderer.render(scene, camera);
                const pixel = new Uint8Array(4);
                const gl = renderer.getContext();
                gl.readPixels(x, 64, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
                return Array.from(pixel);
            };
            const change = value => {
                control.value = String(value);
                control.dispatchEvent(new Event('change', { bubbles: true }));
            };
            const baseline = read();
            change(1);
            const preferred = read();
            const occluded = read(87);
            const synced = sharedControl.value;
            const geometryUnchanged = front.geometry === geometry && front.position.length() === 0;
            const depthUnchanged = red.depthTest && red.depthWrite && front.renderOrder === 0;
            change(-1);
            const behind = read();
            change(0);
            const reset = read();
            const resetDisabled = !red.polygonOffset && getDepthPriority(red) === 0;

            // Zero must restore a pre-existing imported offset, not erase it.
            blue.polygonOffset = true;
            blue.polygonOffsetFactor = 0.5;
            blue.polygonOffsetUnits = 2;
            setDepthPriority(blue, 2);
            setDepthPriority(blue, 0);
            const baselineRestored = [blue.polygonOffset, blue.polygonOffsetFactor, blue.polygonOffsetUnits];

            // Editing while a diagnostic shading variant is visible changes the
            // original PBR material and leaves that temporary variant untouched.
            const variant = new T.MeshBasicMaterial();
            variant.userData.viewerGeneratedMaterial = 'shading-variant';
            front.userData._origMaterial = red;
            front.material = variant;
            change(2);
            const originalEdited = getDepthPriority(red) === 2 && !variant.polygonOffset;
            front.material = red;
            const afterModeReturn = read();
            change(0);
            loadedModels.length = 0;
            const requestsBeforeStale = renderRequests;
            change(3);
            const staleIgnored = getDepthPriority(red) === 0 && renderRequests === requestsBeforeStale;
            panel.dispose();
            change(4);
            const disposedIgnored = getDepthPriority(red) === 0 && renderRequests === requestsBeforeStale;
            rendererOwner.dispose();
            geometry.dispose();
            [red, blue, green, variant].forEach(m => m.dispose());
            outEl.remove();
            return { baseline, preferred, occluded, behind, reset, afterModeReturn,
                synced, geometryUnchanged, depthUnchanged, resetDisabled,
                baselineRestored, originalEdited, staleIgnored, disposedIgnored,
                stableCache, distinctCache, changedCache, resetCache, backendRestored };
        });
        const rgb = values => values.slice(0, 3);
        assert.deepEqual(rgb(result.baseline), [0, 0, 255], 'Coincident surface fixture must initially show blue');
        assert.deepEqual(rgb(result.preferred), [255, 0, 0], 'Positive material priority must make red win the depth test');
        assert.deepEqual(rgb(result.occluded), [0, 255, 0], 'Material priority must not draw through a foreground surface');
        assert.deepEqual(rgb(result.behind), [0, 0, 255], 'Negative priority must move red behind blue');
        assert.deepEqual(rgb(result.reset), [0, 0, 255], 'Zero priority must restore original rendering');
        assert.deepEqual(rgb(result.afterModeReturn), [255, 0, 0], 'Priority must survive returning to the original material');
        assert.equal(result.synced, '1', 'Controls sharing a material must remain synchronized');
        assert.deepEqual(result.baselineRestored, [true, 0.5, 2], 'Reset must preserve imported offsets');
        for (const key of ['geometryUnchanged', 'depthUnchanged', 'resetDisabled', 'originalEdited', 'staleIgnored', 'disposedIgnored',
            'stableCache', 'distinctCache', 'changedCache', 'resetCache', 'backendRestored']) {
            assert.equal(result[key], true, `Depth priority: ${key}`);
        }
    } finally {
        await page.close();
    }
}
