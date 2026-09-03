# Map Coordinate Reference

The viewer uses a separate horizontal coordinate service for MGGT models, map
selection and geographic overlays. It does not move imported meshes, change the
camera, interpret model heights as GPS heights, or download map tiles itself.

## Coordinate Contract

- Source coordinates: MGGT metres, named `east` and `north` explicitly.
- Geodetic tables often call northing X and easting Y. Do not copy that order
  into the viewer's normalized Cartesian X/Y axes.
- Normalized Y-up scene: `(east, height, -north)`; Z-up: `(east, north, height)`.
- WGS84/API: longitude then latitude, EPSG:4326.
- XYZ tile grid: EPSG:3857, X grows east, Y grows south. This is not TMS.
- Radius 500 means ground/model metres. It is not 500 EPSG:3857 metres.
- World rebase is a display transform, never part of a CRS definition.
- Heights retain the model's vertical reference. No vertical datum conversion
  is implemented or implied.

`createMapReferenceController` derives bounds from attached loaded model meshes
in the `world` coordinate frame. Camera movement, rebase, world rotation/scale,
and auxiliary scene layers do not change the horizontal coordinates. This
assumes the source models really are georeferenced in MGGT; arbitrary local
models must not be interpreted as located in Moscow.

## Projection

Proj4js 2.22.0 is loaded lazily from a pinned CDN URL. Merely starting the viewer
does not load it. Browser and CI use the same version. Import failure can be
retried; disposed controllers reject late results.

The MGGT preset uses a Bessel transverse Mercator projection and a seven-parameter
datum transformation. The retired hand-written `parcels.js` datum conversion is
not used. Its effective double false easting and Cartesian latitude
iteration are also removed. Existing projected parcel data must explicitly use
`coordinateSpace: 'model'`; WGS84 is the default for geographic API responses.

Parameter source: [X-PAD technical support, MGGT setup](https://maxima-geo.ru/xpad_ultimate_survey_coord_system).
The published rotation convention has opposite signs to PROJ position-vector
`towgs84`. The resulting string is in `MGGT_PROFILE`; it is a local identifier,
not an invented EPSG code. A different documented project CRS can be passed to
`createMapCoordinateSystem(proj4, profile)`.

Regression coordinates: [Alabyshevo published report, printed page 31](https://www.mos.ru/upload/documents/files/5663/Alabyshevo.pdf).
Three published coordinate pairs check both directions independently of a
round-trip test. The current model centre also has a separately computed PROJ
reference result. XYZ numbering follows [OpenStreetMap's XYZ specification](https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames).

These are cartographic checks, not survey certification. A second published
dataset ([Podosinki report](https://www.mos.ru/upload/documents/files/8238/AKTGIKEPodosinki1.pdf))
differed by about 8 m with this preset. Thus successful
Alabyshevo regression does not establish universal centimetre accuracy. Before
accepting facade/road alignment at a particular site, check site control points
and the provider's own map accuracy. Do not tune global offsets to match one
image. Authoritative project-specific transformation data should replace the
preset when available.

## Viewer API

```js
const area = await viewerApp.mapReference.getMapArea({ radiusMeters: 500, zoom: 17 });
// area.modelCenter: { east, north }
// area.wgs84Center: { lon, lat }
// area.bounds: WGS84 bounding rectangle enclosing the search area
// area.tiles: { z, minX, minY, maxX, maxY, count }
```

For 2GIS Places, pass `point=lon,lat` and `radius=500`. Do not substitute the
bounding rectangle for the circular filter. Tile coverage is rectangular and
may include areas outside the circle; crop the displayed environment separately.
This service computes the tile range without allocating or fetching the tiles.

The 2GIS demo key is deliberately absent from the source and configuration.
Data retrieval and rendering of a new environment layer are a separate step.

## Tests

`node scripts/ci/smoke-map-coordinates.mjs` checks projections and tile math.
`npm run ci:verify` also covers the actual CDN module in Chromium, Y-up/Z-up,
rebase and world transforms, late initialization during model changes, disposal,
and the migrated parcel conversion. Existing parcel load/dispose races remain
covered by the viewer smoke suite.
