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
the Room API, signed tokens, and a direct internal LiveKit signaling response. It does
not test application authorization, publish audio or establish a two-device
WebRTC media call.

## Application Voice Authorization

`POST /v1/token` now requires a Supabase user bearer token. The API verifies
the user through Auth and reads the requested `room:<uuid>` using that same
user's JWT and existing room RLS. Project owners, superusers and room-scoped
invite members are admitted; missing/expired sessions and inaccessible rooms
fail closed. Identity and project/room metadata come from verified backend
records, not client fields. The viewer obtains a fresh session before each
join and cancels stale requests after disconnect/dispose.

The default join-token TTL is ten minutes; staging also sets ten minutes.
This restricts initial token use, not the duration of an established call.
Token issuance alone does not disconnect existing participants or invalidate
previously issued self-hosted LiveKit tokens. The private access guard below
checks current rights instead. See
[LiveKit token lifecycle](https://docs.livekit.io/frontends/reference/tokens-grants/).

Keep the existing Caddy `/v1/token` block. Under the migration lock, run the
authorization probe only against the private migrated demo backend:

```sh
docker compose exec -T -e LPM_STAGING_PROBE=1 voice-api node --input-type=module < probe-authorization.mjs
```

The probe refuses any backend other than the private Cloud.ru endpoint. It
creates temporary registered/anonymous users, a project and two rooms; tests
real password login, invite isolation, superuser access, revocation and
identity spoofing; verifies signed claims and signaling; then removes its
own fixture IDs. Save its output in a protected log for cleanup auditing.
It never changes existing users or projects and does not prove media works.

For API-only upgrades, build a new image and set `VOICE_API_IMAGE` in the
protected staging `.env` to its immutable image ID. Preserve `SOURCE_REVISION`
for Caddy, existing LiveKit keys, private CA and Compose TLS override. Back up
the old source/config first and use `up --no-deps --wait voice-api`; keep the
old image for rollback. Do not rerun `init-staging.py` on this configured stack.

### Active Access And Reconnect Guard

Apply `supabase/migrations/20261026000100_voice_room_access.sql` to the target
only, after a protected database backup. Its service-role-only RPC reuses the
existing room access helpers under the participant's identity, restores request
claims, and rejects deleted/banned accounts. It does not grant clients any new
permissions. The SQL permission suite tests ownership, invites, superusers,
revocation, account restrictions and RPC privilege isolation.

Set `VOICE_ACCESS_GUARD=1` and `LIVEKIT_HTTP_URL=http://livekit:7880` in the
protected staging API environment and recreate only that API container. The
default flag is off for compatibility with deployments that have not applied
the migration; the new staging Caddy gate fails closed without the guard.

- Caddy reauthorizes every supported `/rtc` entrypoint, including validation
  and reconnect requests. It overwrites forwarded URI/method headers and
  blocks external `/internal/*` and `/twirp/*` access. Runtime logging filters
  remove access tokens and forwarded authorization/URI values.
- The API verifies the LiveKit signature, expiry, identity, room and grants,
  then checks current database rights. Both original and LiveKit-refreshed
  tokens are denied after revocation. Direct public access to LiveKit must
  never bypass this gate; keep its control and signaling port private.
- The guard enumerates current LiveKit participants after each restart and
  removes those without room rights. Sweeps are single-flight, with at most
  four participant checks in parallel and a ten-second delay between sweeps.
  This is bounded polling, not instant revocation or a cryptographic token
  denylist. Restoring room rights allows otherwise valid tokens again.
- Database verification failures deny admission and attempt to evict affected
  participants. LiveKit control failures mark the guard unhealthy; removals
  cannot be guaranteed while the control service itself is unreachable.
  This checks room/account eligibility, not per-session Auth logout state.

Run the real control/signaling acceptance from the host as root:

```sh
LPM_STAGING_PROBE=1 python3 probe-voice-revocation.py
```

The runner acquires the migration lock, requires the private backend and no
existing LiveKit rooms, and starts a separate read-only test container. It
temporarily enables structured LiveKit info logs, restarts the private API,
and restores the exact prior LiveKit configuration in `finally`. Protected
results and a configuration backup are saved in `/var/backups/lpmview-migration`.
It tests guest revocation after API restart, denial of original/refreshed
tokens, superuser-role removal, room deletion and restored invite access.
Temporary users/project/room are removed by the probe; verify its cleanup
report and baseline counts before continuing. On an abnormal timeout, inspect
the retained test container and recorded fixture IDs before another run.

The raw signaling fixture may close without receiving a Leave frame. A pass
requires socket closure, participant absence **and** LiveKit's matching
`SERVICE_REQUEST_REMOVE_PARTICIPANT` log, never a generic timeout or an API
counter alone. This is not browser reconnection, ICE/media or two-device audio
acceptance; those remain publication gates.

## Deliberately Disabled Features

- Caddy still blocks `/v1/token` with 503 pending full private acceptance and
  separately approved publication. Direct API access is loopback-only.
- GIS uses the migrated backend through the pinned private CA. Provider-key
  validity and actual 2GIS requests still require separate verification.
- LiveKit TURN and public media ports are not enabled. The bridge-network
  configuration is for private signaling validation only. Production needs
  separately reviewed host networking, advertised IP, TLS and media ingress.
- The Checker API and single worker are enabled only against the migrated
  private database after queue acceptance below. The old health timer and
  public proxy route remain disabled. Never connect this worker to the source.

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

### Private Queue Acceptance

After restoring the target database and installing the pinned internal CA,
`configure-checker-staging.py` creates root-only API and worker environments.
It is a first-time operation: it refuses existing credential files, verifies
the runner SHA-256, requires the target private HTTPS URL, and reads only the
target anon key as JSON on stdin (`anonKey`). Transfer that value through a
protected pipe, never a shell argument or log. The worker key is read from the
existing protected voice environment on the same VM; it never enters the API.
The script does not start services or change the proxy or network.

Run `probe-checker.mjs` as root with `LPM_STAGING_PROBE=1` and
`NODE_EXTRA_CA_CERTS=/etc/lpmview-ca/backend-root.crt`, under
`/run/lock/lpm-cloudru-migration.lock`. Start the loopback API first but keep the
worker inactive. This first acceptance requires an empty engine registry and
queue, refuses an existing report, and registers the immutable Cloud.ru engine.
Do not rerun it over existing acceptance state or erase evidence to bypass its
guards. It creates temporary users/project/model references, uploads a copy of
the original 5.5 MB fixture through Storage, and controls the single worker.
It tests real JWT/RLS access, concurrent deduplication, queued cancellation,
source/engine provenance, guest report access, and execution after worker restart.
It deletes only its own fixture IDs and object; failures disable the new engine.
The result is saved under `/var/backups/lpmview-migration/`. Check cleanup and
baseline data counts separately before enabling the accepted services on boot.

The private API listens only on `127.0.0.1:8081`. The staging proxy still returns
503 for `/model-check`; no browser runtime URL or ingress changes are implied.
Keep the existing health timer disabled until its old Yandex bridge target has
been adapted. Save the new mode-600 credentials and unit overrides in protected
server/local backups outside Git.

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
- The authenticated voice API subsequently passed real password and anonymous
  Auth, owner/guest/superuser access, other-room denial, identity-spoofing and
  new-token revocation checks before and after API restart. Temporary fixtures
  were cleaned up. The subsequent access-guard probe confirmed server-driven
  participant removal after guest/role revocation and room deletion, including
  API restart and original/refreshed-token denial. LiveKit's removal reason
  and participant absence were checked. The proxy token route remains blocked;
  no browser or media call has been validated.
- Rootless Checker imported with all nine layers matching the local image.
  A 5,509,617-byte source ZIP completed in 3.35 seconds under the existing
  2 CPU / 4 GiB / network-none runner, without OOM or input modification.
  This confirms execution, not regulatory compliance of that model.
- The target queue subsequently passed the real Storage/ZIP/API/worker/report
  flow, including a second execution after worker restart. Owner/guest/outsider
  rights, room-scoped reads, concurrent deduplication, queued cancellation and
  report SHA-256/engine identity were checked. The source ZIP was unchanged;
  test fixtures, jobs, leases and containers were removed. API and worker are
  enabled only in private staging; the existing health timer remains disabled.
  Large ZIPs, cancellation during an active Blender job and browser acceptance
  are not covered by this small-fixture test.
- A 220,777,893-byte Storage object downloaded directly to the VM in 11.328
  seconds (155.91 Mbit/s); its SHA-256 matched the local source. The earlier
  laptop download failure and Supabase Storage integration remain unresolved.
- The demo database and all 30 Storage objects were subsequently restored on
  the backend and verified. See the migration runbook and private checkpoint.
  The viewer candidate remains private; production promotion has not occurred.

The owner stopped support polling on 2026-10-26 and prohibited further messages
to support. Continue using the verified private SSH path through the voice VM;
do not recreate the polling automation or contact support without new approval.

Still required: GIS acceptance, broader Checker failure/large-file tests and
health monitoring, active voice-session revocation, TLS/public media
connectivity, two-device calls, full viewer staging tests, offsite backup/restore
validation, and separately approved DNS cutover.

References: [LiveKit deployment](https://docs.livekit.io/transport/self-hosting/deployment/),
[Docker installation](https://docs.docker.com/engine/install/ubuntu/),
[rootless Docker](https://docs.docker.com/engine/security/rootless/).
