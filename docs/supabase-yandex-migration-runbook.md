# Supabase to Yandex Cloud Migration Runbook

## Safety boundary

The Yandex deployment is a parallel staging backend. Do not change
`config/runtime.js`, the fallback config in `index.html`, or DNS until database,
Auth, Realtime, Storage, HTTPS, and viewer smoke tests pass. Keep the managed
Supabase project available for rollback through the stabilization period.

## Target topology

- VM: `viewer-backend-01`, Ubuntu 24.04, 4 vCPU, 8 GiB RAM, 96 GiB SSD.
- Supabase Docker release: `self-hosted/v0.8.0`, Postgres 17.
- Public endpoint: `https://supabase.agr.vision`.
- `api.agr.vision` remains assigned to the voice API.
- Database ports `5432` and `6543` are bound to `127.0.0.1` only.
- Before Caddy is enabled, API port `8000` is also bound to `127.0.0.1` only.
- Model objects use private bucket `agr-viewer-supabase-prod` through a dedicated
  `viewer-backend-storage` service account.

## Install the pinned stack

Inspect the official installer before execution, then install the pinned release:

```bash
curl -fsSL \
  https://raw.githubusercontent.com/supabase/supabase/master/docker/setup.sh \
  -o /tmp/supabase-setup.sh
chmod 700 /tmp/supabase-setup.sh
cd /opt/lpmview
/tmp/supabase-setup.sh \
  --project-dir supabase \
  --ref self-hosted/v0.8.0 \
  --skip-deps \
  --yes
```

Regenerate any secrets printed during bootstrap with output redirected, then set
`.env` to mode `600`. Do not store generated secrets in this repository.

Copy `infra/supabase-yandex/docker-compose.yandex.yml` beside the official
`docker-compose.yml`. During private staging use:

```dotenv
COMPOSE_FILE=docker-compose.yml:docker-compose.yandex.yml
```

After DNS is ready, use the official Caddy override last so it removes the host
binding from the API gateway and exposes only ports 80/443:

```dotenv
COMPOSE_FILE=docker-compose.yml:docker-compose.yandex.yml:docker-compose.caddy.yml
```

## Managed database export and restore

Use the current Supabase CLI and the official filtered dump workflow:

```bash
supabase db dump --linked -f roles.sql --role-only
supabase db dump --linked -f schema.sql
supabase db dump --linked -f data.sql --use-copy --data-only
```

The managed service may have newer internal Auth and Storage columns than the
self-hosted image. For the tested v0.8.0 restore, remove these source-only fields
from the matching `COPY` headers and rows:

- `auth.custom_oauth_providers.custom_claims_allowlist`
- `storage.buckets.versioning_status`
- `storage.objects.archived_at`
- `storage.objects.is_delete_marker`
- `storage.objects.is_versioned`

Restore all files in one transaction. The v0.8.0 image hardens `postgres` as a
non-superuser, so copy the files into the database container and use its internal
`supabase_admin` role:

```bash
docker cp roles.sql supabase-db:/tmp/roles.sql
docker cp schema.sql supabase-db:/tmp/schema.sql
docker cp data.compat.sql supabase-db:/tmp/data.compat.sql

docker exec supabase-db psql \
  -U supabase_admin \
  -d postgres \
  --single-transaction \
  --variable ON_ERROR_STOP=1 \
  --file /tmp/roles.sql \
  --file /tmp/schema.sql \
  --command 'SET session_replication_role = replica' \
  --file /tmp/data.compat.sql
```

## Storage migration

Do not copy files directly into `volumes/storage`. Configure Yandex Object
Storage as the S3 backend, then use the Supabase S3 protocol and `rclone` so the
Storage service owns the copy workflow. Compare object count and total bytes on
both sides, and download at least one small and one large model through the
self-hosted API.

## Backups

Install the backup script and systemd units:

```bash
sudo install -m 700 \
  infra/supabase-yandex/lpmview-supabase-backup \
  /usr/local/sbin/lpmview-supabase-backup
sudo install -m 644 \
  infra/supabase-yandex/lpmview-supabase-backup.service \
  infra/supabase-yandex/lpmview-supabase-backup.timer \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lpmview-supabase-backup.timer
sudo systemctl start lpmview-supabase-backup.service
```

Backups are written root-only to `/var/backups/lpmview-supabase` and retained for
seven days. Add an offsite copy to private Object Storage before production
cutover.

## Required verification before cutover

1. All Docker services report healthy after a reboot.
2. Auth supports email/password and anonymous invite sessions.
3. Realtime subscribe, broadcast, reconnect, and room switching pass.
4. REST row counts match the managed project and RLS blocks unauthorized reads.
5. Every Storage object exists and total bytes match the source.
6. Upload, download, signed URL, delete, and a model larger than 50 MiB pass.
7. `supabase.agr.vision` has a valid certificate and WebSocket upgrade works.
8. Viewer smoke tests pass against staging without editing production config.
9. A database restore from the scheduled backup is tested on an empty stack.

## Rollback

If a production check fails, restore the managed Supabase URL and anon key in
runtime config, deploy `gh-pages`, and leave the Yandex backend isolated for
diagnosis. Do not delete the managed project or its Storage objects during the
stabilization period.
