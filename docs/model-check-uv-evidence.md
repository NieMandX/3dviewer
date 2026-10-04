# UV evidence in model-check reports

Viewer 0.97.5 adds **Показать на текстуре** to NPM 2.5.4 and VPM 2.5.1.5 when
the report contains compatible evidence. The dialog shows two island contours,
the measured gap in original texture pixels, a full-tile preview and a sharper
crop around the witness points. It supports fit, zoom, drag and keyboard close.
The full-tile image may be reduced; it is not used to recompute the measurement.

These are saved pictures of the original checked texture, independent of current
Viewer materials and UDIM splitting. A stale report keeps its own pictures;
they are not overlaid onto a newer loaded model. No scene geometry, material,
camera or animation-loop ownership changes.

## Reading a saved report

Open **Проверка модели → Открыть отчёт JSON**, choose the normalized `report.json`
or a JSON export from the Viewer, expand the padding recommendation, then select
**Показать на текстуре**. Reading a local report does not require joining a room
or uploading its contents. The panel explicitly states that current room-source
freshness has not been checked for a saved report. It never starts a server job.
The existing runtime API configuration still controls visibility of the report
entry button.

Older reports remain readable and do not get a fabricated texture button. The
server's existing SINTEZ-based checker does not produce these pictures until a
separately verified image is deployed. The local producer is AGR Vision Model
Check 0.1.10, derived from SINTEZ 1.6.1 with GPL/provenance retained outside this
public repository. Neither private model content nor checker source is published
with the frontend.

## Optional protocol

Data lives at `additional_checks[id=AV.UV.SPACING.001].groups[].objects[].measurements.visuals`.
It augments the existing report schema; `checker_version` continues identifying
the SINTEZ base and `checker_product.version` identifies the AGR Vision revision.

- `schema`: `agr-uv-evidence-v1`.
- `profile`: `NPM` or `VPM`; `requirement_ref`: `2.5.4` or `2.5.1.5` respectively.
- `source_fbx`: original FBX filename.
- `coordinate_space`: `tile_uv_bottom_left`; all UV values in this payload are
  tile-local, closed interval `[0,1]`. PNG pixels start at the top left.
- `textures[]`: `id`, source `name`, original-byte `sha256`, original `size`,
  `tile`, and `preview { data_url, size }`.
- `cases[]`: `id`, `kind`, `texture_id`, `gap_px`, `threshold_px`, two `points_uv`,
  two lists of `island_segments_uv`, and `detail { data_url, size, region_uv }`.
  `region_uv` is `[u_min, v_min, u_max, v_max]`.
- `source_faces` records original object names and zero-based polygon indices;
  `source_face_counts` makes truncation of those lists explicit. They are not
  rendered-mesh indices and are not used to highlight imported scene triangles.

The producer preserves numerical measurements even when visual samples are
omitted. It limits samples, preview resolution and serialized visual bytes.
The current local producer uses at most 6 samples per FBX, 450 kB per group and
850 kB of visual evidence across the report. The existing worker/DB limit stays
4 MiB. These limits describe a sample of measured locations, not full coverage
or a count of model errors.

The client validates protocol/profile, finite coordinates, contour lengths,
PNG signatures and declared dimensions, source hash syntax, and consistency of
gap endpoints with the reported original-pixel distance. It accepts inline PNG
only; it never loads report-specified HTTP/file/SVG URLs. At most 24 pictures
are offered per report. HTML is not interpolated from report text.

Image callbacks are generation-guarded. Closing/replacing the report, selecting
another source, changing rooms and disposing the app clear images, canvases and
listeners. No extra server polling or continuous rendering is introduced.

## Semantics and checks

Padding measurements remain advisory: the geometry cannot establish whether
images should be unique or whether pixels outside an island have been filled.
The numerical reference is not reused as a tile-border requirement. A partial
geometry pass is identified in the dialog.

`smoke-model-check-uv.mjs` covers visible controls, UV/PNG vertical orientation
with pixel assertions, malformed evidence, old reports, saved JSON reading,
mobile width, nested Escape/focus restoration, room changes and disposal.
It is part of `npm run ci:verify`. Private real-ZIP producer/output checks and
screenshots are kept in the local knowledge base. Desktop emulation does not
establish physical mobile or hardware WebGPU behavior.

## 3D witness navigation (Viewer 0.97.7 / local Checker 0.1.11)

The texture dialog adds **Показать в 3D** when a compatible `scene_anchor` is
present. Import the source ZIP first, open its saved JSON, then choose the
texture sample. The two modals temporarily close; a toolbar focuses A/B,
returns to the texture, clears the highlight, or explicitly enables seeing
the highlight through intervening surfaces. The overlay marks the measured
edge and adjacent rendered triangles, not the entire UV island. Camera framing
tries to stop before a nearby wall/ceiling; dense or internal geometry may
still require orbiting or the through-surfaces mode.

`cases[].scene_anchor` contains `schema: agr-uv-edge-v1`,
`coordinate_space: fbx_geometry_identity`, `fbx_sha256`, and two `edges` with
string `model_id`, `edge_uv` (2x2) and `edge_xyz` (2x3). The producer associates
only unique binary-FBX Model names at import, verifies raw Geometry vertices
against the imported Float32 coordinates, excludes nonidentity geometric
transforms, and fingerprints the imported positions/topology/active UV data.
Later mesh/UV edits, ambiguous names or unsupported source frames omit the
3D anchor while retaining the ordinary report and texture view.

The Viewer hashes the original FBX buffer once for ZIP imports, preserves the
loader's Model ID before worker JSON serialization and carries it through
UDIM splitting. These are the [r186 loader's actual Model IDs](https://github.com/mrdoob/three.js/blob/r186/examples/jsm/loaders/FBXLoader.js),
not generated display names. A single loaded NPM/VPM ZIP record must match
the FBX hash and filename. The locator matches the source UV edge (including
its UDIM origin) and **exact Float32 endpoint positions** within that Model ID.
This disambiguates repeated facade UVs. Blender polygon numbers are never
used as rendered triangle indices. Different FBXs, duplicate loaded copies,
hidden/deformed/animated meshes, missing or ambiguous edges are not guessed.
Limits: two million triangles, four seconds, at most sixteen coincident
edge hits per endpoint; incomplete searches produce a visible explanation.

Search yields periodically and is generation guarded. Closing/selecting a
different sample, replacing the report, switching rooms or disposing the
application cancels pending highlighting. Removing/hiding/changing the
matched model clears the overlay through the existing report context check.
Overlays own their geometry/materials, do not enter `loadedModels`, do not
change `_origMaterial`, and are excluded from export/bounds and picking.
Rendering still uses `requestRender()`; no new animation loop or polling
timer is introduced. World transforms/rebase are followed by the overlay.

`smoke-model-check-3d.mjs` exercises exact identity, repeated UVs, worker JSON,
UDIM split, negative scale/rebase, stale source, duplicates, limits, hidden
objects, A/B navigation, return to texture and room cleanup. Private K1 and
NPM outputs were also matched in actual Chrome WebGPU and WebGL. Physical
mobile testing, arbitrary FBX exporters and nonidentity geometric transforms
remain outside the verified scope. The deployed checker and production
frontend are still separate releases; older server reports have no anchors.

The 3D transition waits for import finalization: while an import is queued or
loaded models have not been finalized, the dialog asks the user to retry after
loading. This prevents final import framing from overwriting the witness view.
