import * as THREE from 'three';
import { loadMapCoordinateSystem } from './geo/map-coordinates.js';

const DEFAULT_PARCELS_CONFIG = Object.freeze({
    datasetId: 1497,
    baseUrl: 'https://apidata.mos.ru/v1/datasets',
    apiKey: '',
    filter: null,
    targetGlobalId: null,
});

let parcelsConfig = { ...DEFAULT_PARCELS_CONFIG };
let _vpmReferenceHeight = null;

// ------------------------------------------------------------------
// Utilities
// ------------------------------------------------------------------
function parseGeoNumber(value, fallback = null) {
    if (value == null) return fallback;
    if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
    if (typeof value === 'string') {
        const cleaned = value.trim().replace(/\s+/g, '').replace(',', '.');
        const num = parseFloat(cleaned);
        return Number.isFinite(num) ? num : fallback;
    }
    return fallback;
}

function normalizeGeomFromFeature(feature) {
    if (!feature) return null;
    let geom = feature.geometry || null;

    if (!geom || !geom.coordinates) {
        const possible = feature.properties?.geoData || feature.properties?.GeoData || feature.properties?.geom || feature.properties?.geometry;
        if (typeof possible === 'string') {
            try { geom = JSON.parse(possible); }
            catch (_) { /* ignore */ }
        } else if (possible && typeof possible === 'object') {
            geom = possible;
        }
    }

    if (geom && !geom.coordinates && Array.isArray(geom.rings)) {
        const coords = geom.rings.map(ring => ring.map(pt => [Number(pt[0] ?? pt.x), Number(pt[1] ?? pt.y)]));
        geom = { type: 'Polygon', coordinates: coords };
    }

    if (geom && geom.coordinates && geom.type === 'Polygon') {
        geom.coordinates = geom.coordinates.map(ring =>
            ring.map(pair => [Number(pair[0]), Number(pair[1])])
        );
    } else if (geom && geom.coordinates && geom.type === 'MultiPolygon') {
        geom.coordinates = geom.coordinates.map(poly =>
            poly.map(ring => ring.map(pair => [Number(pair[0]), Number(pair[1])]))
        );
    }

    return geom;
}

function parseHeightFromFeature(feature) {
    if (!feature) return null;
    const props = feature.properties || {};
    const attrs = props.attributes || props.Attributes || props;
    if (attrs) {
        const keys = ['h_relief', 'H_RELIEF', 'HRelief', 'relief', 'RELIEF', 'height', 'HEIGHT', 'Elevation', 'elevation', 'H_GEOM', 'H_BALT'];
        for (const key of keys) {
            if (attrs[key] != null) {
                const parsed = parseGeoNumber(attrs[key], null);
                if (Number.isFinite(parsed)) return parsed;
            }
        }
    }

    const geom = feature.geometry;
    if (geom && geom.type === 'Point' && Array.isArray(geom.coordinates) && geom.coordinates.length >= 3) {
        const candidate = parseGeoNumber(geom.coordinates[2], null);
        if (Number.isFinite(candidate)) return candidate;
    }

    return null;
}

function matchesTargetGlobalId(feature, normalizedTarget) {
    if (!normalizedTarget) return true;
    if (!feature) return false;
    const props = feature.properties || {};
    const attrs = props.attributes || props.Attributes || props;
    const fromAttrs = attrs?.global_id ?? attrs?.GLOBAL_ID;
    const direct = feature.global_id ?? feature.GLOBAL_ID ?? feature.id;
    const candidate = fromAttrs ?? direct;
    return candidate != null && String(candidate) === normalizedTarget;
}

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------
export function configureParcels(options = {}) {
    if (options == null) return { ...parcelsConfig };
    const cleaned = { ...options };
    if (cleaned.filter === '' || cleaned.filter === undefined) cleaned.filter = null;
    if (cleaned.targetGlobalId === '' || cleaned.targetGlobalId === undefined) cleaned.targetGlobalId = null;
    parcelsConfig = {
        ...parcelsConfig,
        ...Object.fromEntries(Object.entries(cleaned).filter(([, v]) => v !== undefined)),
    };
    return { ...parcelsConfig };
}

export function getParcelsConfig() {
    return { ...parcelsConfig };
}

export function setVPMReferenceHeight(height) {
    _vpmReferenceHeight = Number.isFinite(height) ? height : _vpmReferenceHeight;
    return _vpmReferenceHeight;
}

export function getVPMReferenceHeight() {
    return _vpmReferenceHeight;
}

export function resetVPMReferenceHeight() {
    _vpmReferenceHeight = null;
}

export async function createParcelsGroupFromGeoJSON(geojson, options = {}) {
    let features = Array.isArray(geojson?.features) ? geojson.features : [];
    if (!features.length && Array.isArray(geojson)) features = geojson;
    if (!features.length) return null;

    const coordinateSpace = options.coordinateSpace ?? 'wgs84';
    if (!['wgs84', 'model'].includes(coordinateSpace)) throw new Error('Unknown parcel coordinate space');
    const coordinateSystem = coordinateSpace === 'wgs84'
        ? (options.coordinateSystem || await loadMapCoordinateSystem()) : null;

    const verticalIsZ = options.verticalIsZ ?? true;
    let originMeters = options.origin ? { ...options.origin } : null;
    let heightMeters = Number.isFinite(options.referenceHeight) ? options.referenceHeight : _vpmReferenceHeight;

    const rings = [];

    const convert = (lon, lat) => {
        const point = coordinateSystem ? coordinateSystem.wgs84ToModel({ lon, lat }) : { east: lon, north: lat };
        if (![point.east, point.north].every(Number.isFinite)) throw new Error('Invalid parcel coordinate');
        const meters = { x: point.east, y: point.north };

        if (!originMeters) originMeters = { ...meters };

        const originX = originMeters?.x || 0;
        const originY = originMeters?.y || 0;

        const east = meters.x - originX;
        const north = meters.y - originY;

        return { east, north };
    };

    const addRing = (ringCoords, isHole = false) => {
        if (!Array.isArray(ringCoords) || ringCoords.length < 4) return;
        const positions = [];
        const lastIndex = ringCoords.length - 1;
        for (let i = 0; i < ringCoords.length; i++) {
            const coord = ringCoords[i] || [];
            const lon = coord[0];
            const lat = coord[1];
            const alt = coord.length > 2 ? parseGeoNumber(coord[2], null) : null;
            if (i === lastIndex) {
                const [lon0, lat0] = ringCoords[0];
                if (Math.abs(lon - lon0) < 1e-9 && Math.abs(lat - lat0) < 1e-9) continue;
            }
            const { east, north } = convert(lon, lat);
            if (verticalIsZ) {
                positions.push(east, north, 0.05);
            } else {
                positions.push(east, 0.05, -north);
            }
            if (heightMeters == null && Number.isFinite(alt)) {
                heightMeters = alt;
            }
        }
        if (positions.length < 6) return;
        rings.push({ positions, isHole });
    };

    features.forEach((feature) => {
        const geom = normalizeGeomFromFeature(feature);
        if (!geom || !geom.coordinates) return;
        if (heightMeters == null) {
            const h = parseHeightFromFeature(feature);
            if (Number.isFinite(h)) heightMeters = h;
        }
        if (geom.type === 'Polygon') {
            const [outer, ...holes] = geom.coordinates || [];
            addRing(outer, false);
            holes?.forEach((ring) => addRing(ring, true));
        } else if (geom.type === 'MultiPolygon') {
            geom.coordinates?.forEach((polygon) => {
                const [outer, ...holes] = polygon || [];
                addRing(outer, false);
                holes?.forEach((ring) => addRing(ring, true));
            });
        }
    });

    if (!rings.length) return null;

    // Projection/validation completes before allocating scene resources.
    const group = new THREE.Group();
    group.name = options.groupName || 'Parcels (data.mos.ru)';
    group.userData.excludeFromBounds = false;
    const lineMaterial = options.material || new THREE.LineBasicMaterial({
        color: 0xff8c42, transparent: true, opacity: 0.9,
    });
    for (const { positions, isHole } of rings) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.computeBoundingSphere();
        const line = new THREE.LineLoop(geometry, isHole ? lineMaterial.clone() : lineMaterial);
        line.userData.excludeFromBounds = false;
        group.add(line);
    }

    group.userData.originMeters = originMeters;
    group.userData.verticalIsZ = verticalIsZ;
    if (Number.isFinite(heightMeters)) group.userData.height = heightMeters;

    const elevation = Number.isFinite(heightMeters) ? heightMeters : 0;
    if (originMeters) {
        if (verticalIsZ) {
            group.position.set(originMeters.x, originMeters.y, elevation);
        } else {
            group.position.set(originMeters.x, elevation, -originMeters.y);
        }
    } else if (Number.isFinite(heightMeters)) {
        if (verticalIsZ) {
            group.position.set(group.position.x, group.position.y, elevation);
        } else {
            group.position.set(group.position.x, elevation, group.position.z);
        }
    }

    return group;
}

const MAX_API_PAGE_SIZE = 1000;

export async function fetchParcelsPage({ top = MAX_API_PAGE_SIZE, skip = 0, filter = parcelsConfig.filter, signal } = {}) {
    if (!parcelsConfig.apiKey) throw new Error('MOS parcels API key is not configured');
    const url = new URL(`${parcelsConfig.baseUrl}/${parcelsConfig.datasetId}/features`);
    url.searchParams.set('api_key', parcelsConfig.apiKey);
    url.searchParams.set('$format', 'geojson');
    if (top != null) url.searchParams.set('$top', String(top));
    if (skip) url.searchParams.set('$skip', String(skip));
    if (filter) url.searchParams.set('$filter', filter);

    const response = await fetch(url.toString(), { signal });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`MOS API ${response.status}: ${text || response.statusText}`);
    }
    return response.json();
}

export async function loadParcels(options = {}) {
    const {
        fetchAll = true,
        batchSize = MAX_API_PAGE_SIZE,
        initialTop = MAX_API_PAGE_SIZE,
        maxRecords = parcelsConfig.targetGlobalId ? 1 : Infinity,
        filter = parcelsConfig.filter,
        targetGlobalId = parcelsConfig.targetGlobalId,
        onProgress,
        signal,
        skip = 0,
    } = options;

    const collected = [];
    let processedCount = 0;
    let currentSkip = skip;
    const normalizedTarget = (targetGlobalId !== undefined && targetGlobalId !== null && targetGlobalId !== '') ? String(targetGlobalId) : null;

    const maxMatches = maxRecords > 0 ? maxRecords : Infinity;

    while (true) {
        if (signal?.aborted) break;
        const requestedSize = fetchAll ? batchSize : initialTop;
        const chunkSize = Math.max(1, Math.min(requestedSize, MAX_API_PAGE_SIZE));
        const geojson = await fetchParcelsPage({
            top: chunkSize,
            skip: currentSkip,
            filter,
            signal,
        });
        const rawFeatures = Array.isArray(geojson?.features)
            ? geojson.features
            : Array.isArray(geojson) ? geojson : [];

        if (!rawFeatures.length) break;

        processedCount += rawFeatures.length;

        for (const feature of rawFeatures) {
            if (matchesTargetGlobalId(feature, normalizedTarget)) {
                collected.push(feature);
                if (collected.length >= maxMatches) break;
            }
        }

        if (typeof onProgress === 'function') {
            try {
                onProgress({
                    collectedCount: collected.length,
                    processedCount,
                    chunkSize,
                    receivedCount: rawFeatures.length,
                    skip: currentSkip,
                });
            } catch (__) { /* noop */ }
        }

        if (collected.length >= maxMatches) break;

        if (!fetchAll) break;
        if (rawFeatures.length < chunkSize) break;
        if (normalizedTarget && collected.length) break;

        currentSkip += rawFeatures.length;
    }

    return { features: collected, processedCount };
}

export { parseGeoNumber };
