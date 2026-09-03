// MGGT uses a local datum, not the WGS84 ellipsoid with a translated origin.
// Parameter provenance and accuracy limits: docs/map-coordinates.md.
export const MGGT_PROFILE = Object.freeze({
    id: 'MGGT',
    definition: '+proj=tmerc +lat_0=55.666666666666667 +lon_0=37.5 +k=1 '
        + '+x_0=16.098 +y_0=14.512 +ellps=bessel '
        + '+towgs84=316.151,78.924,589.65,-1.57273,2.69209,2.34693,8.4507 '
        + '+units=m +no_defs',
});

const MERCATOR_HALF_WORLD = Math.PI * 6378137;
const MERCATOR_MAX_LAT = 85.0511287798066;
let defaultSystemPromise = null;

export function loadMapCoordinateSystem() {
    if (!defaultSystemPromise) {
        defaultSystemPromise = import('https://cdn.jsdelivr.net/npm/proj4@2.22.0/+esm')
            .then(({ default: proj4 }) => createMapCoordinateSystem(proj4))
            .catch((error) => {
                defaultSystemPromise = null;
                throw error;
            });
    }
    return defaultSystemPromise;
}

function requireFinite(...values) {
    if (!values.every(Number.isFinite)) throw new TypeError('Coordinates must be finite numbers');
}

function requireLonLat(lon, lat, maxLat = 90) {
    requireFinite(lon, lat);
    if (Math.abs(lon) > 180 || Math.abs(lat) > maxLat) {
        throw new RangeError('Coordinates outside the projection domain');
    }
}

function requireZoom(zoom) {
    if (!Number.isInteger(zoom) || zoom < 0 || zoom > 22) {
        throw new RangeError('Tile zoom must be an integer from 0 to 22');
    }
}

export function createMapCoordinateSystem(proj4, profile = MGGT_PROFILE) {
    if (typeof proj4 !== 'function') throw new TypeError('Proj4js is required');
    if (!profile?.id || !profile?.definition) throw new TypeError('An explicit CRS definition is required');
    const crs = profile.id;
    const geographic = proj4(profile.definition, 'EPSG:4326');
    const mercator = proj4('EPSG:4326', 'EPSG:3857');

    function modelToWgs84({ east, north }) {
        requireFinite(east, north);
        const [lon, lat] = geographic.forward([east, north]);
        requireLonLat(lon, lat);
        return { lon, lat };
    }

    function wgs84ToModel({ lon, lat }) {
        requireLonLat(lon, lat);
        const [east, north] = geographic.inverse([lon, lat]);
        requireFinite(east, north);
        return { east, north };
    }

    function wgs84ToMercator({ lon, lat }) {
        requireLonLat(lon, lat, MERCATOR_MAX_LAT);
        const [x, y] = mercator.forward([lon, lat]);
        requireFinite(x, y);
        return { x, y };
    }

    function mercatorToWgs84({ x, y }) {
        requireFinite(x, y);
        if (Math.abs(x) > MERCATOR_HALF_WORLD || Math.abs(y) > MERCATOR_HALF_WORLD) {
            throw new RangeError('Coordinates outside the Web Mercator tile grid');
        }
        const [lon, lat] = mercator.inverse([x, y]);
        return { lon, lat };
    }

    function wgs84ToTile(point, zoom) {
        requireZoom(zoom);
        const { x, y } = wgs84ToMercator(point);
        const count = 2 ** zoom;
        const tileIndex = (value) => Math.max(0, Math.min(count - 1, Math.floor(value * count)));
        return {
            z: zoom,
            x: tileIndex((x + MERCATOR_HALF_WORLD) / (2 * MERCATOR_HALF_WORLD)),
            y: tileIndex((MERCATOR_HALF_WORLD - y) / (2 * MERCATOR_HALF_WORLD)),
        };
    }

    function tileBounds({ x, y, z }) {
        requireZoom(z);
        const count = 2 ** z;
        if (![x, y].every((value) => Number.isInteger(value) && value >= 0 && value < count)) {
            throw new RangeError('Tile indices outside the XYZ grid');
        }
        const size = 2 * MERCATOR_HALF_WORLD / count;
        const northWest = mercatorToWgs84({
            x: x * size - MERCATOR_HALF_WORLD,
            y: MERCATOR_HALF_WORLD - y * size,
        });
        const southEast = mercatorToWgs84({
            x: (x + 1) * size - MERCATOR_HALF_WORLD,
            y: MERCATOR_HALF_WORLD - (y + 1) * size,
        });
        return { west: northWest.lon, south: southEast.lat, east: southEast.lon, north: northWest.lat };
    }

    function getMapArea(center, { radiusMeters = 500, zoom = 17 } = {}) {
        requireFinite(center?.east, center?.north, radiusMeters);
        requireZoom(zoom);
        if (radiusMeters <= 0 || radiusMeters > 2000) {
            throw new RangeError('Map search radius must be greater than 0 and at most 2000 metres');
        }
        const wgs84Center = modelToWgs84(center);
        // Radius is in source ground metres, never in distorted EPSG:3857 metres.
        const modelBounds = {
            west: center.east - radiusMeters, south: center.north - radiusMeters,
            east: center.east + radiusMeters, north: center.north + radiusMeters,
        };
        const corners = [
            [modelBounds.west, modelBounds.south], [modelBounds.east, modelBounds.south],
            [modelBounds.east, modelBounds.north], [modelBounds.west, modelBounds.north],
        ].map(([east, north]) => modelToWgs84({ east, north }));
        const bounds = {
            west: Math.min(...corners.map((point) => point.lon)),
            south: Math.min(...corners.map((point) => point.lat)),
            east: Math.max(...corners.map((point) => point.lon)),
            north: Math.max(...corners.map((point) => point.lat)),
        };
        if (bounds.east - bounds.west > 180) throw new RangeError('Map area crosses the antimeridian');
        const min = wgs84ToTile({ lon: bounds.west, lat: bounds.north }, zoom);
        const max = wgs84ToTile({ lon: bounds.east, lat: bounds.south }, zoom);
        return {
            crs, radiusMeters, modelCenter: { ...center }, wgs84Center, modelBounds, bounds,
            tiles: { z: zoom, minX: min.x, minY: min.y, maxX: max.x, maxY: max.y,
                count: (max.x - min.x + 1) * (max.y - min.y + 1) },
        };
    }

    return Object.freeze({ crs, modelToWgs84, wgs84ToModel, wgs84ToMercator,
        mercatorToWgs84, wgs84ToTile, tileBounds, getMapArea });
}
