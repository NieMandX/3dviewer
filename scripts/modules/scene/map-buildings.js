import { loadMapCoordinateSystem } from '../geo/map-coordinates.js';
import { assignBuildingHeights, loadHeightBindings, saveHeightBindings } from '../geo/building-heights.js';
import { loadBuildingGeometryTools, fetchBuildingContours, fetchOsmBuildingHeights, prepareBuildingContours } from '../geo/map-buildings-data.js';

function disposeLayer(layer) {
    if (!layer) return;
    layer.removeFromParent();
    const geometries = new Set(), materials = new Set();
    layer.traverse((object) => {
        if (object.geometry) geometries.add(object.geometry);
        if (object.material) materials.add(object.material);
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    layer.clear();
}

function markObject(object) {
    Object.assign(object.userData, { mapBuilding: true, excludeFromBounds: true, excludeFromExport: true });
    object.raycast = () => {};
    return object;
}

export function createMapBuildingsLayer(THREE, contours, source, zUp) {
    const group = markObject(new THREE.Group());
    group.name = '2GIS buildings / OSM heights';
    const base = source.min[zUp ? 2 : 1] + 0.05;
    group.position.set(source.center.east, zUp ? source.center.north : base, zUp ? base : -source.center.north);
    let solid = null, outline = null;
    try {
        for (const contour of contours) {
            for (const polygon of contour.polygons) {
                if (contour.height) {
                    const shape = new THREE.Shape(polygon[0].map(([x, y]) => new THREE.Vector2(x, y)));
                    for (const ring of polygon.slice(1)) shape.holes.push(new THREE.Path(ring.map(([x, y]) => new THREE.Vector2(x, y))));
                    solid ||= new THREE.MeshStandardMaterial({ color: 0xb7c0ba, roughness: 1, metalness: 0 });
                    const geometry = new THREE.ExtrudeGeometry(shape, {
                        depth: contour.height.top - contour.height.bottom, bevelEnabled: false, steps: 1,
                    });
                    geometry.translate(0, 0, contour.height.bottom);
                    if (!zUp) geometry.rotateX(-Math.PI / 2);
                    const mesh = markObject(new THREE.Mesh(geometry, solid));
                    mesh.name = contour.address;
                    mesh.receiveShadow = true;
                    mesh.userData.mapHeight = { ...contour.height, osmId: contour.osmId, byOrder: contour.byOrder, contourId: contour.id };
                    group.add(mesh);
                } else {
                    outline ||= new THREE.LineBasicMaterial({ color: 0x64736b });
                    for (const ring of polygon) {
                        const vertices = ring.flatMap(([x, y]) => [x, zUp ? y : 0, zUp ? 0 : -y]);
                        const geometry = new THREE.BufferGeometry();
                        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
                        // Clipping returns closed rings; LineLoop is unsupported by WebGPURenderer.
                        group.add(markObject(new THREE.Line(geometry, outline)));
                    }
                }
            }
        }
        return group;
    } catch (error) {
        const attached = new Set();
        group.traverse((object) => { if (object.material) attached.add(object.material); });
        disposeLayer(group);
        // Materials can have been created before their first geometry failed.
        if (solid && !attached.has(solid)) solid.dispose();
        if (outline && !attached.has(outline)) outline.dispose();
        throw error;
    }
}

export function createMapBuildingsController({ THREE, world, mapReference, isZUp,
    requestRender = () => {}, onChange = () => {}, timeoutMs = 90000,
    fetchImpl = (...args) => globalThis.fetch(...args), loadCoordinateSystem = loadMapCoordinateSystem,
    loadGeometryTools = loadBuildingGeometryTools, readBindings = loadHeightBindings, writeBindings = saveHeightBindings }) {
    let disposed = false, generation = 0, active = null, layer = null, cached = null;
    let state = { enabled: false, loading: false, loaded: 0, total: 0, extruded: 0, unknown: 0, byOrder: 0, message: '' };
    function publish(next) {
        state = { ...state, ...next };
        if (!disposed) onChange({ ...state });
    }
    function disable(message = '') {
        if (disposed) return;
        generation += 1;
        active?.abort(); active = null;
        if (layer) { disposeLayer(layer); layer = null; requestRender(); }
        publish({ enabled: false, loading: false, loaded: 0, total: 0, extruded: 0, unknown: 0, byOrder: 0, message });
    }
    async function enable(apiKey) {
        if (disposed) return false;
        disable();
        const key = String(apiKey || '').trim();
        if (!key) { publish({ message: 'Введите API-ключ 2ГИС.' }); return false; }
        const current = generation, abort = active = new AbortController();
        const isCurrent = () => !disposed && current === generation && !abort.signal.aborted;
        const requireCurrent = () => { if (!isCurrent()) throw new DOMException('Cancelled', 'AbortError'); };
        let timedOut = false, pendingLayer = null;
        const timer = setTimeout(() => { timedOut = true; abort.abort(); }, timeoutMs);
        publish({ enabled: true, loading: true, message: 'Подготовка окружения...' });
        try {
            mapReference.getModelBounds();
            const system = await loadCoordinateSystem();
            requireCurrent();
            const source = mapReference.getModelBounds(), zUp = isZUp();
            const signature = JSON.stringify({ source, zUp });
            const area = system.getMapArea(source.center, { radiusMeters: 500, zoom: 17 });
            const tools = await loadGeometryTools();
            requireCurrent();
            let data = cached?.signature === signature && cached.key === key && Date.now() - cached.time < 300000 ? cached.data : null;
            const reused = !!data;
            if (!data) {
                const gis = await fetchBuildingContours({ area, key, signal: abort.signal, fetchImpl,
                    onProgress: ({ loaded, total }) => { if (isCurrent()) publish({ loaded, total, message: `Контуры 2ГИС: ${loaded} / ${total}` }); } });
                requireCurrent();
                publish({ message: 'Получение высот OSM...' });
                let elements = [], osmWarning = '';
                try { elements = await fetchOsmBuildingHeights({ area, signal: abort.signal, fetchImpl }); }
                catch (_) {
                    requireCurrent();
                    osmWarning = 'OSM недоступен: показаны только контуры.';
                }
                requireCurrent();
                data = { gis, elements, osmWarning };
            }
            const prepared = prepareBuildingContours(data.gis.items, system, area, tools);
            const matched = assignBuildingHeights(prepared.contours, data.elements, readBindings());
            requireCurrent();
            if (JSON.stringify({ source: mapReference.getModelBounds(), zUp: isZUp() }) !== signature) {
                throw new Error('Модель изменилась. Включите окружение снова.');
            }
            pendingLayer = createMapBuildingsLayer(THREE, matched.contours, source, zUp);
            requireCurrent();
            world.add(pendingLayer); layer = pendingLayer; pendingLayer = null;
            writeBindings(matched.bindings);
            if (!data.osmWarning && !reused) cached = { data, signature, key, time: Date.now() };
            const visible = matched.contours.filter((contour) => contour.polygons.length);
            const extruded = visible.filter((contour) => contour.height).length;
            const byOrder = visible.filter((contour) => contour.height && contour.byOrder).length;
            const fromLevels = visible.filter((contour) => contour.height?.source === 'levels').length;
            const unknown = visible.length - extruded;
            const message = [`Здания: ${extruded}. Контуры без высоты: ${unknown}.`,
                fromLevels ? `По этажности: ${fromLevels}.` : '',
                byOrder ? `По порядку: ${byOrder}.` : '',
                data.gis.partial ? `2ГИС: ${data.gis.items.length} из ${data.gis.total} (лимит выборки).` : '',
                prepared.skipped ? `Пропущено контуров: ${prepared.skipped}.` : '', data.osmWarning].filter(Boolean).join(' ');
            publish({ enabled: true, loading: false, loaded: data.gis.items.length, total: data.gis.total, extruded, unknown, byOrder, message });
            requestRender();
            return true;
        } catch (error) {
            if (!disposed && current === generation) {
                const message = timedOut ? 'Окружение не загрузилось. Превышено время ожидания.'
                    : error?.message === 'No georeferenced model is loaded' ? 'Сначала загрузите модель в координатах МГГТ.'
                        : /^(2ГИС:|Модель изменилась)/.test(error?.message || '') ? error.message
                            : 'Не удалось загрузить окружение. Проверьте соединение и API-ключ.';
                if (layer) { disposeLayer(layer); layer = null; requestRender(); }
                publish({ enabled: false, loading: false, message });
            }
            return false;
        } finally {
            clearTimeout(timer); abort.abort();
            if (active === abort) active = null;
            disposeLayer(pendingLayer);
        }
    }
    return { enable, disable, getState: () => ({ ...state, disposed }),
        invalidate() { cached = null; if (state.enabled) disable('Модель изменилась. Включите окружение снова.'); },
        dispose() { if (!disposed) { disable(); cached = null; disposed = true; } },
    };
}
