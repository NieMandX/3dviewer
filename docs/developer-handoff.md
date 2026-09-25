# LPMVIEW Developer And Codex Handoff

Last verified: 2026-09-11.

This document transfers engineering context, not credentials. Secret values
must be transferred through personal account access or a password manager,
never through Git, chat or an AI prompt.

## 1. Source Of Truth

- Repository: `git@github.com:NieMandX/3dviewer.git`.
- Active integration/deployment branch: `gh-pages`.
- Local checkout used by the project owner: `/Users/mac/development/IMA/LPMVIEW/app`.
- Current viewer version: `0.96`; tag `v0.96` identifies its initial release (2026-09-25).
- Current Three.js version: exact CDN pin `0.184.0` for core, WebGPU, TSL,
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
- The same workflow mirrors the selected frontend assets to
  `s3://agr.vision/` in Yandex Object Storage.

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
6. Confirm the GitHub Pages and Yandex Object Storage workflows are green.
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
