# Cloud.ru Database Backups

This procedure is for the reviewed Cloud.ru `viewer-backend-01`, not the
historical Yandex installation. It does not publish endpoints or change DNS.
Keep backup archives, evidence and recovery credentials outside Git.

## Contents And Boundaries

`backup.py` captures both `postgres` and `_supabase`, cluster roles, the
Supabase Compose/configuration files and `/etc/postgresql-custom` (including
the database encryption key). Dumps and configuration contain credentials.
The root-owned backup directory is mode 0700; new files use umask 0077.

Each database dump and its row fingerprints use the same exported, read-only
repeatable-read snapshot. The two databases and role/configuration capture
are not one globally atomic snapshot. Do not deploy, rotate credentials or
modify schemas during capture. Migration and backup scripts share the
nonblocking `/run/lock/lpm-cloudru-migration.lock`.

Database restore verifies hashes and row counts for the application, Auth,
Storage, Vault and service schemas, plus policies and RLS flags. It does not
replace an application login, Storage byte recovery, full-VM disaster recovery
or a browser/voice acceptance test. Unlogged/ephemeral service data follows
PostgreSQL dump semantics, not a physical volume snapshot.

**Not included in this daily job:** model object bytes, voice/Checker state,
container images, and the private internal-TLS CA key. Model bytes currently
have the original local migration copy; ongoing protection for new models,
versioning/deletion recovery and capacity for a full 1 TB dataset still need
a separate budgeted policy. The internal CA is deliberately not exported;
a replacement server must issue a new CA and update the voice server's trust.
Preserve pinned images and existing private voice/Checker recovery archives.

## Storage And Retention

- Local backups: `/var/backups/lpmview-cloudru/backup-<UTC timestamp>`.
- Encrypted repository: `s3:https://s3.cloud.ru/agr-viewer-models/_backups/backend`.
- Restic: reviewed version 0.19.1, `/usr/local/bin/lpmview-restic`.
- Root-only credentials: `/etc/lpmview-backup/restic.json` and
  `/etc/lpmview-backup/restic-password`; never print these files.
- Local retention: seven latest generated copies, removing older copies only
  after a recorded successful encrypted upload. Failed/incomplete runs and
  explicit recovery evidence are not automatically deleted.
- Remote retention: seven daily, four weekly and three monthly snapshots,
  grouped by host and tag rather than timestamp-specific source paths.

Every upload is followed by a full Restic data integrity check. Retention runs
only after that succeeds; it prunes only this backup repository. Monitor backup
size, runtime and failed evidence accumulation. The current job refuses a
database/configuration archive over 2 GiB or less than 8 GiB free disk. These
are review guards, not a reserved storage quota or a guarantee that future
growth fits the monthly budget. Restore verification uses a 1 GiB temporary
database volume and must be reviewed before the database outgrows it.

This is an **off-VM copy in the same Cloud.ru account and bucket**, not an
independent-provider, immutable or append-only backup. It uses the existing
bucket-scoped model service credential; that credential can delete backup
objects. A provider/account failure or credential compromise is therefore
still a shared risk. Keep a separate recovery-key copy outside Cloud.ru and
plan a separately authorized independent destination for ongoing backups.
The private migration checkpoint records the current local recovery-key
archive and checksum. Losing the encryption key makes these copies unusable.

## Installation And Daily Operation

Install `backup.py`, `offsite.py`, `verify-restore.py`, `daily-backup.py` and
`restore-entrypoint.sh` under root-owned `/opt/lpmview/backup`. Install the
supplied systemd service/timer in `/etc/systemd/system`. The Restic binary,
repository and protected credential files must already be prepared; never
regenerate a key or initialize a replacement repository during an update.

After validating units, run the service once and verify a successful exit,
restore report and offsite evidence before enabling the timer:

```bash
sudo systemctl daemon-reload
sudo systemctl start lpmview-cloudru-backup.service
sudo systemctl show lpmview-cloudru-backup.service -p Result -p ExecMainStatus
sudo systemctl enable --now lpmview-cloudru-backup.timer
sudo systemctl list-timers lpmview-cloudru-backup.timer
```

The timer runs daily at 03:15 UTC with up to ten minutes of jitter (06:15-06:25
Moscow time); `Persistent=true` catches a missed run after startup. Each run
creates a backup, verifies it in an isolated cluster, uploads it encrypted and
applies bounded retention. Overlapping migration/backup work fails rather than
starting another copy. The service allows one hour; failures stay visible in
systemd/journal and protected evidence. External failure notifications are
**not configured**. A scheduled unit is not proof of a successful later run.

## Independent Restore Verification

```bash
sudo python3 -B /opt/lpmview/backup/verify-restore.py \
  /var/backups/lpmview-cloudru/backup-<UTC timestamp>
```

Only use trusted backups: PostgreSQL restores can execute code from a dump.
The script requires the captured immutable PostgreSQL image to exist locally.
It never restores into `supabase-db`. A disposable container has no network or
published ports, a read-only root filesystem, no capabilities, a non-root
database user, 1 CPU and a 2 GiB memory limit. Database state lives in tmpfs.
It is removed after the test; source databases and volumes are never mounted.

Initialize the disposable cluster with the original bootstrap superuser
`supabase_admin`. PostgreSQL 17 role membership `GRANTED BY` can fail under a
different bootstrap identity even when that role is a superuser. The verifier
omits only its already-existing `CREATE ROLE` statement from an in-memory copy,
retaining every `ALTER` and `GRANT`; original archives remain unchanged.

Both databases restore with `--create --exit-on-error`, preserving ACLs and
ownership. There is no transaction around database creation; isolation comes
from the disposable cluster. The empty initial `postgres` is replaced only
inside that cluster. Canonical table comparison uses UTC and identical floating
point formatting, avoiding differences caused by host display settings.

To test the encrypted copy, use `offsite.recover(snapshot_id, original_name)`
under the same migration lock, then pass the returned directory to
`verify-restore.py`. Restic downloads into a new directory and verifies data;
it never overwrites the source backup. Confirm the downloaded manifest hash
before restoring. Actual full-server recovery additionally requires restoring
configuration, model bytes, keys and service connectivity; it is a separate
controlled operation, not this verifier.

## References

- [PostgreSQL 17 pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)
- [PostgreSQL SQL dumps](https://www.postgresql.org/docs/17/backup-dump.html)
- [Restic repository preparation](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html)
- [Restic restoration](https://restic.readthedocs.io/en/stable/050_restore.html)
- [Restic retention](https://restic.readthedocs.io/en/stable/060_forget.html)
