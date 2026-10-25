# Cloud.ru Voice Staging

This is a private preparation environment, not a production deployment.
All published container ports bind to `127.0.0.1`. Do not change DNS, cloud
ingress, the production Caddy release, or viewer runtime configuration here.

## Installation On A New Ubuntu 24.04 AMD64 VM

Transfer this directory and `services/voice-api` / `services/model-checker`
under `/opt/lpmview/staging`, preserving repository-relative paths. Use an
administrator-only parent directory. The build context allowlists just the
voice API source files; it excludes local environment files and credentials.

1. Inspect and run `bootstrap-host.sh` as root. It uses Docker's official APT
   repository and does not replace an existing Docker installation. Capture
   installer output in a root-only log; it must not contain application keys.
2. Pull `livekit/livekit-server:v1.13.11`, `caddy:2-alpine`, and `node:22-alpine`.
   Run `python3 init-staging.py --revision <source-sha>-staging`. This records
   their immutable digests in the ignored `.env` and generates separate
   staging LiveKit keys under root-only `/etc/lpmview-voice/`. Existing keys
   are retained. The generator resets service configuration to staging values;
   never run it against a promoted deployment.
3. Run `docker compose build` and `docker compose up -d --wait` from this
   directory. Caddy's derived image removes its unneeded privileged-port file
   capability, allowing all runtime capabilities to remain dropped.
4. Run `python3 verify-staging.py`, then the protocol probe:

   ```sh
   docker compose exec -T voice-api node --input-type=module < probe.mjs
   ```

5. Repeat both checks after restarting the three staging containers.
   Health checks alone do not establish correct voice signaling or media.

The protocol probe creates and deletes its own temporary room. It verifies
the Room API, signed tokens, and a signaling response through Caddy. It does
not publish audio or establish a two-device WebRTC media call.

## Deliberately Disabled Features

- The existing `/v1/token` application handler trusts a supplied room/identity
  without checking database membership. Caddy blocks this route with 503.
  Direct API access is loopback-only and used solely by the internal probe.
  Add JWT/session verification and room-membership checks before publication;
  CORS alone does not authorize access to a voice room.
- GIS has no database service key. Its public/admin operations fail closed.
- LiveKit TURN and public media ports are not enabled. The bridge-network
  configuration is for private signaling validation only. Production needs
  separately reviewed host networking, advertised IP, TLS and media ingress.
- No API, queue worker, or health timer for Checker is enabled. Do not connect
  a second worker to the original source database during migration.

## Isolated Checker Preparation

Run `prepare-checker.sh` on the new VM. It reserves UID 1001 only if available,
uses a separate `lpm-checker` group, disables interactive login, and installs
rootless Docker. It does not grant access to the system Docker socket. The
dedicated user slice is capped at 2.5 CPU, 5 GiB, no swap and 512 tasks.

Import the owner's private image only into that rootless daemon. Never push
it to a public registry. Verify all RootFS layers and the entrypoint against
the original export. Its image ID may differ between containerd/Desktop and
Linux stores; use the actual immutable Linux ID in the target engine registry.
The runner requires rootless Docker, systemd cgroup v2 and an immutable ID.

`prepare-checker-runtime.sh` installs Node 22.23.4 after verifying its upstream
SHA-256, creates a 16 GiB workspace inside the existing VM disk, and mounts it
with `nosuid,nodev,noexec`. It installs the existing systemd service files but
does not enable the API, worker or timer. Database credentials remain absent.
Review the API listener/proxy address before activation; the old Yandex bridge
address is not automatically transferable to a new Docker network.

## Storage And Backups

`probe-s3-download.py` reads a short-lived, read-only object URL from stdin.
It streams bytes without retaining a second model file and checks length and
SHA-256. Never pass the URL as a command-line argument or print it on failure.
This probe does not validate Supabase Storage metadata, browser delivery or
future uploads.

Save `/etc/lpmview-voice/` and this directory's private `.env` in a root-only
server backup and an owner-only local copy outside Git. Keep the database
archive, original model copies and immutable viewer candidate separate. A
stored database archive is not a successful database restore.

## Verified 2026-10-26

- Docker 29.9.2 / Compose 5.6.1 installed on the new voice VM.
- LiveKit 1.13.11, API and Caddy are healthy, read-only and loopback-only;
  the room/token/signaling probe passed before and after container restart.
- Rootless Checker imported with all nine layers matching the local image.
  A 5,509,617-byte source ZIP completed in 3.35 seconds under the existing
  2 CPU / 4 GiB / network-none runner, without OOM or input modification.
  This confirms execution, not regulatory compliance of that model.
- A 220,777,893-byte Storage object downloaded directly to the VM in 11.328
  seconds (155.91 Mbit/s); its SHA-256 matched the local source. The earlier
  laptop download failure and Supabase Storage integration remain unresolved.
- A database export copy and viewer 0.97.17 candidate are staged privately;
  neither database restoration nor production promotion has occurred.

Still required: backend SSH recovery, database restore/incremental migrations,
destination Storage API transfer and verification, GIS credentials, Checker
engine registration/queue test, authenticated voice membership, TLS/public
media connectivity, two-device calls, full viewer staging tests, offsite
backup/restore validation, and separately approved DNS cutover.

References: [LiveKit deployment](https://docs.livekit.io/transport/self-hosting/deployment/),
[Docker installation](https://docs.docker.com/engine/install/ubuntu/),
[rootless Docker](https://docs.docker.com/engine/security/rootless/).
