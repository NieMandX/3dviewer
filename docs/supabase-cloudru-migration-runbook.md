# Cloud.ru Migration Staging

Started: 2026-10-25. This is a parallel migration, not a production release.
The owner approved a monthly ceiling of RUB 17,000, including capacity for
1 TB of model objects. Recheck traffic and retained backup charges before cutover.

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

Initial VM ingress is SSH from the owner's current IPv4 `/32` only, with
password login disabled. Outbound IPv4 is allowed for package installation,
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
The source database is not used by the staging queue worker, which stays off.

The current voice token endpoint lacks a room-membership check. The staging
proxy deliberately blocks it; fixing authorization is a publication gate, not
a reason to open the legacy endpoint while migration proceeds.

## Acceptance Before Cutover

- All containers healthy after reboot; no public database or admin-console ports.
- Registered and anonymous Auth, project/room RLS and superuser checks pass.
- Realtime join, broadcast, reconnect and room switching pass.
- All objects present; large downloads, signed URLs and disposable upload/delete
  tests pass with the private bucket.
- Voice/LiveKit, GIS integration and isolated Checker are deployed and tested.
- Latest viewer passes CI and browser checks against staging without changing
  production endpoints; no physical-mobile claim without a real device test.
- Scheduled local and offsite backups exist, with a successful restore test.
- HTTPS and WebSocket routing are validated before a controlled DNS cutover;
  the previous provider and release remain available for rollback.
