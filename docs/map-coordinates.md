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

## Map Underlay

After importing an MGGT model, open the sidebar's **Карта** section, enter a
2GIS API key, and enable **Подложка 2ГИС**. **Непрозрачность** controls opacity:
100% is opaque, 0% is invisible. The key stays in the current page's password
input, is cleared on disposal/reload, and is not stored in localStorage,
sessionStorage, configuration, diagnostics, exports or the repository.

The layer uses the public [2GIS Raster Tiles API](https://docs.2gis.com/maps/others/rastertiles/overview),
not the MapGL-only vector tiles. The key must have Raster Tiles API access;
demo access is temporary and provider quotas still apply. Requests go directly
to 2GIS over HTTPS with no credentials or referrer. There is no persistent tile
cache or automatic background retry/download. Attribution remains visible while
the map is enabled, including with the sidebar closed.

The atlas covers a 500 m radius around the union of attached model bounds,
at XYZ zoom 17, with at most 64 tiles and four concurrent requests. Display
geometry is circular in source ground metres; each vertex's UV is projected
into Web Mercator. Local mesh coordinates avoid Float32 precision loss. The
plane is 0.2 m below the model's lowest source elevation; it is not a terrain
height model. This is a raster map, not extracted buildings or road geometry.

The underlay follows `world` rebase but is excluded from scene framing,
export and picking. It preserves its material across shading modes and adds
one mesh/texture, with no per-frame tile lookup. Opacity changes only request a
short render burst. Import finalization and room/model cleanup invalidate the
layer; enable it again after the new model finishes loading. Disabling or
disposing aborts requests, rejects late results, closes decoded bitmaps and
disposes GPU resources. A failed/partial atlas is never attached to the scene.

## Tests

`node scripts/ci/smoke-map-coordinates.mjs` checks projections and tile math.
`npm run ci:verify` also covers the actual CDN module in Chromium, Y-up/Z-up,
rebase and world transforms, late initialization during model changes, disposal,
and the migrated parcel conversion. Existing parcel load/dispose races remain
covered by the viewer smoke suite.

`smoke-map-underlay.mjs`, included in `ci:verify`, checks bounded downloads,
reprojected geometry/UVs, WebGL pixels, shading preservation, cancellation
during image decode, stale model bounds, HTTP errors, timeout, resource disposal,
and desktop/mobile controls. It uses synthetic tiles and never a real API key.
Live verification also loaded the Antonova-Ovsienko FBX archive with 49 actual
tiles in WebGPU. Alignment is cartographic, subject to the CRS limits above.

## 2GIS surroundings and building heights (pilot)

The **Окружение 2ГИС** checkbox uses the same in-memory 2GIS key, independently
of the raster underlay. It requests Places API building, street/road, parking and place
hover polygons within 500 m, plus OSM building height/address tags from Overpass. OSM geometry is not
displayed or used for nearest-neighbour matching. The 2GIS hover geometry is
cartographic selection geometry, not a guaranteed surveyed building footprint.

Matching uses full normalized addresses, preserving house suffixes, corpus,
structure and slash order. Missing OSM city is scoped to Moscow for this MGGT
pilot. For several contours at one address, equally many OSM records are paired
in source contour order. Missing heights keep their position; unequal counts
remain unresolved. Initial pairings are retained in a bounded localStorage
identity cache (at most 1000 pairs), so response reordering does not swap heights.
Provider keys and height values are never stored in that cache. These ordered
matches are assumptions, not verified building-part identities.

Street and road hover polygons are drawn as road surfaces, and ground-parking
selection polygons as lighter paved areas. Point-only parking records and underground
or multilevel parking are not turned into ground surfaces. These are selection geometry rather than surveyed
road edges. Place (`adm_div.place`) polygons are shown only as territory outlines,
not as invented paving or grass. Places API does not expose the complete basemap land-use, vegetation,
yard, marking or terrain geometry through this endpoint; the raster underlay remains
the complete visual context for those categories. Surface results are clipped to
the same 500 m circle and share the building layer lifecycle and five-minute cache.
A failed surface category does not discard other successfully loaded categories.

Height priority is `height` (metres or explicitly marked feet), then
`building:levels * 3 m` as an estimate. The common base elevation comes from the
loaded model's minimum height, not a terrain survey. Unknown-height footprints
remain flat outlines. Polygon holes are preserved and the display is clipped
to a 128-sided 500 m circle using polygon-clipping; WKT is parsed by Terraformer.
The independent layer is excluded from bounds, exports, picking and shading
overrides. Import cleanup/finalization invalidates it; disable/dispose aborts
pending requests and frees its geometries and shared materials.

The pilot deliberately caps each 2GIS query (buildings, streets/roads, parking, places)
at five pages of ten records, matching the demo key's limit. Partial coverage is shown in the UI, never described as the full
room surroundings. There is one OSM query per explicit load, no polling/retry,
and a five-minute in-memory response cache. An OSM failure leaves flat contours.
Both providers are attributed while visible. Public Overpass is for this small,
manual feasibility test: a broadly used production integration must use a
permitted hosted/self-hosted endpoint or the planned 2GIS height export, not
depend on the community public instance as its backend.

`smoke-building-heights.mjs` and `smoke-map-buildings.mjs` run in `ci:verify`:
address normalization, contour order and persisted pairing, missing/conflicting
counts, source height/estimated floors, real WKT/clip/extrusion, holes and radius,
Y-up/Z-up, WebGL pixels, material preservation, cancellation/stale writes,
timeouts/provider failures, bounded pagination/cache, disposal and mobile UI.
Surface checks also cover roads, ground parking, territory outlines, rejection of
point-only and underground parking, clipping and holes, per-category failures,
empty results and preservation of existing building contour IDs.
