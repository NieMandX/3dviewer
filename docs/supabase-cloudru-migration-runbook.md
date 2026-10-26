# Cloud.ru Migration Staging

Started: 2026-10-25. This is a parallel migration, not a production release.
The owner approved a monthly ceiling of RUB 17,000, including capacity for
1 TB of model objects. Recheck traffic and retained backup charges before cutover.

On 2026-10-26 the owner clarified that the Yandex-hosted `agr.vision` is already
unavailable. Cloud.ru is intended to replace the whole Yandex installation,
not remain a second test site. This is an owner-reported availability statement,
not a new endpoint measurement. Preserve old resources and recovery copies until
the replacement passes acceptance; DNS cutover and Yandex deletion are separate
actions, neither authorized by a routine continuation of private testing.

## Sources And Safety

- The owner explicitly accepted the hosted Supabase demo dataset
  (`xlajjnmxvlkygixamyam`), not the newer Yandex database.
- Preserve the hosted source unchanged. The repository is application code,
  not a backup of users, annotations or model files.
- Do not change DNS, runtime configuration or the agr.vision release until the
  target passes the complete acceptance checks below.
- Local credentials and backup manifests live outside this Git repository in
  the parent `.secrets/cloudru/` and `backups/` directories. Credentials are
  owner-readable only. Never paste their values into logs, documentation or chat.

## Target Resources

| Resource | Configuration |
| --- | --- |
| viewer-backend-01 | Ubuntu 24.04, 4 dedicated vCPU, 8 GB RAM, 100 GB SSD |
| viewer-voice-01 | Ubuntu 24.04, 4 dedicated vCPU, 16 GB RAM, 100 GB SSD |
| agr-viewer-models | Private Object Storage, Standard class, 1024 GB limit |

VM provisioning and application readiness are separate checks. Record current
IDs, addresses and validation results in the private migration manifest.
The model service account has only `s3e.viewer` and `s3e.editor` on this bucket.
Its non-expiring key was explicitly approved by the owner; revoke and replace it
if compromised. There are no account-wide administrative rights on this key.

Initial VM ingress was SSH from the owner's current IPv4 `/32` only. On
2026-10-26 the owner separately approved TCP 22 from any IPv4 on both VMs;
password, keyboard-interactive and root login remain disabled. Outbound IPv4 is allowed for package installation,
metadata, DHCP and backend dependencies. Public application ports and private
inter-service rules must be reviewed separately before enabling services.

## Supabase Setup

Use the inspected official `self-hosted/v0.8.0` setup and Postgres 17 as in
[the existing migration runbook](supabase-yandex-migration-runbook.md).
Redirect bootstrap output into a root-only log because key generators print
secrets. Do not start the default Compose configuration with public port bindings.

Copy `infra/supabase-cloudru/docker-compose.cloudru.yml` beside the pinned
`docker-compose.yml`. Add the values from the private storage credential file
to the server's mode-600 `.env`, then set:

```dotenv
COMPOSE_FILE=docker-compose.yml:docker-compose.cloudru.yml
```

The Cloud.ru access-key identifier includes the tenant prefix. The region is
`ru-central-1`, unlike the old Yandex region spelling. The override binds the
gateway and database pooler to loopback during staging. Inspect the resolved
Compose port list without printing environment values before starting anything.

Apply the existing `infra/supabase-yandex/lpmview-envoy-storage-timeout` helper
to the pinned Envoy template. Its Storage route fix is provider-independent and
prevents the 30-second total timeout from truncating large downloads.

## Data Transfer

1. Export roles, schema and data with Supabase CLI's official filtered dump.
   Retain original dumps, hashes and a storage inventory outside Git.
2. Restore into the new target in one transaction with `ON_ERROR_STOP` using
   `supabase_admin`. Check source/target Auth and Storage column compatibility;
   create a separate adapted dump and never overwrite the original backup.
3. Apply missing incremental application migrations on the target only,
   including Storage RLS. Do not run the fresh-install `supabase/schema.sql`.
4. Transfer objects through the destination Supabase Storage API. Raw S3 keys
   do not reproduce Supabase's internal version mapping. Preserve ownership and
   timestamps, but keep the destination's generated object version.
5. Verify object counts, byte counts and SHA-256 through the destination API.
   Keep both the hosted source and local copies through stabilization.

Storage's `update_objects_updated_at` trigger overrides restored timestamps.
When restoring metadata, disable only this trigger inside the same transaction,
restore the original timestamps and SQL NULL user metadata, then re-enable the
trigger before committing. Do not replace the target object version or disable
foreign-key checks. Compare all ownership fields and timestamps after the update.

On 2026-10-26 the accepted demo dataset was restored into private staging:
191 Auth users (7 registered), 13 projects, 22 rooms, 27 model records,
154 annotations and 21 cameras. All 30 Storage objects, totaling 2,623,488,072
bytes, were uploaded through the target API and downloaded again for SHA-256
verification. Ownership and timestamps match the source inventory. Two of these
objects are existing empty-folder placeholders, not missing models.
The seven missing application migrations and eight-table Realtime publication
were applied on the destination only. Read-only RLS checks and a two-client
Realtime broadcast probe passed; these do not replace real login, room-event,
voice or end-to-end browser tests. A post-transfer database archive was created
and its archive index checked. A newer two-database backup passed the independent
restore procedure below; do not treat that as a restore test of the earlier
single-database archive.

The provider displayed an Object Storage upload restriction notice at setup.
Do not treat successful bucket creation or one upload as a passed Storage test.
Test large upload/download integrity from both a VM and a client before deciding
whether to retain Standard or request approval for a different storage class.

## Voice Preparation While Backend SSH Is Unavailable

On 2026-10-26 the new voice VM received a loopback-only LiveKit/API/Caddy
staging stack and an isolated rootless Checker runtime. See
[the reproducible staging procedure](../infra/voice-cloudru/README.md) for
installation, passed checks, retained artifacts and explicit activation gates.
No DNS, production release, public ingress or source database was changed.
The source database is never used by the staging queue worker.

The voice token endpoint now verifies Supabase Auth and room access under the
requesting user's RLS identity; it does not trust client identity or metadata.
The staging proxy still deliberately blocks it. Run the isolated authorization
probe in the voice staging procedure before publication. The private guard now
reauthorizes signaling/reconnect requests against current database rights and
periodically removes unauthorized LiveKit participants. A service-role-only
RPC reuses existing room policy helpers; it was applied only to the target
after a database backup. Real staging control/signaling tests verified guest
revocation after API restart, removal of a superuser role, room deletion and
denial of both original and LiveKit-refreshed tokens. Removal was confirmed by
LiveKit's administrative-removal log and participant absence, not merely a
closed socket. The tests do not establish ICE/media, browser reconnect or
two-device voice readiness. Previously issued JWTs are not cryptographically
revoked; they are rejected while the participant lacks current room rights.
Keep direct LiveKit control/signaling private so reconnect cannot bypass the
gate. Database failures fail closed; unavailable LiveKit control can delay
active removal. See the staging procedure for restart, cleanup and rollback.

## Private Backend HTTPS

The owner separately approved backend TCP 8443 from the voice VM's private
address only on 2026-10-26. This does not authorize public application ingress.
Keep the gateway and database pooler on loopback. Add a separate backend-only
security group permitting TCP 8443 from the voice private `/32`, without
replacing the existing SSH group or enabling all intra-group protocols.

`infra/supabase-cloudru/Caddyfile.internal` binds only the backend private IP,
requires the voice source IP, and proxies only Auth, REST, Storage and Realtime.
It disables HTTP redirects, HTTP/3 and the Caddy admin listener. Set
`LPM_BACKEND_PRIVATE_IP` and `LPM_VOICE_PRIVATE_IP` in a root-owned
`/etc/lpmview-backend-tls/proxy.env`; install the config at that directory's
`Caddyfile`. Use the supplied `lpmview-backend-tls.service` with a verified Caddy
binary at `/usr/local/bin/lpmview-backend-caddy`. Do not replace production Caddy.

Caddy's internal CA stays in the service's protected state directory. Transfer
only `data/caddy/pki/authorities/local/root.crt` to the voice VM as
`/etc/lpmview-ca/backend-root.crt`; the CA private key never leaves the backend.
The certificate is public information and can be mode 0644. Append
`compose.backend-tls.yaml` to the voice staging Compose files and set the
target-only Supabase URL/key in its protected environment file. Checker can
use the same public certificate through `NODE_EXTRA_CA_CERTS`, but its worker
must remain disabled until the engine identity and queue tests pass. On
2026-10-26 these checks passed against the restored target using the original
5.5 MB ZIP fixture. The API and worker now run in private staging, with the API
bound to loopback and `/model-check` still blocked by the staging proxy. Test
records were removed and the original data counts rechecked. The subsequent
private lifecycle probe completed a 238,948,040-byte ZIP with verified source
and engine identity, cancelled an active Blender run, rejected a damaged ZIP
and processed the next queued job after the Node worker was killed and restarted
by systemd. The interrupted job was marked incomplete after lease expiry, not
completed. Temporary objects/jobs/containers were cleaned up. This does not
establish whole-VM recovery, maximum-size throughput, browser or regulatory
compliance. See the staging procedure for the probe's prerequisites and cleanup.

The existing health timer is now enabled only on the new VM, with a service
override targeting `http://127.0.0.1:8081/health`. It checks services, free
workspace and a bounded JSON health response, without redirects or proxies.
The Yandex default remains unchanged. Failures are recorded in systemd/journal;
external notifications are still an acceptance gap.

Validate the actual Caddy config before activation. Verify TLS with the pinned
CA, verify failure without it, test allowed API paths from voice and denied
administrative paths, and verify that neither TCP 8443 from other sources nor
UDP 8443 is exposed. Never use `curl -k` or disable certificate verification.
Record deployed hashes, CA fingerprint, security group ID and test results in
the private migration checkpoint. Configuration files alone are not proof of
successful deployment.

## Verified Database Backups

On 2026-10-26 a fresh backup of `postgres`, `_supabase`, roles and backend
configuration was restored into a disposable, networkless PostgreSQL cluster.
All 71 selected tables matched their source snapshot row hashes; all 48 policies
and RLS flags matched. The encrypted off-VM copy was downloaded from Object
Storage and restored independently a second time with the same result. The
restore containers were removed; no source database/volume was modified.

The installed `lpmview-cloudru-backup.service` then completed a separate full
backup, isolated restore and encrypted upload. Its daily timer is enabled for
03:15 UTC plus up to ten minutes of jitter. All 11 Supabase containers remained
healthy with their published ports still loopback-only. The baseline remained
191 Auth users, 13 projects, 22 rooms, 27 models, 154 annotations, 21 cameras
and 30 Storage metadata records. Reports, local archives, recovery-key copy,
installed hashes and encrypted snapshot IDs are recorded in the private
migration checkpoint, never in the public repository.

This closes the database restore/scheduling checks, not the complete disaster
recovery requirement. The encrypted copy is in the same Cloud.ru account and
bucket, not an independent provider or immutable storage. The job excludes
model bytes, voice/Checker configuration and the private TLS CA. Ongoing model
backups, a separate failure domain, full-server recovery and external failure
notifications remain open. See [backup operation and limits](../infra/supabase-cloudru/BACKUPS.md).

## Private Browser Acceptance

On 2026-10-26 an isolated desktop Chrome connected to the migrated Cloud.ru
Auth, REST, Storage and Realtime APIs through strict-key SSH tunnels. Only the
local test server's runtime-config response was overridden; the repository's
runtime configuration, DNS, public ingress and published site were unchanged.
The backend responses were real, not mocked. Playwright was used because the
Browser plugin was unavailable.

The same flow passed in actual WebGPU and explicit WebGL modes:

- Registered owner password login and anonymous room-invite entry.
- A 5,509,617-byte ZIP loaded through private Storage; orbit changed both the
  camera position and rendered screenshot pixels.
- Two clients exchanged chat messages; a guest-created camera and annotation
  appeared for the owner and persisted after reload and invite re-entry.
- Forced offline/online recovery retained model and triangle counts and
  resumed message delivery. The open chat and unsent draft were preserved.
- Switching to an empty room cleared the scene; switching back reloaded it.
- App disposal left zero loaded models and zero Realtime subscriptions.

The check exposed a same-room reconnect bug that closed the chat and rebuilt
its history. Reconnect now retains the panel's open/hidden state, history,
deduplication state and contributor filters. Normal exit/disposal still clears
them, and initial entry still hides chat. The CI regression also exercises a
failed reconnect followed by retry, retained draft/history-node identity,
duplicate prevention and a chat kept hidden through another reconnect.

During deliberate network interruption, the channel error and failed first
reconnect are logged before automatic recovery. There were no page exceptions
or unrelated browser errors. Existing FBX unsupported-map warnings and the
Three.js Source rename warning remain. Reload-by-invite still requires the
normal entry confirmation; this is not automatic registered-session recovery.

This was a small-model desktop acceptance check, not a large-room benchmark or
physical iPad test. Mobile-sized screenshots do not establish device support.
Public HTTPS/WebSocket/ICE, two-device voice, GIS and the Checker browser UI
remain separate gates. Protected evidence and fixture-cleanup counts belong
in the private migration checkpoint, not in this public repository.

## Acceptance Before Cutover

- All containers healthy after reboot; no public database or admin-console ports.
- Registered and anonymous Auth, project/room RLS and superuser checks pass.
- Realtime join, broadcast, reconnect and room switching pass.
- All objects present; large downloads, signed URLs and disposable upload/delete
  tests pass with the private bucket.
- Voice/LiveKit, GIS integration and isolated Checker are deployed and tested.
- Latest viewer passes CI and browser checks against staging without changing
  production endpoints; no physical-mobile claim without a real device test.
- Database scheduled local/off-VM backups and independent restore have passed;
  ongoing model/voice backup coverage and full-server recovery remain required.
- HTTPS and WebSocket routing are validated before a controlled DNS cutover;
  retain the old provider's resources/release and recovery copies, without
  assuming the owner-reported unavailable Yandex installation is a working
  rollback target. Prepare a tested recovery path before decommissioning it.
