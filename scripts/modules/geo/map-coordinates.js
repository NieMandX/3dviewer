// MGGT uses a local datum, not the WGS84 ellipsoid with a translated origin.
// Parameter provenance and accuracy limits: docs/map-coordinates.md.
export const MGGT_PROFILE = Object.freeze({
    id: 'MGGT',
    definition: '+proj=tmerc +lat_0=55.666666666666667 +lon_0=37.5 +k=1 '
        + '+x_0=16.098 +y_0=14.512 +ellps=bessel '
        + '+towgs84=316.151,78.924,589.65,-1.57273,2.69209,2.34693,8.4507 '
        + '+units=m +no_defs',
});

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

function requireLonLat(lon, lat) {
    requireFinite(lon, lat);
    if (Math.abs(lon) > 180 || Math.abs(lat) > 90) {
        throw new RangeError('Coordinates outside the projection domain');
    }
}

export function createMapCoordinateSystem(proj4, profile = MGGT_PROFILE) {
    if (typeof proj4 !== 'function') throw new TypeError('Proj4js is required');
    if (!profile?.id || !profile?.definition) throw new TypeError('An explicit CRS definition is required');
    const crs = profile.id;
    const geographic = proj4(profile.definition, 'EPSG:4326');

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

    function getMapArea(center, { radiusMeters = 500 } = {}) {
        requireFinite(center?.east, center?.north, radiusMeters);
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
        return {
            crs, radiusMeters, modelCenter: { ...center }, wgs84Center, modelBounds, bounds,
        };
    }

    return Object.freeze({ crs, modelToWgs84, wgs84ToModel, getMapArea });
}
