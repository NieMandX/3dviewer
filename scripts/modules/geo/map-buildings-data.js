import { buildingAddressKey } from './building-heights.js';
import { createGisApiUrl, getGisProxyError } from './gis-api.js';

let geometryToolsPromise;
export function loadBuildingGeometryTools() {
    if (!geometryToolsPromise) {
        geometryToolsPromise = (async () => {
            const { wktToGeoJSON } = await import('https://cdn.jsdelivr.net/npm/@terraformer/wkt@2.2.2/+esm');
            const { default: clipping } = await import('https://cdn.jsdelivr.net/npm/polygon-clipping@0.15.7/+esm');
            return { parse: wktToGeoJSON, intersection: clipping.intersection };
        })().catch((error) => { geometryToolsPromise = null; throw error; });
    }
    return geometryToolsPromise;
}

async function readResponse(response, provider) {
    if (!response.ok) throw new Error(provider === '2ГИС'
        ? getGisProxyError(response, `${provider}: ошибка запроса (${response.status}).`)
        : `${provider}: ошибка запроса (${response.status}).`);
    const text = await response.text();
    if (text.length > 8 * 1024 * 1024) throw new Error(`${provider}: слишком большой ответ.`);
    try { return JSON.parse(text); } catch (_) { throw new Error(`${provider}: некорректный ответ.`); }
}

async function fetch2gisPages({ area, apiBaseUrl, types, signal, fetchImpl, fields, sort, onProgress = () => {} }) {
    const items = new Map();
    let total = 0;
    // The demo Places key allows ten items and five pages. Never split an area to bypass its limit.
    for (let page = 1; page <= 5; page += 1) {
        signal.throwIfAborted();
        const url = createGisApiUrl(apiBaseUrl, '/v1/2gis/items');
        url.search = new URLSearchParams({ point: `${area.wgs84Center.lon},${area.wgs84Center.lat}`,
            radius: String(area.radiusMeters), type: types, page_size: '10', page: String(page), fields }).toString();
        if (sort) url.searchParams.set('sort', sort);
        const data = await readResponse(await fetchImpl(url, { signal, mode: 'cors', credentials: 'omit',
            redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' }), '2ГИС');
        signal.throwIfAborted();
        if (data.meta?.code === 404) break;
        if (data.meta?.code !== 200) throw new Error(`2ГИС: проверьте ключ и доступ к Places API (${Number(data.meta?.code) || 0}).`);
        if (!Array.isArray(data.result?.items)) throw new Error('2ГИС: некорректный список объектов.');
        total = Math.max(items.size, Number(data.result.total) || 0);
        for (const item of data.result.items) if (item.id && !items.has(item.id)) items.set(item.id, item);
        onProgress({ loaded: items.size, total });
        if (items.size >= total || data.result.items.length < 10) break;
    }
    return { items: [...items.values()], total, partial: items.size < total };
}

export async function fetchBuildingContours({ area, apiBaseUrl, signal, fetchImpl, onProgress = () => {} }) {
    return fetch2gisPages({ area, apiBaseUrl, types: 'building', signal, fetchImpl,
        fields: 'items.address,items.adm_div,items.geometry.hover', onProgress });
}

export async function fetchMapSurfaceContours({ area, apiBaseUrl, signal, fetchImpl, onProgress = () => {} }) {
    const groups = [
        { types: 'street,road', kind: 'road' },
        { types: 'parking', kind: 'parking' },
        { types: 'adm_div.place', kind: 'area' },
    ];
    const result = { items: [], totals: {}, partial: false, failed: [] };
    for (const group of groups) {
        try {
            const page = await fetch2gisPages({ area, apiBaseUrl, types: group.types, signal, fetchImpl,
                fields: 'items.geometry.hover,items.geometry.selection', sort: 'distance',
                onProgress: ({ loaded, total }) => onProgress({ kind: group.kind, loaded, total }) });
            result.items.push(...page.items.map((item) => ({ ...item, mapSurfaceKind: group.kind })));
            result.totals[group.kind] = { loaded: page.items.length, total: page.total };
            result.partial ||= page.partial;
        } catch (_) {
            signal.throwIfAborted();
            result.failed.push(group.kind);
        }
    }
    return result;
}

export async function fetchOsmBuildingHeights({ area, signal, fetchImpl }) {
    const { lat, lon } = area.wgs84Center;
    if (![lat, lon].every(Number.isFinite)) throw new Error('OSM: некорректные координаты.');
    const around = `(around:${area.radiusMeters},${lat},${lon})`;
    const query = `[out:json][timeout:25][maxsize:8388608];(nwr["building"]["addr:street"]["addr:housenumber"]${around};`
        + `nwr["building:part"]["addr:street"]["addr:housenumber"]${around};);out tags;`;
    const data = await readResponse(await fetchImpl('https://overpass-api.de/api/interpreter', {
        method: 'POST', signal, mode: 'cors', credentials: 'omit', redirect: 'error',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }),
    }), 'OSM');
    signal.throwIfAborted();
    if (data.remark || !Array.isArray(data.elements) || data.elements.length > 5000) throw new Error('OSM: неполная выдача высот.');
    return data.elements;
}

// A changed polygon must not silently inherit a previous contour's assignment.
function footprintId(polygon) {
    let hash = 2166136261;
    for (const char of JSON.stringify(polygon)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return (hash >>> 0).toString(16);
}

function clippingCircle(area) {
    return Array.from({ length: 129 }, (_, i) => [
        Math.cos(i % 128 * Math.PI / 64) * area.radiusMeters,
        Math.sin(i % 128 * Math.PI / 64) * area.radiusMeters,
    ]);
}

function readPolygons(item, system, area, tools, pointBudget, field = 'hover') {
    const wkt = item.geometry?.[field];
    if (typeof wkt !== 'string' || wkt.length > 200000) throw new Error('Invalid footprint');
    const geometry = tools.parse(wkt);
    const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
        : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
    if (!polygons.length || polygons.length > 100) throw new Error('Invalid footprint');
    return polygons.map((polygon) => ({ hash: footprintId(polygon), projected: polygon.map((ring) => {
        if (!Array.isArray(ring) || ring.length < 4 || ring.length > 2000) throw new Error('Invalid ring');
        pointBudget.count += ring.length;
        if (pointBudget.count > pointBudget.max) throw new Error('Geometry limit');
        return ring.map(([lon, lat]) => {
            const p = system.wgs84ToModel({ lon, lat });
            const local = [p.east - area.modelCenter.east, p.north - area.modelCenter.north];
            if (!local.every(Number.isFinite) || local.some((value) => Math.abs(value) > 100000)) throw new Error('Invalid coordinates');
            return local;
        });
    }) }));
}

export function prepareBuildingContours(items, system, area, tools) {
    const contours = [];
    let skipped = 0;
    const pointBudget = { count: 0, max: 30000 }, circle = clippingCircle(area);
    for (const item of items) {
        try {
            const polygons = readPolygons(item, system, area, tools, pointBudget);
            const city = item.adm_div?.find((entry) => entry.type === 'city')?.name;
            const addresses = (item.address?.components || []).filter((entry) => entry.type === 'street_number')
                .map((entry) => buildingAddressKey(city, entry.street, entry.number)).filter(Boolean);
            const pending = [];
            const seen = new Set();
            polygons.forEach(({ hash, projected: polygon }) => {
                const id = `${item.id}/${hash}`;
                if (seen.has(id)) return;
                seen.add(id);
                // Keep source order even when clipping creates several pieces. Identity survives list reordering.
                const clipped = tools.intersection(polygon, [circle]);
                pending.push({ id, providerId: item.id,
                    address: item.address_name || item.name || '', addresses, polygons: clipped });
            });
            contours.push(...pending);
        } catch (_) { skipped += 1; }
    }
    return { contours, skipped };
}

export function prepareMapSurfaceContours(items, system, area, tools) {
    const contours = [];
    let skipped = 0;
    const pointBudget = { count: 0, max: 60000 }, circle = clippingCircle(area);
    for (const item of items) {
        try {
            if (!['road', 'parking', 'area'].includes(item.mapSurfaceKind)) throw new Error('Invalid surface');
            if (item.mapSurfaceKind === 'parking' && item.subtype && item.subtype !== 'ground') continue;
            // Point selection can have an icon-sized hover box, not a parking footprint.
            const field = item.mapSurfaceKind === 'road' ? 'hover' : 'selection';
            const polygons = readPolygons(item, system, area, tools, pointBudget, field);
            polygons.forEach(({ hash, projected: polygon }) => {
                const clipped = tools.intersection(polygon, [circle]);
                if (clipped.length) contours.push({ id: `${item.mapSurfaceKind}/${item.id}/${hash}`,
                    providerId: item.id, kind: item.mapSurfaceKind, name: item.name || '', polygons: clipped });
            });
        } catch (_) { skipped += 1; }
    }
    return { contours, skipped };
}
