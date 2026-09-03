import { loadMapCoordinateSystem } from '../geo/map-coordinates.js';

const TILE_SIZE = 256;
const MAX_TILES = 64;

export function createMapUnderlayGeometry(THREE, system, area, zUp) {
    const { tiles, modelCenter, radiusMeters } = area;
    const nw = system.tileBounds({ x: tiles.minX, y: tiles.minY, z: tiles.z });
    const se = system.tileBounds({ x: tiles.maxX, y: tiles.maxY, z: tiles.z });
    const min = system.wgs84ToMercator({ lon: nw.west, lat: se.south });
    const max = system.wgs84ToMercator({ lon: se.east, lat: nw.north });
    const positions = [], uvs = [], indices = [];
    const segments = 128, rings = 8;
    function vertex(east, north) {
        positions.push(east, zUp ? north : 0, zUp ? 0 : -north);
        const point = system.wgs84ToMercator(system.modelToWgs84({
            east: modelCenter.east + east, north: modelCenter.north + north,
        }));
        uvs.push((point.x - min.x) / (max.x - min.x), (point.y - min.y) / (max.y - min.y));
    }
    // Tessellate in ground metres; project every UV into the Mercator tile atlas.
    vertex(0, 0);
    for (let ring = 1; ring <= rings; ring += 1) {
        for (let i = 0; i < segments; i += 1) {
            const angle = i * Math.PI * 2 / segments;
            vertex(Math.cos(angle) * radiusMeters * ring / rings,
                Math.sin(angle) * radiusMeters * ring / rings);
        }
    }
    for (let i = 0; i < segments; i += 1) indices.push(0, 1 + i, 1 + (i + 1) % segments);
    for (let ring = 1; ring < rings; ring += 1) {
        const inner = 1 + (ring - 1) * segments, outer = inner + segments;
        for (let i = 0; i < segments; i += 1) {
            const next = (i + 1) % segments;
            indices.push(inner + i, outer + i, outer + next, inner + i, outer + next, inner + next);
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
}

export function createMapUnderlayController({ THREE, world, mapReference, isZUp,
    requestRender = () => {}, onChange = () => {}, loadCoordinateSystem = loadMapCoordinateSystem,
    fetchImpl = (...args) => globalThis.fetch(...args), decodeImage = (blob) => globalThis.createImageBitmap(blob),
    createCanvas = () => document.createElement('canvas'), timeoutMs = 60000 }) {
    let disposed = false, generation = 0, active = null, layer = null, opacity = 0.85;
    let state = { enabled: false, loading: false, loaded: 0, total: 0, message: '' };

    function publish(next) {
        state = { ...state, ...next };
        if (!disposed) onChange({ ...state });
    }

    function clearLayer() {
        if (!layer) return;
        layer.removeFromParent();
        layer.geometry.dispose();
        layer.material.map.dispose();
        layer.material.map.image.width = layer.material.map.image.height = 1;
        layer.material.dispose();
        layer = null;
        requestRender();
    }

    function disable(message = '') {
        generation += 1;
        active?.abort();
        active = null;
        clearLayer();
        publish({ enabled: false, loading: false, loaded: 0, total: 0, message });
    }

    async function enable(apiKey) {
        if (disposed) return false;
        disable();
        const key = String(apiKey || '').trim();
        if (!key) {
            publish({ message: 'Введите API-ключ 2ГИС.' });
            return false;
        }
        const current = generation;
        const abort = active = new AbortController();
        let canvas = null, geometry = null, texture = null, material = null;
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; abort.abort(); }, timeoutMs);
        const isCurrent = () => !disposed && generation === current && !abort.signal.aborted;
        function requireCurrent() {
            if (!isCurrent()) throw new DOMException('Cancelled', 'AbortError');
        }
        publish({ enabled: true, loading: true, message: 'Подготовка карты...' });
        try {
            // Fail before contacting the provider if there is no model.
            mapReference.getModelBounds();
            const system = await loadCoordinateSystem();
            requireCurrent();
            const source = mapReference.getModelBounds();
            const zUp = isZUp();
            const area = system.getMapArea(source.center, { radiusMeters: 500, zoom: 17 });
            const { tiles } = area;
            const columns = tiles.maxX - tiles.minX + 1, rows = tiles.maxY - tiles.minY + 1;
            if (tiles.count > MAX_TILES || Math.max(columns, rows) * TILE_SIZE > 4096) {
                throw new Error('Область карты слишком велика. Проверьте координаты МГГТ.');
            }
            canvas = createCanvas();
            canvas.width = columns * TILE_SIZE;
            canvas.height = rows * TILE_SIZE;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Не удалось подготовить изображение карты.');
            publish({ total: tiles.count, message: '' });
            let nextTile = 0, loaded = 0;
            async function worker() {
                while (isCurrent() && nextTile < tiles.count) {
                    const index = nextTile++;
                    const col = index % columns, row = Math.floor(index / columns);
                    const url = new URL(`https://tile0.maps.2gis.com/v2/tiles/online_sd/${tiles.z}/${tiles.minX + col}/${tiles.minY + row}.png`);
                    url.searchParams.set('key', key);
                    const response = await fetchImpl(url, { signal: abort.signal, mode: 'cors',
                        credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' });
                    requireCurrent();
                    if (!response.ok) {
                        if (response.status === 401 || response.status === 403) {
                            throw new Error('2ГИС: проверьте ключ и доступ к Raster Tiles API.');
                        }
                        if (response.status === 429) throw new Error('2ГИС: исчерпан лимит запросов.');
                        throw new Error(`2ГИС: ошибка загрузки карты (${response.status}).`);
                    }
                    const blob = await response.blob();
                    requireCurrent();
                    if (blob.size > 2 * 1024 * 1024 || !blob.type.startsWith('image/')) {
                        throw new Error('2ГИС вернул некорректное изображение карты.');
                    }
                    const bitmap = await decodeImage(blob);
                    try {
                        requireCurrent();
                        if (bitmap.width !== TILE_SIZE || bitmap.height !== TILE_SIZE) {
                            throw new Error('2ГИС: неожиданный размер тайла.');
                        }
                        context.drawImage(bitmap, col * TILE_SIZE, row * TILE_SIZE);
                    } finally { bitmap.close(); }
                    loaded += 1;
                    publish({ loaded });
                }
            }
            // A failed request cancels its siblings; wait for late image decodes before releasing the atlas.
            let failure = null;
            await Promise.all(Array.from({ length: Math.min(4, tiles.count) }, async () => {
                try { await worker(); } catch (error) {
                    if (!failure) failure = error;
                    abort.abort();
                }
            }));
            if (failure) throw failure;
            requireCurrent();
            const latest = mapReference.getModelBounds();
            if (isZUp() !== zUp || ['min', 'max'].some((name) =>
                source[name].some((value, i) => Math.abs(value - latest[name][i]) > 0.001))) {
                throw new Error('Модель изменилась. Включите подложку снова.');
            }
            geometry = createMapUnderlayGeometry(THREE, system, area, zUp);
            texture = new THREE.CanvasTexture(canvas);
            texture.colorSpace = THREE.SRGBColorSpace;
            material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity,
                depthWrite: false, toneMapped: false });
            layer = new THREE.Mesh(geometry, material);
            layer.name = '2GIS map underlay';
            layer.userData.mapUnderlay = true;
            layer.userData.excludeFromBounds = true;
            layer.userData.excludeFromExport = true;
            layer.raycast = () => {};
            const height = source.min[zUp ? 2 : 1] - 0.2;
            layer.position.set(source.center.east, zUp ? source.center.north : height,
                zUp ? height : -source.center.north);
            world.add(layer);
            geometry = texture = material = canvas = null;
            publish({ enabled: true, loading: false, message: '' });
            requestRender();
            return true;
        } catch (error) {
            if (!disposed && generation === current) {
                // Never report provider URLs or response bodies: they can contain the API key.
                const message = timedOut ? 'Карта не загрузилась за минуту. Проверьте соединение.'
                    : error?.message === 'No georeferenced model is loaded' ? 'Сначала загрузите модель в координатах МГГТ.'
                        : /^(2ГИС|Модель изменилась|Область карты|Не удалось подготовить)/.test(error?.message || '')
                            ? error.message : 'Не удалось загрузить карту. Проверьте соединение и API-ключ.';
                publish({ enabled: false, loading: false, message });
            }
            return false;
        } finally {
            clearTimeout(timer);
            abort.abort();
            if (active === abort) active = null;
            geometry?.dispose();
            material?.dispose();
            texture?.dispose();
            if (canvas) canvas.width = canvas.height = 1;
        }
    }

    function setOpacity(value) {
        if (disposed || !Number.isFinite(value)) return;
        opacity = Math.max(0, Math.min(1, value));
        if (layer) {
            layer.material.opacity = opacity;
            requestRender();
        }
    }

    return { enable, disable, setOpacity,
        invalidate: () => { if (state.enabled) disable('Модель изменилась. Включите подложку снова.'); },
        getState: () => ({ ...state, opacity, disposed }),
        dispose: () => { if (!disposed) { disable(); disposed = true; } },
    };
}
