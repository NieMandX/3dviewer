import * as THREE from 'three';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const ARCSEC_TO_RAD = Math.PI / (180 * 3600);

const WGS84_PARAMS = Object.freeze({
    a: 6378137.0,
    invF: 298.257223563,
});

const HELMERT_WGS84_TO_BESSEL = Object.freeze({
    // dx: -23.92,
    dx: -23.92,
    dy: 141.27,
    dz: -80.9,
    rxSec: 0.0,
    rySec: 0.0,
    rzSec: -0.35,
    scalePpm: 0.12,
});

const MSK77_PARAMS = Object.freeze({
    a: 6377397.155,
    invF: 299.1528128,
    lon0Deg: 37.5,
    lat0Deg: 55 + 40 / 60,
    k0: 1.0,
    falseEasting: 5,
    falseNorthing: 0,
});

const DEFAULT_PARCELS_CONFIG = Object.freeze({
    datasetId: 1497,
    baseUrl: 'https://apidata.mos.ru/v1/datasets',
    apiKey: '',
    filter: null,
    targetGlobalId: null,
});

let parcelsConfig = { ...DEFAULT_PARCELS_CONFIG };
let _msk77Origin = null;
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

function geodeticToCartesian(lonDeg, latDeg, ellipsoid, height = 0) {
    const { a, invF } = ellipsoid;
    const f = 1 / invF;
    const e2 = 2 * f - f * f;
    const lon = lonDeg * DEG2RAD;
    const lat = latDeg * DEG2RAD;

    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const sinLon = Math.sin(lon);
    const cosLon = Math.cos(lon);

    const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
    const X = (N + height) * cosLat * cosLon;
    const Y = (N + height) * cosLat * sinLon;
    const Z = (N * (1 - e2) + height) * sinLat;
    return { x: X, y: Y, z: Z };
}

function cartesianToGeodetic(X, Y, Z, ellipsoid) {
    const { a, invF } = ellipsoid;
    const f = 1 / invF;
    const e2 = 2 * f - f * f;
    const ePrime2 = e2 / (1 - e2);

    const p = Math.sqrt(X * X + Y * Y);
    if (p === 0) {
        return { lon: 0, lat: Z >= 0 ? 90 : -90 };
    }

    let lat = Math.atan2(Z, p * (1 - e2));
    for (let i = 0; i < 5; i++) {
        const sinLat = Math.sin(lat);
        const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
        lat = Math.atan2(Z + ePrime2 * N * sinLat, p);
    }

    const lon = Math.atan2(Y, X);
    const lonDeg = ((lon * RAD2DEG + 540) % 360) - 180;
    const latDeg = lat * RAD2DEG;
    return { lon: lonDeg, lat: latDeg };
}

function applyHelmertTransform(x, y, z, params) {
    const s = params.scalePpm * 1e-6;
    const rx = params.rxSec * ARCSEC_TO_RAD;
    const ry = params.rySec * ARCSEC_TO_RAD;
    const rz = params.rzSec * ARCSEC_TO_RAD;

    const x2 = params.dx + (1 + s) * x - rz * y + ry * z;
    const y2 = params.dy + rz * x + (1 + s) * y - rx * z;
    const z2 = params.dz - ry * x + rx * y + (1 + s) * z;
    return { x: x2, y: y2, z: z2 };
}

function wgs84ToBessel(lonDeg, latDeg) {
    const cart = geodeticToCartesian(lonDeg, latDeg, WGS84_PARAMS, 0);
    const transformed = applyHelmertTransform(cart.x, cart.y, cart.z, HELMERT_WGS84_TO_BESSEL);
    return cartesianToGeodetic(transformed.x, transformed.y, transformed.z, MSK77_PARAMS);
}

function projectToGaussKruger(lonDeg, latDeg, params) {
    const { a, invF, lon0Deg, k0 } = params;
    const lon0 = lon0Deg * DEG2RAD;
    const f = 1 / invF;
    const e2 = 2 * f - f * f;
    const e2Prime = e2 / (1 - e2);

    const B = latDeg * DEG2RAD;
    const L = lonDeg * DEG2RAD;
    const dLon = L - lon0;
    const l = Math.atan2(Math.sin(dLon), Math.cos(dLon));

    const sinB = Math.sin(B);
    const cosB = Math.cos(B);
    const t = Math.tan(B);
    const t2 = t * t;
    const t4 = t2 * t2;
    const t6 = t4 * t2;
    const eta2 = e2Prime * cosB * cosB;

    const cosB2 = cosB * cosB;
    const cosB3 = cosB2 * cosB;
    const cosB4 = cosB2 * cosB2;
    const cosB5 = cosB4 * cosB;
    const cosB6 = cosB3 * cosB3;
    const cosB7 = cosB6 * cosB;

    const N = a / Math.sqrt(1 - e2 * sinB * sinB);

    const e4 = e2 * e2;
    const e6 = e4 * e2;

    const A0 = 1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256;
    const A2 = (3 / 8) * (e2 + e4 / 4 + 15 * e6 / 128);
    const A4 = (15 / 256) * (e4 + 3 * e6 / 4);
    const A6 = (35 * e6) / 3072;

    const sigma = a * (A0 * B - A2 * Math.sin(2 * B) + A4 * Math.sin(4 * B) - A6 * Math.sin(6 * B));

    const l2 = l * l;
    const l3 = l2 * l;
    const l4 = l2 * l2;
    const l5 = l4 * l;
    const l6 = l4 * l2;
    const l7 = l6 * l;

    const northing = sigma
        + (N * t * cosB2 * l2) / 2
        + (N * t * cosB4 * l4 / 24) * (5 - t2 + 9 * eta2 + 4 * eta2 * eta2)
        + (N * t * cosB6 * l6 / 720) * (61 - 58 * t2 + t4 + 270 * eta2 - 330 * t2 * eta2);

    const easting = N * cosB * l
        + (N * cosB3 * l3 / 6) * (1 - t2 + eta2)
        + (N * cosB5 * l5 / 120) * (5 - 18 * t2 + t4 + 14 * eta2 - 58 * t2 * eta2)
        + (N * cosB7 * l7 / 5040) * (61 - 479 * t2 + 179 * t4 - t6);

    return {
        x: easting * k0,
        y: northing * k0,
    };
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
    if (options.resetOrigin) _msk77Origin = null;
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

export function lonLatToMSK77(lonDeg, latDeg) {
    const { falseEasting, falseNorthing, lat0Deg } = MSK77_PARAMS;

    if (!_msk77Origin) {
        const originProjected = projectToGaussKruger(MSK77_PARAMS.lon0Deg, lat0Deg, MSK77_PARAMS);
        _msk77Origin = {
            x: originProjected.x - falseEasting,
            y: originProjected.y - falseNorthing,
        };
    }

    const besselCoords = wgs84ToBessel(lonDeg, latDeg);
    const projLon = Number.isFinite(besselCoords.lon) ? besselCoords.lon : lonDeg;
    const projLat = Number.isFinite(besselCoords.lat) ? besselCoords.lat : latDeg;
    const projected = projectToGaussKruger(projLon, projLat, MSK77_PARAMS);
    return {
        x: projected.x - _msk77Origin.x + falseEasting,
        y: projected.y - _msk77Origin.y + falseNorthing,
    };
}

export function createParcelsGroupFromGeoJSON(geojson, options = {}) {
    let features = Array.isArray(geojson?.features) ? geojson.features : [];
    if (!features.length && Array.isArray(geojson)) features = geojson;
    if (!features.length) return null;

    const verticalIsZ = options.verticalIsZ ?? true;
    let originMeters = options.origin ? { ...options.origin } : null;
    let heightMeters = Number.isFinite(options.referenceHeight) ? options.referenceHeight : _vpmReferenceHeight;

    const group = new THREE.Group();
    group.name = options.groupName || 'Parcels (data.mos.ru)';
    group.userData.excludeFromBounds = false;

    const lineMaterial = options.material || new THREE.LineBasicMaterial({
        color: 0xff8c42,
        transparent: true,
        opacity: 0.9,
    });

    const convert = (lon, lat) => {
        let meters;
        if (Math.abs(lon) > 180 || Math.abs(lat) > 90) {
            meters = { x: Number(lon), y: Number(lat) };
        } else {
            meters = lonLatToMSK77(lon, lat);
        }

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
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.computeBoundingSphere();
        const line = new THREE.LineLoop(geometry, isHole ? lineMaterial.clone() : lineMaterial);
        line.userData.excludeFromBounds = false;
        group.add(line);
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

    if (!group.children.length) return null;

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
