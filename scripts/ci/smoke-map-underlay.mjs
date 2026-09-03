import assert from 'node:assert/strict';

export async function runMapUnderlaySmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
        await page.goto(`${baseUrl}/__smoke_blank`);
        const result = await page.evaluate(async () => {
            const THREE = await import('three');
            const { loadMapCoordinateSystem } = await import('/scripts/modules/geo/map-coordinates.js');
            const { createMapReferenceController } = await import('/scripts/modules/scene/map-reference.js');
            const { createMapUnderlayController, createMapUnderlayGeometry } = await import('/scripts/modules/scene/map-underlay.js');
            const { createShadingController } = await import('/scripts/modules/render/shading-controller.js');
            const system = await loadMapCoordinateSystem();
            const world = new THREE.Group();
            const model = new THREE.Mesh(new THREE.BoxGeometry(100, 300, 140), new THREE.MeshBasicMaterial());
            model.position.set(2322.804985, 276, -9741.543739);
            world.add(model);
            world.position.set(-2322.804985, 0, 9741.543739);
            const reference = createMapReferenceController({ THREE, world, getModels: () => [{ obj: model }], isZUp: () => false });
            const tile = document.createElement('canvas');
            tile.width = tile.height = 256;
            const ctx = tile.getContext('2d');
            ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 256, 128);
            ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 128, 256, 128);
            const blob = await new Promise((resolve) => tile.toBlob(resolve));
            let requests = 0, closed = 0, inFlight = 0, maxInFlight = 0, frames = 0;
            const states = [];
            const config = { THREE, world, mapReference: reference, isZUp: () => false,
                apiBaseUrl: 'https://gis-proxy.example',
                loadCoordinateSystem: async () => system,
                requestRender: () => frames++, onChange: (state) => states.push(state),
                fetchImpl: async (url, options) => {
                    if (url.origin !== 'https://gis-proxy.example' || !url.pathname.startsWith('/v1/2gis/tiles/')
                        || options.credentials !== 'omit') throw new Error('unsafe endpoint');
                    requests++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
                    await new Promise((resolve) => setTimeout(resolve, 1));
                    inFlight--;
                    return new Response(blob, { headers: { 'Content-Type': 'image/png' } });
                },
                decodeImage: async (data) => {
                    const bitmap = await createImageBitmap(data);
                    const close = bitmap.close.bind(bitmap);
                    bitmap.close = () => { closed++; close(); };
                    return bitmap;
                },
            };
            const controller = createMapUnderlayController(config);
            const missingService = createMapUnderlayController({ ...config, apiBaseUrl: '' });
            const noService = await missingService.enable();
            const noServiceState = missingService.getState();
            missingService.dispose();
            const before = reference.getModelBounds();
            const enabled = await controller.enable();
            const layer = world.children.find((child) => child.userData.mapUnderlay);
            const boundsUnchanged = JSON.stringify(before) === JSON.stringify(reference.getModelBounds());
            const initialRequests = requests;
            const initialClosed = closed;
            const position = layer.position.toArray();
            const geom = layer.geometry, tex = layer.material.map, mat = layer.material;
            const vertices = geom.attributes.position;
            let radius = 0, validUVs = true;
            const northV = geom.attributes.uv.getY(1 + 7 * 128 + 32);
            const southV = geom.attributes.uv.getY(1 + 7 * 128 + 96);
            for (let i = 0; i < vertices.count; i++) {
                radius = Math.max(radius, Math.hypot(vertices.getX(i), vertices.getZ(i)));
                const uv = geom.attributes.uv;
                validUVs &&= uv.getX(i) >= 0 && uv.getX(i) <= 1 && uv.getY(i) >= 0 && uv.getY(i) <= 1;
            }
            const canvas = tex.image;
            const topPixel = Array.from(canvas.getContext('2d').getImageData(10, 10, 1, 1).data);
            const bottomPixel = Array.from(canvas.getContext('2d').getImageData(10, 200, 1, 1).data);
            controller.setOpacity(0.4);
            const materialOpacity = mat.opacity;
            const opacityRequests = requests - initialRequests;
            const scene = new THREE.Scene(); scene.add(world);
            const shading = createShadingController({ THREE, world, scene, requestRender: () => {},
                schedulePanelRefresh: () => {}, applyEnvToMaterials: () => {}, applyGlassControlsToScene: () => {},
                getEnvIntensity: () => 1, setBackfaceMode: () => {} });
            for (const mode of ['uv', 'color', 'matcap', 'beautywire', 'pbr']) shading.applyShading(mode);
            const preserved = layer.material === mat;
            const renderer = new THREE.WebGLRenderer({ antialias: false });
            renderer.setSize(128, 128);
            const camera = new THREE.PerspectiveCamera(60, 1, 1, 3000);
            camera.position.set(0, 1100, 0); camera.up.set(0, 0, -1); camera.lookAt(0, 126, 0);
            const target = new THREE.WebGLRenderTarget(128, 128);
            renderer.setRenderTarget(target); renderer.render(scene, camera);
            const pixels = new Uint8Array(128 * 128 * 4);
            renderer.readRenderTargetPixels(target, 0, 0, 128, 128, pixels);
            let coloredPixels = 0;
            for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 20 || pixels[i + 2] > 20) coloredPixels++;
            target.dispose(); renderer.dispose(); shading.dispose();
            const disposedResources = { geometry: 0, texture: 0, material: 0 };
            geom.addEventListener('dispose', () => disposedResources.geometry++);
            tex.addEventListener('dispose', () => disposedResources.texture++);
            mat.addEventListener('dispose', () => disposedResources.material++);
            controller.disable(); controller.disable(); controller.dispose();
            const afterDisposeFrames = frames;
            const lateEnable = await controller.enable();
            const silenceAfterDispose = frames === afterDisposeFrames;

            let resumeDecode;
            const gate = new Promise((resolve) => { resumeDecode = resolve; });
            let decodes = 0, lateClosed = 0;
            const pendingController = createMapUnderlayController({ ...config, decodeImage: async () => {
                decodes++;
                await gate;
                return { width: 256, height: 256, close: () => lateClosed++ };
            } });
            const pending = pendingController.enable();
            while (!decodes) await new Promise((resolve) => setTimeout(resolve, 1));
            pendingController.disable(); resumeDecode();
            const cancelled = await pending;
            pendingController.dispose();

            const failController = createMapUnderlayController({ ...config, fetchImpl: async () => new Response('', { status: 403 }) });
            const forbidden = await failController.enable();
            const forbiddenState = failController.getState(); failController.dispose();
            const timeoutController = createMapUnderlayController({ ...config, timeoutMs: 5,
                fetchImpl: (_, { signal }) => new Promise((resolve, reject) => {
                    signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
                }) });
            await timeoutController.enable();
            const timeoutState = timeoutController.getState(); timeoutController.dispose();
            const staleController = createMapUnderlayController({ ...config,
                fetchImpl: async (...args) => { model.position.x += 1; return config.fetchImpl(...args); } });
            const stale = await staleController.enable();
            const staleState = staleController.getState(); staleController.dispose();
            const area = system.getMapArea(before.center);
            const zGeometry = createMapUnderlayGeometry(THREE, system, area, true);
            const normalZ = zGeometry.attributes.normal.getZ(0); zGeometry.dispose();
            const remainingLayers = world.children.filter((child) => child.userData.mapUnderlay).length;
            reference.dispose(); model.geometry.dispose(); model.material.dispose();
            return { noService, noServiceState, enabled, boundsUnchanged, initialRequests, initialClosed, northV, southV, opacityRequests, materialOpacity,
                position, radius, validUVs, topPixel, bottomPixel, maxInFlight, preserved, coloredPixels,
                disposedResources, canvasReleased: canvas.width === 1, lateEnable, silenceAfterDispose,
                cancelled, decodes, lateClosed, forbidden, forbiddenState, timeoutState, stale, staleState,
                normalZ, remainingLayers };
        });
        assert.equal(result.noService, false);
        assert.match(result.noServiceState.message, /Сервис 2ГИС/);
        assert.equal(result.enabled, true);
        assert.equal(result.boundsUnchanged, true);
        assert.equal(result.initialRequests, 49);
        assert.equal(result.initialClosed, 49);
        assert.ok(result.northV > result.southV, 'North must map to the top of the atlas');
        assert.equal(result.opacityRequests, 0);
        assert.equal(result.materialOpacity, 0.4);
        assert.ok(Math.abs(result.position[1] - 125.8) < 0.001);
        assert.ok(Math.abs(result.radius - 500) < 0.001);
        assert.equal(result.validUVs, true);
        assert.deepEqual(result.topPixel, [255, 0, 0, 255]);
        assert.deepEqual(result.bottomPixel, [0, 0, 255, 255]);
        assert.ok(result.maxInFlight <= 4);
        assert.equal(result.preserved, true);
        assert.ok(result.coloredPixels > 1000, `Blank map render: ${result.coloredPixels}`);
        assert.deepEqual(result.disposedResources, { geometry: 1, texture: 1, material: 1 });
        assert.equal(result.canvasReleased, true);
        assert.equal(result.lateEnable, false);
        assert.equal(result.silenceAfterDispose, true);
        assert.equal(result.cancelled, false);
        assert.equal(result.decodes, result.lateClosed);
        assert.equal(result.forbidden, false);
        assert.match(result.forbiddenState.message, /сервер отклонил запрос/);
        assert.match(result.timeoutState.message, /минуту/);
        assert.equal(result.stale, false);
        assert.match(result.staleState.message, /Модель изменилась/);
        assert.ok(result.normalZ > 0.99);
        assert.equal(result.remainingLayers, 0);
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
}

export async function runMapUnderlayUISmoke(browser, baseUrl) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let requests = 0;
    try {
        await page.goto(`${baseUrl}/?renderer=webgl`);
        await page.waitForFunction(() => globalThis.viewerApp && !document.body.classList.contains('app-loading'));
        await page.locator('#toggleSideBtn').click();
        await page.locator('#mapUnderlayDetails > summary').click();
        await page.locator('#mapUnderlayToggle').click();
        await page.waitForFunction(() => !viewerApp.mapUnderlay.getState().loading);
        assert.match(await page.locator('#mapUnderlayStatus').textContent(), /Сначала загрузите модель/);
        const png = await page.evaluate(async () => {
            const THREE = await import('three');
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(100, 100, 100), new THREE.MeshBasicMaterial());
            mesh.position.set(2322.805, 176, -9741.544);
            viewerApp.world.add(mesh);
            viewerApp.loadedModels.push({ obj: mesh, name: 'map smoke' });
            viewerApp.world.position.set(-2322.805, 0, 9741.544);
            viewerApp.camera.position.set(800, 1000, 800);
            viewerApp.controls.target.set(0, 126, 0);
            viewerApp.controls.update();
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 256;
            canvas.getContext('2d').fillRect(0, 0, 256, 256);
            return canvas.toDataURL().split(',')[1];
        });
        await page.route('https://voice-api.agr.vision/v1/2gis/tiles/**', async (route) => {
            requests++;
            await route.fulfill({ status: 200, contentType: 'image/png',
                headers: { 'access-control-allow-origin': '*' }, body: Buffer.from(png, 'base64') });
        });
        await page.locator('#mapUnderlayToggle').check();
        await page.waitForFunction(() => viewerApp.mapUnderlay.getState().enabled && !viewerApp.mapUnderlay.getState().loading);
        const count = requests;
        assert.equal(await page.locator('#mapUnderlayAttribution').isVisible(), true);
        await page.locator('#toggleSideBtn').click();
        const cameraBefore = await page.evaluate(() => viewerApp.camera.position.toArray());
        await page.mouse.move(420, 300);
        await page.mouse.down();
        await page.mouse.move(620, 370, { steps: 12 });
        await page.mouse.up();
        const cameraAfter = await page.evaluate(() => viewerApp.camera.position.toArray());
        assert.notDeepEqual(cameraAfter, cameraBefore, 'Orbit must still work with the underlay');
        assert.equal(requests, count, 'Orbit must not download more tiles');
        await page.locator('#toggleSideBtn').click();
        await page.locator('#mapUnderlayOpacity').focus();
        await page.locator('#mapUnderlayOpacity').press('Home');
        await page.locator('#mapUnderlayOpacity').press('ArrowRight');
        assert.equal(await page.locator('#mapUnderlayOpacityValue').textContent(), '1%');
        assert.equal(await page.evaluate(() => viewerApp.mapUnderlay.getState().opacity), 0.01);
        assert.equal(requests, count, 'Changing opacity must not fetch more tiles');
        for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: 900 });
            await page.locator('#mapUnderlayOpacity').scrollIntoViewIfNeeded();
            const layoutOK = await page.locator('#mapUnderlayDetails').evaluate((root) => {
                const bounds = root.getBoundingClientRect();
                return [...root.querySelectorAll('input, output, label')].every((element) => {
                    const rect = element.getBoundingClientRect();
                    return rect.left >= bounds.left && rect.right <= bounds.right && rect.width > 0;
                }) && document.documentElement.scrollWidth <= innerWidth;
            });
            assert.equal(layoutOK, true, `Map controls overflow at ${width}px`);
        }
        await page.locator('#mapUnderlayToggle').uncheck();
        assert.equal(await page.locator('#mapUnderlayAttribution').isVisible(), false);
        assert.equal(await page.evaluate(() => viewerApp.world.children.some((child) => child.userData.mapUnderlay)), false);
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
}
