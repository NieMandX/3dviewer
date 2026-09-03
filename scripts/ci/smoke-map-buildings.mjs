import assert from 'node:assert/strict';

export async function runMapBuildingsSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
        await page.goto(`${baseUrl}/__smoke_blank`);
        const result = await page.evaluate(async () => {
            const THREE = await import('three');
            const { loadMapCoordinateSystem } = await import('/scripts/modules/geo/map-coordinates.js');
            const { loadBuildingGeometryTools, fetchBuildingContours, fetchMapSurfaceContours,
                prepareBuildingContours, prepareMapSurfaceContours } = await import('/scripts/modules/geo/map-buildings-data.js');
            const { createMapReferenceController } = await import('/scripts/modules/scene/map-reference.js');
            const { createMapBuildingsController, createMapBuildingsLayer } = await import('/scripts/modules/scene/map-buildings.js');
            const { createShadingController } = await import('/scripts/modules/render/shading-controller.js');
            const system = await loadMapCoordinateSystem(), tools = await loadBuildingGeometryTools();
            const world = new THREE.Group();
            const model = new THREE.Mesh(new THREE.BoxGeometry(10, 30, 10), new THREE.MeshBasicMaterial());
            model.position.set(2322.805, 141, -9741.544);
            world.add(model); world.position.set(-2322.805, 0, 9741.544);
            const reference = createMapReferenceController({ THREE, world, getModels: () => [{ obj: model }], isZUp: () => false });
            const source = reference.getModelBounds(), area = system.getMapArea(source.center);
            const ring = (x, y, size) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]].map(([east, north]) => {
                const p = system.modelToWgs84({ east: east + source.center.east, north: north + source.center.north });
                return `${p.lon} ${p.lat}`;
            }).join(',');
            const address = { street: 'Тестовая улица', number: '1 ст1', type: 'street_number' };
            const items = [
                { id: 'two', name: 'Тестовая улица, 1 ст1', address: { components: [address] }, adm_div: [{ name: 'Москва', type: 'city' }],
                    geometry: { hover: `MULTIPOLYGON (((${ring(-90, 0, 50)}),(${ring(-80, 10, 10)})),((${ring(20, 0, 50)})))` } },
                { id: 'unknown', geometry: { hover: `POLYGON ((${ring(50, 100, 20)}))` } },
                { id: 'edge', geometry: { hover: `POLYGON ((${ring(480, 0, 60)}))` } },
            ];
            const elements = [143, 260].map((height, i) => ({ type: 'way', id: 10 + i, tags: {
                building: 'office', 'addr:street': 'улица Тестовая', 'addr:housenumber': '1 с1', height: String(height),
            } }));
            const roadItems = [{ id: 'road', type: 'street', name: 'Тестовый проезд', mapSurfaceKind: 'road',
                geometry: { hover: `POLYGON ((${ring(470, 0, 60)}),(${ring(480, 10, 10)}))` } }];
            const parkingItems = [{ id: 'parking', type: 'parking', subtype: 'ground', mapSurfaceKind: 'parking',
                geometry: { selection: `POLYGON ((${ring(100, 100, 30)}))` } }];
            const areaItems = [{ id: 'area', type: 'adm_div', subtype: 'place', mapSurfaceKind: 'area',
                geometry: { selection: `POLYGON ((${ring(-200, -200, 60)}))` } }];
            let calls = 0, writes = 0, frames = 0;
            let saved = new Map();
            const states = [];
            const fetchImpl = async (url, options) => {
                calls++;
                if (options.credentials !== 'omit') throw new Error('Unexpected credentials');
                const isOsm = String(url).includes('overpass');
                if (!isOsm && new URL(url).origin !== 'https://gis-proxy.example') throw new Error('Unsafe GIS endpoint');
                const type = !isOsm && new URL(url).searchParams.get('type');
                const selected = type === 'street,road' ? roadItems : type === 'parking' ? parkingItems : type === 'adm_div.place' ? areaItems : items;
                return Response.json(isOsm ? { elements } : { meta: { code: 200 }, result: { total: selected.length, items: selected } });
            };
            const config = { THREE, world, mapReference: reference, isZUp: () => false, fetchImpl,
                apiBaseUrl: 'https://gis-proxy.example',
                loadCoordinateSystem: async () => system, loadGeometryTools: async () => tools,
                readBindings: () => new Map(saved), writeBindings: (bindings) => { writes++; saved = bindings; },
                requestRender: () => frames++, onChange: (state) => states.push(state),
            };
            const controller = createMapBuildingsController(config);
            const missingService = createMapBuildingsController({ ...config, apiBaseUrl: '' });
            const noService = await missingService.enable();
            const noServiceState = missingService.getState();
            missingService.dispose();
            const enabled = await controller.enable();
            const state = controller.getState();
            const layer = world.children.find((child) => child.userData.mapBuilding);
            const compatibleLines = layer.children.every((child) => !child.isLineLoop && (!child.isLine || (() => {
                const p = child.geometry.attributes.position, last = p.count - 1;
                return p.getX(0) === p.getX(last) && p.getY(0) === p.getY(last) && p.getZ(0) === p.getZ(last);
            })()));
            const meshHeights = layer.children.filter((child) => child.userData.mapHeight).map((mesh) => {
                mesh.geometry.computeBoundingBox();
                return mesh.geometry.boundingBox.max.y;
            });
            const unchangedBounds = JSON.stringify(reference.getModelBounds()) === JSON.stringify(source);
            const prepared = prepareBuildingContours(items, system, area, tools);
            const holePreserved = prepared.contours[0].polygons[0].length === 2;
            const allWithinRadius = prepared.contours.every((c) => c.polygons.flat(2).every(([x, y]) => Math.hypot(x, y) <= 500.001));
            const surfaces = prepareMapSurfaceContours([...roadItems, ...parkingItems,
                { ...parkingItems[0], id: 'point', geometry: { hover: `POLYGON ((${ring(200, 0, 5)}))`, selection: 'POINT(37.5 55.7)' } },
                { ...parkingItems[0], id: 'underground', subtype: 'underground' }], system, area, tools);
            const surfaceValidation = surfaces.contours.length === 2 && surfaces.skipped === 1
                && surfaces.contours[0].polygons[0].length === 2
                && surfaces.contours.every((c) => c.polygons.flat(2).every(([x, y]) => Math.hypot(x, y) <= 500.001));
            const shiftedArea = { ...area, modelCenter: { ...area.modelCenter, east: area.modelCenter.east + 1 } };
            const stableIds = JSON.stringify(prepared.contours.map(c => c.id)) === JSON.stringify(
                prepareBuildingContours(items, system, shiftedArea, tools).contours.map(c => c.id));
            const scene = new THREE.Scene(); scene.add(world, new THREE.HemisphereLight(0xffffff, 0x606060, 2));
            const originals = layer.children.map((child) => child.material);
            const shading = createShadingController({ THREE, world, scene, requestRender: () => {}, schedulePanelRefresh: () => {},
                applyEnvToMaterials: () => {}, applyGlassControlsToScene: () => {}, getEnvIntensity: () => 1, setBackfaceMode: () => {} });
            for (const mode of ['uv', 'color', 'matcap', 'beautywire', 'pbr']) shading.applyShading(mode);
            const preservedMaterials = layer.children.every((child, i) => child.material === originals[i]);
            const renderer = new THREE.WebGLRenderer(); renderer.setSize(128, 128);
            const camera = new THREE.PerspectiveCamera(50, 1, 1, 3000);
            camera.position.set(400, 450, 500); camera.lookAt(0, 240, 0);
            const target = new THREE.WebGLRenderTarget(128, 128);
            renderer.setRenderTarget(target); renderer.render(scene, camera);
            const pixels = new Uint8Array(128 * 128 * 4);
            renderer.readRenderTargetPixels(target, 0, 0, 128, 128, pixels);
            let coloredPixels = 0;
            for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 20 || pixels[i + 1] > 20 || pixels[i + 2] > 20) coloredPixels++;
            target.dispose(); renderer.dispose(); shading.dispose();
            const resources = new Map();
            layer.traverse((object) => { for (const resource of [object.geometry, object.material]) if (resource) resources.set(resource, 0); });
            for (const resource of resources.keys()) resource.addEventListener('dispose', () => resources.set(resource, resources.get(resource) + 1));
            controller.disable(); controller.disable();
            const resourcesOnce = [...resources.values()].every((count) => count === 1);
            const initialCalls = calls;
            await controller.enable();
            const cachedCalls = calls - initialCalls;
            controller.invalidate();
            const invalidated = !controller.getState().enabled && !world.children.some((child) => child.userData.mapBuilding);
            controller.dispose();
            const framesBefore = frames;
            await controller.enable(); controller.disable();
            const silentAfterDispose = framesBefore === frames;

            let resume, started = false;
            const wait = new Promise((resolve) => { resume = resolve; });
            const stale = createMapBuildingsController({ ...config, fetchImpl: async (...args) => { started = true; await wait; return fetchImpl(...args); } });
            const pending = stale.enable();
            while (!started) await new Promise((resolve) => setTimeout(resolve, 1));
            const writesBefore = writes;
            stale.disable(); resume();
            const staleResult = await pending;
            const noStaleWrites = writesBefore === writes;
            stale.dispose();
            const timeout = createMapBuildingsController({ ...config, timeoutMs: 5, fetchImpl: (_, { signal }) => new Promise((resolve, reject) => {
                if (signal.aborted) reject(new DOMException('Cancelled', 'AbortError'));
                else signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
            }) });
            await timeout.enable();
            const timeoutState = timeout.getState(); timeout.dispose();
            const osmFailure = createMapBuildingsController({ ...config, fetchImpl: async (url, options) => String(url).includes('overpass')
                ? new Response('unavailable', { status: 503 }) : fetchImpl(url, options) });
            await osmFailure.enable();
            const fallback = osmFailure.getState(); osmFailure.dispose();
            const forbidden = createMapBuildingsController({ ...config, fetchImpl: async () => Response.json({ meta: { code: 403, error: { message: 'smoke-key' } } }) });
            await forbidden.enable();
            const forbiddenState = forbidden.getState(); forbidden.dispose();
            const emptySurfaces = await fetchMapSurfaceContours({ area, apiBaseUrl: 'https://gis-proxy.example', signal: new AbortController().signal,
                fetchImpl: async () => Response.json({ meta: { code: 404 } }) });
            const partialSurfaces = await fetchMapSurfaceContours({ area, apiBaseUrl: 'https://gis-proxy.example', signal: new AbortController().signal,
                fetchImpl: async (url, options) => new URL(url).searchParams.get('type') === 'parking'
                    ? new Response('unavailable', { status: 503 }) : fetchImpl(url, options) });
            const surfacesFailure = createMapBuildingsController({ ...config, fetchImpl: async (url, options) =>
                !String(url).includes('overpass') && new URL(url).searchParams.get('type') !== 'building'
                    ? new Response('unavailable', { status: 503 }) : fetchImpl(url, options) });
            await surfacesFailure.enable();
            const surfacesFallback = surfacesFailure.getState(); surfacesFailure.dispose();
            let pages = 0;
            const paged = await fetchBuildingContours({ area, apiBaseUrl: 'https://gis-proxy.example', signal: new AbortController().signal,
                fetchImpl: async (url) => { pages++; return Response.json({ meta: { code: 200 }, result: {
                    total: 219, items: Array.from({ length: 10 }, (_, i) => ({ id: `${url.searchParams.get('page')}-${i}` })),
                } }); } });
            const zLayer = createMapBuildingsLayer(THREE, [{ polygons: [[[ [0, 0], [5, 0], [5, 5], [0, 0] ]]], height: { top: 20, bottom: 4 } }],
                { center: source.center, min: [0, 0, 126] }, true);
            zLayer.children[0].geometry.computeBoundingBox();
            const zBounds = [zLayer.children[0].geometry.boundingBox.min.z, zLayer.children[0].geometry.boundingBox.max.z];
            zLayer.traverse((child) => { child.geometry?.dispose(); child.material?.dispose(); });
            reference.dispose(); model.geometry.dispose(); model.material.dispose();
            return { noService, noServiceState, enabled, state, meshHeights, unchangedBounds, holePreserved, allWithinRadius, preservedMaterials,
                coloredPixels, resourcesOnce, initialCalls, cachedCalls, invalidated, silentAfterDispose,
                staleResult, noStaleWrites, timeoutState, fallback, forbiddenState, pages, pageCount: paged.items.length, partial: paged.partial,
                zBounds, compatibleLines, surfaceValidation, stableIds, emptySurfaceCount: emptySurfaces.items.length, surfacesFallback,
                partialKinds: partialSurfaces.items.map(item => item.mapSurfaceKind), failedKinds: partialSurfaces.failed,
                remainingLayers: world.children.filter((child) => child.userData.mapBuilding).length };
        });
        assert.equal(result.noService, false);
        assert.match(result.noServiceState.message, /Сервис 2ГИС/);
        assert.equal(result.enabled, true);
        assert.equal(result.state.extruded, 2);
        assert.equal(result.state.unknown, 2);
        assert.equal(result.state.byOrder, 2);
        assert.equal(result.state.roads, 1);
        assert.equal(result.state.parking, 1);
        assert.equal(result.state.areas, 1);
        assert.deepEqual(result.meshHeights, [143, 260]);
        for (const field of ['unchangedBounds', 'holePreserved', 'allWithinRadius', 'preservedMaterials', 'resourcesOnce', 'invalidated', 'silentAfterDispose', 'noStaleWrites']) assert.equal(result[field], true, field);
        assert.ok(result.coloredPixels > 250, `Blank building render: ${result.coloredPixels}`);
        assert.equal(result.initialCalls, 5);
        assert.equal(result.cachedCalls, 0);
        assert.equal(result.staleResult, false);
        assert.match(result.timeoutState.message, /время ожидания/);
        assert.equal(result.fallback.enabled, true);
        assert.equal(result.fallback.extruded, 0);
        assert.equal(result.fallback.unknown, 4);
        assert.equal(result.forbiddenState.enabled, false);
        assert.match(result.forbiddenState.message, /Places API/);
        assert.equal(result.pages, 5);
        assert.equal(result.pageCount, 50);
        assert.equal(result.partial, true);
        assert.deepEqual(result.zBounds, [4, 20]);
        assert.equal(result.compatibleLines, true);
        assert.equal(result.surfaceValidation, true);
        assert.equal(result.stableIds, true);
        assert.equal(result.emptySurfaceCount, 0);
        assert.equal(result.surfacesFallback.enabled, true);
        assert.equal(result.surfacesFallback.extruded, 2);
        assert.equal(result.surfacesFallback.roads, 0);
        assert.match(result.surfacesFallback.message, /не загрузились дороги, площадки, территории/);
        assert.deepEqual(result.partialKinds, ['road', 'area']);
        assert.deepEqual(result.failedKinds, ['parking']);
        assert.equal(result.remainingLayers, 0);
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
}

export async function runMapBuildingsUISmoke(browser, baseUrl) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let requests = 0;
    try {
        await page.goto(`${baseUrl}/?renderer=webgl`);
        await page.waitForFunction(() => globalThis.viewerApp && !document.body.classList.contains('app-loading'));
        await page.locator('#toggleSideBtn').click();
        await page.locator('#mapDetails > summary').click();
        await page.locator('#mapBuildingsToggle').click();
        await page.waitForFunction(() => !viewerApp.mapBuildings.getState().loading);
        assert.match(await page.locator('#mapBuildingsStatus').textContent(), /Сначала загрузите модель/);
        const data = await page.evaluate(async () => {
            const THREE = await import('three');
            const { loadMapCoordinateSystem } = await import('/scripts/modules/geo/map-coordinates.js');
            const system = await loadMapCoordinateSystem();
            const model = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), new THREE.MeshBasicMaterial());
            model.position.set(2322.805, 131, -9741.544);
            viewerApp.world.add(model); viewerApp.loadedModels.push({ obj: model, name: 'building smoke' });
            viewerApp.world.position.set(-2322.805, 0, 9741.544);
            const ring = [[30, 0], [60, 0], [60, 30], [30, 30], [30, 0]].map(([x, y]) => {
                const p = system.modelToWgs84({ east: 2322.805 + x, north: 9741.544 + y });
                return `${p.lon} ${p.lat}`;
            }).join(',');
            return { meta: { code: 200 }, result: { total: 1, items: [{ id: 'ui', name: 'Тестовая, 1',
                address: { components: [{ type: 'street_number', street: 'улица Тестовая', number: '1' }] },
                adm_div: [{ type: 'city', name: 'Москва' }], geometry: { hover: `POLYGON ((${ring}))` } }] } };
        });
        await page.route('https://voice-api.agr.vision/v1/2gis/items**', (route) => {
            requests++;
            const type = new URL(route.request().url()).searchParams.get('type');
            const response = type === 'building' ? data : { meta: { code: 200 }, result: { total: 1, items: [
                { id: type, type: type === 'parking' ? 'parking' : 'street', subtype: type === 'parking' ? 'ground' : undefined,
                    geometry: { hover: data.result.items[0].geometry.hover, selection: data.result.items[0].geometry.hover } },
            ] } };
            return route.fulfill({ json: response, headers: { 'access-control-allow-origin': '*' } });
        });
        await page.route('https://overpass-api.de/**', (route) => {
            requests++;
            return route.fulfill({ json: { elements: [{ type: 'way', id: 1,
                tags: { building: 'yes', 'addr:street': 'улица Тестовая', 'addr:housenumber': '1', 'building:levels': '9' } }] },
            headers: { 'access-control-allow-origin': '*' } });
        });
        await page.locator('#mapBuildingsToggle').check();
        await page.waitForFunction(() => viewerApp.mapBuildings.getState().extruded === 1);
        assert.equal(await page.evaluate(() => viewerApp.mapBuildings.getState().roads), 1);
        assert.equal(await page.evaluate(() => viewerApp.mapBuildings.getState().parking), 1);
        assert.equal(await page.evaluate(() => viewerApp.mapBuildings.getState().areas), 1);
        assert.equal(await page.locator('#map2gisAttribution').isVisible(), true);
        assert.equal(await page.locator('#mapOsmAttribution').isVisible(), true);
        const count = requests;
        for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: 900 });
            await page.locator('#mapBuildingsToggle').scrollIntoViewIfNeeded();
            assert.equal(await page.locator('#mapDetails').evaluate((root) => {
                const bounds = root.getBoundingClientRect();
                return [...root.querySelectorAll('label, input, progress')].filter((node) => !node.hidden).every((node) => {
                    const box = node.getBoundingClientRect();
                    return box.left >= bounds.left && box.right <= bounds.right;
                }) && document.documentElement.scrollWidth <= innerWidth;
            }), true);
        }
        await page.locator('#mapBuildingsToggle').uncheck();
        assert.equal(await page.locator('#mapOsmAttribution').isVisible(), false);
        assert.equal(await page.locator('#map2gisAttribution').isVisible(), false);
        await page.locator('#mapBuildingsToggle').check();
        await page.waitForFunction(() => viewerApp.mapBuildings.getState().extruded === 1);
        assert.equal(requests, count, 'Re-enabling must reuse data without repeating API requests');
        await page.evaluate(() => viewerApp.mapBuildings.invalidate());
        assert.equal(await page.locator('#mapBuildingsToggle').isChecked(), false);
        assert.match(await page.locator('#mapBuildingsStatus').textContent(), /Модель изменилась/);
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
}
