# LPMVIEW Developer And Codex Handoff

Last verified (viewer runtime): 2026-10-02; infrastructure inventory: 2026-09-11.

This document transfers engineering context, not credentials. Secret values
must be transferred through personal account access or a password manager,
never through Git, chat or an AI prompt.

## 1. Source Of Truth

- Repository: `git@github.com:NieMandX/3dviewer.git`.
- Active integration/deployment branch: `gh-pages`.
- Local checkout used by the project owner: `/Users/mac/development/IMA/LPMVIEW/app`.
- Current viewer version: `0.97.15` (2026-10-06). See `docs/viewer-r186-upgrade.md` for migration checks.
- Current Three.js version: exact CDN pin `0.186.0` for core, WebGPU, TSL,
  addons, workers and Draco.
- Latest GLB implementation commit at handoff: `aa6e917`.

Read `AGENTS.md` first. The detailed architecture is in
`docs/viewer-memory/LPMVIEW_architecture_memory.md`.

## 2. Published Viewers

### Latest test build

- URL: `https://niemandx.github.io/3dviewer/`.
- Source: current `gh-pages` branch.
- Every push runs PostgreSQL permission tests, syntax/version checks,
  Playwright smoke tests and then deploys static assets.
- Since 2026-09-25, automatic publication is GitHub Pages only. The optional
  mirror to `s3://agr.vision/` in Yandex Object Storage requires explicit owner
  approval and a manual workflow run with `sync_yandex` enabled (default: false).

### Production domain

- URL: `https://agr.vision/`.
- Host: Yandex VM `viewer-voice-01`, public IP `93.77.182.247`.
- Server: Caddy container `deploy-caddy-1`.
- Frontend host path: `/opt/lpmview/viewer/current`.
- Immutable releases:
  `/opt/lpmview/viewer/current/.releases/<version>-<git-sha>`.
- Public build at the original handoff: `0.95-c8d2e11fc359`. Version 0.96 is
  approved for promotion on 2026-09-25; verify the live build via `/version.json`.
- Production is intentionally not updated by each `gh-pages` push. Follow
  `docs/viewer-releases.md` for explicit promotion and rollback.

### Backups

- Viewer 0.9 server archive:
  `/var/backups/lpmview-viewer/agr-vision-0.9-20260902T201505Z.tar.gz`.
- A second 0.9 copy exists outside the repository in the owner's
  `LPMVIEW/backups/` directory.
- Supabase backups on `viewer-backend-01`:
  `/var/backups/lpmview-supabase`, retained for seven days by systemd timer.
- An offsite database backup remains a required infrastructure task.

## 3. Runtime Architecture

Entry chain:

1. `index.html`
2. `scripts/viewer-app.js`
3. `scripts/modules/app/viewer-app-main.js`

Primary subsystem boundaries:

- Renderer and scene: `scripts/modules/render/*`, `scripts/modules/scene/*`.
- Import: `scripts/modules/io/*`, `scripts/modules/workers/*`.
- Materials: `scripts/modules/material/*`.
- Collaboration: `scripts/modules/collab/*`.
- Annotations: `scripts/modules/annotations/annotations-3d.js`.
- UI: `scripts/modules/ui/*`.
- Geographic integration: `scripts/modules/geo/*`.

`viewer-app-main.js` is the composition root. Controllers should own their
listeners, timers, async generations and disposal. Avoid adding more unrelated
business logic directly to the composition root.

## 4. Critical Engineering Contracts

### Renderer and lifecycle

- Default renderer is WebGPU with a WebGL fallback/query override.
- Use the existing demand-driven render loop and `requestRender()`.
- Do not create a second `requestAnimationFrame` owner.
- WebGPU material texture slots must not be changed to `null` after observation;
  follow the environment-manager compatibility path documented in the audit.
- Scene reset, room switch and app disposal must clean GPU resources, Blob URLs,
  workers, timers, DOM listeners and Supabase subscriptions exactly once.
- Every remote load must carry abort/generation guards so stale results cannot
  enter a new room.

### FBX and ZIP

- FBX is worker-first with main-thread fallback.
- ZIP is streamed through the ZIP worker with acknowledgements and JSZip
  fallback.
- `SM` means high-poly/VPM; `NPM` means low-poly.
- Preserve orientation inheritance for `_Light.fbx`.
- Preserve SM GeoJSON offset, collision hiding, UDIM split and VPM texture
  autobinding.

### GLB

- `.glb` is accepted by file picker and drag-and-drop and can be stored as a
  room model.
- It uses `GLTFLoader` with Draco and Meshopt support.
- It preserves glTF hierarchy, transforms, PBR materials and animations.
- It participates in common world rebase, camera framing, shading, glass,
  shadows, room tracking and resource disposal.
- The position encoded in root/node transforms or vertex coordinates is
  meaningful. For an MGGT-prepared GLB, keep absolute source coordinates and
  apply only the visual `world` rebase.
- Current exclusions: multi-file `.gltf`, external assets and KTX2/Basis.

### MGGT and maps

- Source horizontal coordinates are MGGT metres.
- Normalized Y-up scene: `(east, height, -north)`.
- Z-up scene: `(east, north, height)`.
- World rebase is only a display transform and is never part of CRS conversion.
- `scripts/modules/geo/map-coordinates.js` converts MGGT to WGS84 using the
  documented Proj4 profile.
- 2GIS and OSM surroundings use a 500 m area around the source model location.
- 2GIS Places geometry is cartographic selection geometry, not surveyed road
  edges. Do not present it as exact engineering geometry.

## 5. Collaboration And Permissions

Backend endpoints at handoff:

- Supabase: `https://supabase.agr.vision`.
- Voice API and GIS proxy: `https://voice-api.agr.vision`.
- LiveKit WebSocket: `wss://rtc.agr.vision`.

Authorization rules:

- Registered users manage only their own projects and rooms.
- An invited guest has access only to the invited room and may add annotations,
  cameras and chat messages, but may not upload or delete models.
- Project ownership is authoritative through `projects.owner_id`; rooms inherit
  the project owner.
- Superuser access is database-backed through `user_roles`, never inferred from
  a browser-supplied email.
- The bootstrap superuser migration targets `maragojeep@gmail.com`; verify the
  current live database role before relying on it.
- Run only incremental production migrations. Never run `supabase/schema.sql`
  against the live database because it is a fresh-install schema.

See `docs/project-administration.md` for the complete matrix and remaining
storage deletion/audit-log work.

### Model validation (0.97.4)

`services/model-checker/` contains the JWT API and isolated Blender worker;
`20261003000100_model_check_jobs.sql` adds the PostgreSQL/RLS queue. The panel
is disabled until `config/runtime.js → modelCheckApiUrl` is configured.
The migration is deployed to the existing Supabase, and API/worker run on
`viewer-voice-01` using a separate rootless Docker user, 2 CPU/4 GiB per check,
and a bounded workspace. API: `https://voice-api.agr.vision/model-check`.
GitHub Pages 0.97.3 enables the panel; the agr.vision frontend remains 0.96.
Version 0.97.4 updates the open source list after imports and adds copying and
TXT export. Display translations never change the stored Checker result.
See `services/model-checker/deploy/README.md` for operation and validation boundaries.
Version 0.97.5 can open saved normalized JSON reports and display bounded UV evidence
from AGR Vision Model Check 0.1.10. Texture snapshots, contours and distance witnesses
belong to the source ZIP in that report; there is no source-polygon-to-rendered-mesh mapping yet.
This frontend release does not update the deployed checker image or production Caddy release.
See `docs/model-check-uv-evidence.md` for the protocol and validation boundaries.
Version 0.97.7 adds source-verified 3D UV-witness navigation: original FBX hash,
preserved Model IDs, exact edge endpoints and UDIM-aware lookup. The local
producer is AGR Vision Model Check 0.1.11; server/production promotion is separate.
The overlay owns its resources and does not alter imported materials or models.
The private Checker 1.6.1 image and knowledge base stay outside this repository.

Version 0.97.8 shares the packed G/B ERM texture between roughness and metalness,
serializes ERM conversion across imports and closes decode bitmaps before pixel processing.
The emissive R copy, resolution and source ZIPs are preserved. This reduces ERM
image allocation; it is not a guarantee that every large room fits Safari memory.
Validation: full `ci:verify`, pixel parity against the old ERM path on hardware
WebGPU/WebGL in Chrome, and corrected K1 import/disposal in both modes. Native
Safari on this Mac completed a local eight-ZIP HPM import (99 ERM materials,
WebGL fallback), visibility toggling and reset without reloading. The current
server room and mobile Safari have not been revalidated with this change.


Version 0.97.9 counts UDIM triangles before allocating exact output buffers;
one-tile meshes retain their original buffers. On the local eight-ZIP
Volokolamskoe fixture, two hardware-WebGPU runs measured 467–523 ms before
and 261–264 ms after for UDIM; 1,962 geometry-buffer SHA-256 values matched.
Whole-import timing stayed around 39 seconds on the repeated runs, so these
changes are not a claim of a large end-to-end speedup.

Texture-gallery previews are lazy, sequential, at most 256 pixels on their
longest edge, with bitmap/fetch/canvas cleanup on replacement and disposal.
The full source image remains available to the texture modal and binder.
Materials and texture galleries are available only to a registered signed-in
account for models linked to the active server room (including a local import
successfully synchronized to that room). Local-only imports and anonymous
room-link viewers get no gallery cards or thumbnail renderer. Access changes
cancel interactions and release previews. Mixed scenes expose only room models.
The objects/visibility tree and model rendering remain available.

Room settings playback is independent of editor access: guests still receive
saved material parameters. The existing persistence format stores parameters,
not replacement texture files or local .lpmat assets; those still require a
separate persistence feature. The access policy is UI entitlement, not a change
to server RLS or a way to conceal assets already sent for rendering.

Validation: `ci:verify` includes bounded thumbnail decode/cancellation, indexed
and non-indexed UDIM buffer parity, registered/guest/local/mixed-room UI access,
and guest playback of saved color/roughness without any thumbnail work. Hardware
Chrome imported all eight local ZIPs in WebGPU and WebGL, including offline
visibility toggles, Reset and reimport; native Safari completed the same
set in WebGL, with visibility toggle and Reset, zero gallery previews and no
reload/page errors. The latest live room and physical mobile devices are not
covered by those local fixture runs.

Version 0.97.10 fixes that FBX worker import failure with the exact r186
jsDelivr ESM entrypoint (module workers do not inherit document import maps).
The worker sends geometry and animation typed buffers as transferables, while
Three's object/material/skeleton schema is retained. Embedded images travel as
compressed Blobs; DOM decoding is sequential on the main thread and abortable.
The worker is reused across a batch and terminated after five idle seconds to
release FBXLoader's module-global parsed tree. Abort/disposal still terminates
it immediately when no other parse is pending.
`workers.fbx` diagnostics report completed jobs, hydration and last parse timings.
Source IDs, final Z-up rotation, skinning, morphs and animation metadata survive
transport; matrices must be updated before Object3D serialization because r186
sets its final axis correction after its earlier matrix update. Parse failures
still use the existing main-thread fallback.

CPU profiling identified GPU image uploads as the remaining long blocking task.
VPM materials now preload ready images with public `renderer.initTexture()` in
the existing serial ERM queue, yielding between textures before the material is
published. Room/model generation checks and disposal stop stale uploads. No new
render loop, resolution reduction or change to texture sampling was introduced.

On the same local eight-ZIP fixture in hardware Chrome, the final batch-reuse
build reduced the longest main-thread task from 11.66 s to 0.398 s in WebGPU
and from 16.55 s to 0.507 s in WebGL. Total import time was 38.8 s versus 38.6 s
(WebGPU), and 47.1 s versus 46.3 s (WebGL). Earlier preload runs showed similar
pauses (0.393/0.397 s and 0.492 s). This is a responsiveness improvement with a
small wall-time cost, not a faster total load. All 1,962 geometry buffer hashes and
orientation logs matched the prior release; all 15 FBX files used the worker.
These are local fixture measurements, not peak process-memory measurements or
physical-mobile results. Individual large GPU uploads can still block briefly.

Native Safari on this Mac completed the eight-ZIP set twice with the final
worker-reuse implementation, including Reset and reimport, with 15 records,
99 ERM materials and no page errors/reloads. Reset left zero pending jobs,
embedded images and tracked Blob URLs. An earlier experiment that terminated
the worker after every FBX did reload Safari during texturing; preload alone
passed, and batch reuse removed that failure in these two subsequent runs.
The exact WebKit failure mechanism and peak memory remain unmeasured, so this
does not establish stability for every server room or long session.

Regression coverage includes a real FBX worker with embedded PNG pixel parity,
Z-up world transforms, shared buffers/materials, skinning, morphs, animation,
abort/recreation/concurrent cancellation, batch reuse/idle release,
image-hydration cleanup, and texture
preload pixel parity, yielding, stale generations and GPU disposal. Existing
room-switch, offline/reload and large-import lifecycle coverage also passed in
`npm run ci:verify`. Hardware runs exercised offline visibility changes, Reset,
K1 reimport and disposal in both rendering modes; local galleries stayed empty.

Live-room follow-up (2026-10-05, published 0.97.10): native Safari completed
APEX / `volokolamskoe-sh-23-hpm` as the supplied registered account, then again
as an anonymous invite guest after Reset. Both runs loaded eight ZIPs / 15 FBX
through the worker without a page reload. The owner's gallery opened with 113
materials; the guest had neither material/texture galleries nor thumbnails.
A separate isolated Chrome guest run confirmed those restrictions and returned
HTTP 200 with no `room_material_settings` document. Actual saved edits therefore
remain covered by controlled regression tests, not by that live room's empty
settings; no material settings or source model files were changed for this QA.

After Reset, model/import/Blob/image/subscription counts were zero and both
workers were inactive. Sampled RSS is not proof of complete memory reclamation:
the test WebContent process peaked at about 11.2 GiB on the owner run and
12.8 GiB on the repeat, retained about 9.3 GiB after the second Reset, and about
6.9 GiB after a diagnostic forced GC. Closing the test tab terminated that
process. Safari's shared GPU process peaked around 9.9 GiB and fell below
0.5 GiB after Reset. These process values include allocator/cache effects and
shared pages; do not sum them as unique RAM or call the long-session case fixed.

Safari also issued a nonfatal 404 for `/npm/three@0.186.0/+esm` on the viewer's
origin, with resource initiator `link`. The CDN's FBX ESM response contains that
root-relative `Link: ...; rel="modulepreload"` header. Actual worker imports from
the CDN completed (15/15); the stray preload was not a worker fallback or reload.

Version 0.97.11 stores a spatially constant decoded ERM R channel in a 1x1
emissive canvas, preserving its exact value, linear color space and flipY.
A single differing value keeps the original dimensions. Packed G/B maps,
Diffuse/Normal images and original ZIP images retain their dimensions/content.
The 94 source ERM files in the local fixture all have constant R (0 or 255).
Tests include nonzero constants, a one-pixel variation, existing translucent
input/queue/disposal cases, and exact rendered pixel parity on hardware WebGPU
and WebGL against full-size emissive maps at values 0, 93 and 255.

The same eight-ZIP hardware fixture produced 99 compact emissive maps (some
source images are used more than once). Derived canvas storage calculated as
width × height × 4 fell from 1707 MiB to 853.5004 MiB. WebGPU's texture allocation
counter fell from 11,177,230,359 to 9,984,249,678 bytes, including mip levels;
this is not a measured reduction in Safari process RSS. All 1962 geometry-buffer
hashes matched 0.97.10 in both renderers. One-run import times were 38.489 s
WebGPU and 46.627 s WebGL versus 38.833 s and 47.109 s respectively; the small
time difference is not enough to claim a speedup. Offline visibility toggling,
Reset, K1 reimport and disposal completed without browser errors or warnings;
local material/texture galleries still created no thumbnails.

Version 0.97.12 releases the full-resolution ERM conversion canvas after
lossless PNG encoding and retains a loaded image for the shared roughness /
metalness texture. Encoding uses OffscreenCanvas where available, with an
HTML canvas fallback. The temporary Blob URL is revoked after image load;
all temporary canvases are cleared on success and failure. Decoded RGB,
opaque alpha, flipY, color spaces and map resolution are unchanged. The loaded
image remains usable for export and subsequent GPU uploads. Constant emissive
compaction, serialized conversion and generation/ownership checks are retained.

Hardware Chrome comparison against 0.97.11 used the same five local ZIPs
(Ground, K1, K5, K6, K7; nine FBX records, 2,138,171 triangles), fresh isolated
browser profiles, DPR 2 and a 3456x1772 framebuffer. Settled macOS physical
footprint of the scene renderer process fell from 1676 to 1201 MiB in WebGPU
and from 1490 to 1079 MiB in WebGL. Full-resolution CPU canvas storage fell
from 464.75 MiB to zero. WebGPU's logical texture allocation stayed at
7,760,387,185 bytes; GPU-process footprint was 9125 versus 8896 MiB (WebGPU)
and 9098 versus 9102 MiB (WebGL). These single-run process measurements include
cache/shared-page effects, are not total unique machine RAM, and do not predict
the exact number shown for an existing user's tab.

Import time was 33.044 versus 34.375 s in WebGPU and 37.809 versus 40.518 s in
WebGL; PNG encoding trades some import time for lower retained memory. Full
scene pixels matched exactly in both modes, excluding only the version footer.
A separate varying-channel material fixture also produced identical rendered
pixels in both hardware renderers. Offline visibility changes, Reset, K1
reimport and disposal passed without page errors or warnings. `npm run ci:verify`
passed, including room-switch/lifecycle coverage and injected pixel-read / PNG
load failures that verify cleanup, material preservation and queue recovery.
Raw benchmark JSON, scripts and screenshots are saved locally under
`/private/tmp/lpm-erm-storage-20261005/`. Native Safari and physical mobile devices
have not been revalidated for this patch. Publication is to GitHub Pages only.

Version 0.97.13 queues VPM Diffuse/Normal decoding with ERM preparation and
shares decoded images / `TextureSource` for byte-identical encoded files
(SHA-256, byte length and MIME type). Texture objects, names, UV transforms,
sampling settings and material editing remain independent. The pool is owned
by live textures; disposal evicts the last owner, aborted/stale work cannot
publish an image, and temporary decode Blob URLs are revoked. No global
Three.Cache is enabled. Non-ERM binding, FBX normalization, GLB and the original
ZIPs are unchanged. There is no resolution reduction or pixel re-encoding.

An inventory of all eight local Volokolamskoe ZIPs found 282 source images,
including 159 repeated pixel-identical images. This broader pixel count includes
files with different PNG encodings, which the conservative runtime byte match
intentionally does not merge. The loaded scene has 15 FBX records / 2,521,370
triangles. Its distinct material images fell from 396 to 334; theoretical unique
RGBA storage fell by 1481 MiB (not a process-memory measurement).

Hardware Chrome, fresh profiles, 3456x1772 framebuffer / DPR 2:

| Measurement | Before | After |
| --- | ---: | ---: |
| WebGPU scene process, loaded physical footprint (two runs) | 1654-1662 MiB | 1319-1326 MiB |
| WebGL scene process, loaded physical footprint (one run) | 1476 MiB | 1152 MiB |
| WebGL GPU process, loaded physical footprint (one run) | 11581 MiB | 9604 MiB |
| WebGL allocated textures | 403 | 341 |
| WebGPU logical texture bytes | 10147397970 | 10147397970 |

WebGPU import times were 46.2/48.9 s before and 46.7/48.5 s after; WebGL was
53.7 versus 55.6 s. This is a memory improvement, not an end-to-end speedup.
Sampled scene-process peaks fell from 3208 to 2939 MiB (WebGPU first pair),
and from 3117 to 2691 MiB (WebGL). Physical footprints include allocator/cache
and shared-page effects; do not sum them into unique RAM or equate them with
the browser's tab-memory indicator. WebGPU still allocates per Texture on GPU.

Full-scene pixels matched exactly in both hardware modes; a close facade view
with glass and visible brick detail also matched exactly in WebGPU. Regression
fixtures cover different sampler/color-space/UV settings, one-pixel differences,
independent names, failed decoding, cancellation, stale generations, no-crypto
fallback, Blob URL cleanup, disposal of one shared-image owner and reupload.
Full `ci:verify` includes the existing room switching, offline/reload and large
import lifecycle checks. Hardware runs also exercised offline visibility,
Reset, K1 reimport and app disposal with no final page errors/warnings.

Native Safari on this Mac completed the same eight ZIPs in its WebGL fallback,
with 397 to 335 images including the environment, visibility toggles and Reset.
Reset left zero models/Blob URLs/pending jobs and inactive workers. Its observed
WebContent footprint was approximately 10.7 versus 8.5 GiB, but that is a single
descriptive comparison: part of the baseline overlapped a separate Chrome QA
run and Safari reused a WebContent process. It is not a controlled repeatability
or physical-mobile result. The live server room was not retested for this patch.
Raw inventories, measurement scripts, JSON and screenshots are local at
`/private/tmp/lpm-texture-audit-20261006/`. Publication remains GitHub Pages only.

Version 0.97.14 fixes selection changes during automatic room reconnection.
Reconnect intentionally retains the scene while replacing its controller. The
room/project selection handlers previously skipped teardown when that controller
was temporarily null, leaving the previous room's models in the next scene.
Selection teardown now also recognizes pending initialization and reconnect
state, cancels stale work and releases the retained scene. Normal reconnection
to the same room still preserves its models.

A deterministic regression holds the replacement subscription, then selects
another room, another project, or no room. The room case failed on 0.97.13 with
the old model still loaded. All three cases pass in hardware Chrome WebGPU and
WebGL after the fix, including exactly-once geometry/material/texture disposal
and a late subscription response. The WebGL cases are included in `ci:verify`.

The 2026-10-06 direct server QA of 0.97.13 was limited by slow ZIP transfer in
both native Safari and isolated Chrome. Chrome received about 3 MB of the first
390.4 MB ZIP in 150 seconds. A separate bounded Range request received 674249
bytes in 20 seconds (about 34 KB/s); another attempt hit an SSL timeout. This
does not identify whether the cause is the client network, route or server.
Login, progress and cancellation were checked; this run cannot validate memory
of the fully loaded server scene or Safari's end-of-import stability. Test
artifacts are local at `/private/tmp/lpm-live-09713-20261006/`.

An additional hardware Chrome WebGPU run used live room/auth/settings APIs but
streamed local ZIP fixtures instead of the slow storage responses. After the
fix, the owner flow (HPM, brief offline period, LPM, HPM, clear room) produced
15 -> 3 -> 15 -> 0 model records; Blob URLs were 297 -> 34 -> 297 -> 0.
Both HPM loads had 335 material images including the environment and 397
Texture objects. The owner gallery displayed 113 materials. Clearing the room
and disposing left zero imported resources and realtime subscriptions.
These are fixture-backed integration results, not completed server downloads
or proof that local/server ZIP bytes match. Process physical footprint was
1637 MiB on the first HPM and 1877 MiB on the second (gallery used between),
1744 MiB after clearing and 606 MiB after disposal. No forced GC was used;
this is not a claim of baseline memory recovery or leak freedom.

The guest material replay test also exposed a separate color issue: restoring
room parameters on a textured FBX worked initially, but a later ZIP batch
re-applied the neutral import multiplier (127/255) to the edited material.
Version 0.97.14 marks explicit editor/room material state so repeated import
normalization preserves it, including material conversions. Untouched imported
materials retain the existing base-color policy. The access regression now
uses a textured material and checks owner edits, guest replay, later
normalization, conversion and absence of guest previews.
It passes in both hardware WebGL and WebGPU. Full HPM guest WebGL integration
also passed reload, preserved Diffuse/Normal maps, restored the selected
material's color/roughness/metalness and kept zero material cards/texture
thumbnails. The real room returned no saved material document; this parameter
test injected a synthetic response only in the isolated browser and made no
server material writes. Final app disposal left zero models/Blob URLs/channels.

Version 0.97.15 detaches the CPU image source of a permanently removed imported
texture after its dispose listeners have run. It assigns a new empty
`THREE.TextureSource` and releases its mipmap array. It must not set `image=null`
on the existing source: different Texture objects can share that source, and a
surviving model still needs its pixels. Existing live-resource and environment
ownership guards remain in force; ordinary material changes are unaffected.

The investigation used hardware Chrome with real room import/clear code,
mocked room metadata and the eight original local HPM ZIP streams. In two
WebGL load/clear cycles, diagnostic GC collected all tracked imported objects,
materials, geometries and images. In WebGPU it collected the scene objects and
geometry, but six HTML images and two canvases survived. A heap snapshot traced
material retention to Three.js r186's module-level MaterialNode property cache
and MaterialReferenceNode.reference. This is separate from delayed browser
memory reclamation; resetting the renderer alone did not remove those links.

After the source-detachment patch, both full WebGPU cycles collected all tracked
imported images and original sources except the shared environment. Small
material/Texture shells remain reachable through renderer nodes; the patch does
not change Three.js internals or promise immediate process-memory recovery.
Full-scene screenshots before/after had identical pixels in the scene crop.
No diagnostic forced GC is added to the application. The measured prototype
initially used the deprecated `Source` alias; final code uses `TextureSource`,
its r186 replacement, and the final sharing/disposal regression passes in
hardware WebGPU and WebGL. The regression checks partial model removal,
surviving shared sources and Texture objects, listener ordering and exactly-once
disposal, and is included in `ci:verify`.

A repeated native Safari server check on 0.97.14 authenticated successfully but
received only 1.6 MB of the first 390.4 MB ZIP in 83 seconds. Cancelling left zero
models, Blob URLs, pending imports and channels. Full live-server import and
physical-mobile behavior remain unverified for this patch. Local evidence,
scripts, heap snapshots and measurements are under
`/private/tmp/lpm-retention-09714-20261006/`. Production is not promoted.

## 6. Yandex Cloud Topology

### Frontend, voice and LiveKit

- VM: `viewer-voice-01`.
- Hosts Caddy routing, production viewer release, voice API and LiveKit-related
  virtual hosts.
- Preserve all non-viewer Caddy blocks during frontend promotion.
- Caddy configuration host path:
  `/opt/lpmview/deploy/caddy/Caddyfile`.

### Self-hosted Supabase

- VM: `viewer-backend-01`.
- OS: Ubuntu 24.04.
- Size at provisioning: 4 vCPU, 8 GiB RAM, 96 GiB SSD.
- Stack root: `/opt/lpmview/supabase`.
- Supabase Docker release: `self-hosted/v0.8.0`, PostgreSQL 17.
- Database ports `5432` and `6543` are loopback-only.
- Private model object bucket: `agr-viewer-supabase-prod`.
- Storage service account: `viewer-backend-storage`.
- Large Storage downloads require the deployed Envoy no-total-timeout patch;
  see `docs/supabase-yandex-migration-runbook.md`.

### Static Object Storage

- Bucket used by the GitHub deployment workflow: `agr.vision`.
- Endpoint: `https://storage.yandexcloud.net`.
- Region: `ru-central1`.
- This bucket mirror is separate from the Caddy-selected production release.

## 7. Secret Register Without Values

The following list is intentionally a map of secret names and storage
locations. Do not add their values to this document.

### GitHub repository Actions secrets

- `YC_S3_ACCESS_KEY_ID`
- `YC_S3_SECRET_ACCESS_KEY`

They authorize `.github/workflows/deploy-yc-storage.yml`. A repository admin can
replace them but GitHub does not reveal the existing values.

### Self-hosted Supabase server

Root-only file: `/opt/lpmview/supabase/.env`.

Important categories include:

- PostgreSQL passwords and connection strings.
- JWT secret, anon key and service-role key.
- Dashboard/Studio credentials.
- SMTP credentials, if configured.
- `YC_STORAGE_ACCESS_KEY_ID` and `YC_STORAGE_SECRET_ACCESS_KEY`.
- `GLOBAL_S3_BUCKET`, `GLOBAL_S3_ENDPOINT` and `YC_STORAGE_REGION`.

The committed template is `infra/supabase-yandex/storage.env.example`.

### Voice API and LiveKit

Runtime environment requires:

- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `LIVEKIT_WS_URL`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `VOICE_API_ALLOWED_ORIGINS`
- optional `VOICE_TOKEN_TTL`

Inspect the deployed Docker Compose/environment files on `viewer-voice-01` to
locate their current root-only values. Their exact host file location is not
recorded in this repository; document it after the first access audit.

### Local Supabase administration

Optional gitignored file: `.env.supabase.local`.

- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_PROJECT_REF`
- `SUPABASE_DB_PASSWORD`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

Use `.env.supabase.local.example` as the template. Never commit the populated
file.

### 2GIS

- The shared 2GIS key is stored server-side by the Supabase migration
  `20260903000100_secure_2gis_api_key.sql`.
- It is changed through the superuser administration UI/RPC.
- Browsers can use the GIS proxy but cannot read the key value.

### Public browser configuration

`config/runtime.js` contains public endpoints and the Supabase anon key. The
anon key is intentionally browser-visible and is not a replacement for RLS.
Never put the service-role key in browser configuration.

## 8. Granting The Developer Access

Do not share the owner's passwords or existing static keys.

1. Add the developer's personal GitHub account as a repository collaborator.
   Use Admin only if they must manage Actions secrets and repository settings;
   otherwise Maintain is sufficient for code and deployments.
2. Invite the developer's personal Yandex account to the organization/cloud and
   grant roles on the LPMVIEW folder. Use narrowly scoped Compute, Storage and
   service-account roles; do not share the owner's Yandex login.
3. Create a separate Linux user on each VM, install the developer's SSH public
   key and grant audited `sudo` access. Do not copy an existing private key.
4. Keep machine credentials in GitHub Secrets and root-only `.env` files. Give
   the developer permission to rotate them, not copies in chat.
5. Transfer any unavoidable recovery codes through a password manager with an
   expiring share, then rotate them after handoff.
6. Record the new account names, IAM roles, SSH fingerprints and rotation date
   in an access register outside the public repository.

## 9. Development And Release Procedure

Fresh setup:

```bash
git clone git@github.com:NieMandX/3dviewer.git
cd 3dviewer
git checkout gh-pages
npm ci
npm run ci:verify
```

For each completed change:

1. Inspect existing dirty files and preserve unrelated work.
2. Implement the smallest coherent change.
3. Run `npm run ci:verify`.
4. Test the affected browser flow locally in WebGPU and WebGL when relevant.
5. Commit and push.
6. Confirm GitHub Pages publication and CI checks are green. Leave Yandex
   Storage sync skipped unless the owner separately approved it.
7. Test on GitHub Pages with a cache-busting query parameter.
8. Promote to `agr.vision` only after explicit owner approval and the complete
   release checklist in `docs/viewer-releases.md`.

## 10. Known Risks And Remaining Work

- Do not mix Three.js versions between import map, addons, workers or Draco.
- Room/realtime/import changes require explicit stale-generation and cleanup
  tests under rapid switching and network loss.
- Large model downloads depend on the Envoy Storage timeout patch.
- Physical Storage object deletion after project/room removal is still
  best-effort in parts of the administration flow.
- Offsite Supabase backups and a tested clean restore remain required.
- Invitation rotation, member revocation, delete audit log and ownership
  transfer need explicit product and permission design.
- GLB support does not yet include external `.gltf` packages or KTX2.
- Production `agr.vision` can lag behind GitHub Pages by design.

Start incident investigation with browser console diagnostics, the relevant
controller's generation/dispose path, VM container health and the runbooks
linked from `AGENTS.md`. Do not treat a successful clean-profile boot as proof
that cache upgrades, reconnects or long-session disposal are correct.
