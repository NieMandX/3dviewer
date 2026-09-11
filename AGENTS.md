# LPMVIEW Development Instructions

This repository contains the active LPMVIEW viewer. Read
`docs/developer-handoff.md` before changing application, backend, deployment or
cloud infrastructure code.

## Working language and scope

- Communicate with the project owner in Russian.
- The active application is `index.html` -> `scripts/viewer-app.js` ->
  `scripts/modules/app/viewer-app-main.js`.
- Root-level historical prototypes are not production entrypoints.
- Keep changes scoped. Do not rewrite unrelated modules or remove existing
  behavior without an explicit product decision.

## Required verification

- Run `npm ci` after a fresh checkout.
- Run `npm run ci:verify` before every push.
- Test renderer-sensitive changes in both default WebGPU and
  `?renderer=webgl` modes.
- For lifecycle changes, test room switching, rapid model switching, reload,
  offline/online recovery and disposal after large FBX/ZIP/GLB imports.
- Commit and push completed, verified changes to `gh-pages` unless the owner
  explicitly requests another branch or asks to pause.

## Runtime invariants

- Three.js core, WebGPU, addons, workers and Draco decoder must stay on the
  same exact release. The current pinned release is `0.184.0`.
- Rendering is demand-driven through `requestRender()`. Do not introduce a
  second animation loop or unconditional continuous rendering.
- `world` owns imported scene content. Camera and renderer are application
  singletons owned by the main viewer lifecycle.
- Every imported geometry, material, texture, ImageBitmap, skeleton, Blob URL,
  worker request and realtime subscription needs a deterministic teardown.
- Async imports and realtime work must reject stale generations after room
  changes, aborts and application disposal.
- `loadedModels` is the source of truth for imported models and inspector state.
- Preserve `_origMaterial` and the existing material/shading contracts.
- MGGT source coordinates remain unchanged. Rebase only the `world` container
  for display precision. The normalized Y-up contract is
  `(east, height, -north)`.

## Model import contracts

- FBX and ZIP retain their existing orientation, embedded-image, SM/NPM,
  GeoJSON, collision, UDIM and texture-autobind pipeline.
- GLB uses `GLTFLoader`, supports single-file `.glb`, Draco and Meshopt, and
  preserves glTF PBR materials, node transforms and animations.
- Do not run FBX-specific normalization or filename texture extraction on GLB.
- External `.gltf + .bin + textures` and KTX2 are not currently supported.

## Deployment and secrets

- GitHub Pages is the latest test build from `gh-pages`.
- A push also syncs static files to Yandex Object Storage.
- `https://agr.vision/` is a separately promoted immutable Caddy release. Never
  promote or roll it back without explicit owner approval.
- Never commit service-role keys, Yandex static keys, LiveKit secrets, database
  passwords, SSH private keys or `.env` files.
- Do not paste secrets into Codex prompts or logs. Use personal IAM access,
  GitHub Secrets, root-only server environment files or a password manager.

## Project documentation

- `docs/developer-handoff.md` - ownership, infrastructure and access handoff.
- `docs/viewer-memory/LPMVIEW_architecture_memory.md` - architecture and runtime
  contracts.
- `docs/viewer-r184-production-audit.md` - production audit and lifecycle risks.
- `docs/viewer-releases.md` - immutable releases, promotion and rollback.
- `docs/github-yandex-deploy.md` - GitHub Pages and Yandex Storage deployment.
- `docs/supabase-yandex-migration-runbook.md` - self-hosted Supabase topology.
- `docs/project-administration.md` - owner, guest and superuser permissions.
- `docs/map-coordinates.md` - MGGT projection and map overlay contract.
- `docs/2gis-integration.md` - server-side 2GIS integration and key handling.
