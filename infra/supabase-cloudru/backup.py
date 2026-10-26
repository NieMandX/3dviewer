#!/usr/bin/env python3
"""Root-only Cloud.ru backup. Dumps contain credentials; never print SQL/logs."""
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path('/var/backups/lpmview-cloudru')
STACK = Path('/opt/lpmview/supabase')
LOCK = '/run/lock/lpm-cloudru-migration.lock'
DATABASES = ('postgres', '_supabase')
SCHEMAS = ('public', 'auth', 'storage', 'vault', '_realtime', 'realtime', '_supavisor', '_analytics', 'supabase_functions')


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def run(args, *, data=None, output=None, timeout=300):
    result = subprocess.run(args, input=data, stdout=output or subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        # SQL errors can include private values. Retain them only in root-only evidence.
        raise RuntimeError('Backup command failed: ' + Path(args[0]).name)
    return result.stdout


def psql(container, database, query, *, user='supabase_admin', output=None, socket=None):
    return run(['docker', 'exec', '-i', container, 'psql', *(['-h', socket] if socket else []), '-XqAt', '-U', user, '-d', database,
                '-v', 'ON_ERROR_STOP=1'], data=query.encode(), output=output)


def quote_ident(value):
    return '"' + value.replace('"', '""') + '"'


@contextlib.contextmanager
def snapshot(database):
    with tempfile.TemporaryFile() as errors:
        p = subprocess.Popen(['docker', 'exec', '-i', 'supabase-db', 'psql', '-XqAt', '-U', 'supabase_admin',
                              '-d', database, '-v', 'ON_ERROR_STOP=1'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors)
        try:
            p.stdin.write(b'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();\n')
            p.stdin.flush()
            token = p.stdout.readline().decode().strip()
            if not re.fullmatch(r'[0-9A-F]+-[0-9A-F]+-[0-9]+', token):
                raise RuntimeError('Could not export database snapshot')
            yield token
            p.communicate(b'COMMIT;\n', timeout=20)
            if p.returncode:
                raise RuntimeError('Snapshot connection failed')
        finally:
            if p.poll() is None:
                p.kill()
                p.wait(timeout=20)


def fingerprint(container, database, *, token=None, user='supabase_admin', socket=None):
    prefix = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; '
    if token:
        if not re.fullmatch(r'[0-9A-F]+-[0-9A-F]+-[0-9]+', token):
            raise ValueError('Invalid snapshot ID')
        prefix += "SET TRANSACTION SNAPSHOT '" + token + "'; "
    # Compare stored values independently of host-specific display defaults.
    prefix += "SET LOCAL timezone = 'UTC'; SET LOCAL extra_float_digits = 3; SET LOCAL datestyle = 'ISO, YMD'; SET LOCAL intervalstyle = 'postgres'; SET LOCAL bytea_output = 'hex'; "
    schema_sql = ','.join("'" + name + "'" for name in SCHEMAS)
    tables = json.loads(psql(container, database, prefix +
        "SELECT coalesce(json_agg(json_build_array(schemaname,tablename) ORDER BY schemaname,tablename),'[]'::json) "
        'FROM pg_tables WHERE schemaname IN (' + schema_sql + '); COMMIT;', user=user, socket=socket))
    result = {}
    for schema, table in tables:
        name = quote_ident(schema) + '.' + quote_ident(table)
        query = prefix + 'COPY (SELECT to_jsonb(t)::text FROM ' + name + ' t ORDER BY to_jsonb(t)::text COLLATE "C") TO STDOUT; COMMIT;'
        with tempfile.TemporaryFile() as stream:
            psql(container, database, query, user=user, output=stream, socket=socket)
            stream.seek(0)
            h, rows = hashlib.sha256(), 0
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                h.update(block)
                rows += block.count(b'\n')
        result[schema + '.' + table] = {'rows': rows, 'sha256': h.hexdigest()}
    policies = json.loads(psql(container, database, prefix +
        "SELECT coalesce(json_agg(to_jsonb(t) ORDER BY schemaname,tablename,policyname),'[]'::json) FROM pg_policies t; COMMIT;", user=user, socket=socket))
    rls = json.loads(psql(container, database, prefix +
        "SELECT coalesce(json_agg(json_build_array(n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity) ORDER BY n.nspname,c.relname),'[]'::json) "
        "FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE c.relkind IN ('r','p') AND n.nspname IN (" + schema_sql + '); COMMIT;', user=user, socket=socket))
    return {'tables': result, 'policies': policies, 'rls': rls}


def create_backup():
    if shutil.disk_usage(ROOT).free < 8 * 1024 ** 3:
        raise RuntimeError('Less than 8 GiB free for database backup')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    stage = Path(tempfile.mkdtemp(prefix='.pending-', dir=ROOT))
    manifest = {'format': 1, 'createdAt': stamp, 'databases': {}, 'files': {},
                'modelBytesIncluded': False, 'internalTlsCaPrivateKeyIncluded': False}
    manifest['bootstrapRole'] = psql('supabase-db', 'postgres', 'SELECT rolname FROM pg_roles WHERE oid=10;').decode().strip()
    if manifest['bootstrapRole'] != 'supabase_admin':
        raise RuntimeError('Unexpected source bootstrap role')
    info = json.loads(run(['docker', 'inspect', 'supabase-db']))[0]
    manifest['postgresImage'] = info['Image']
    if not re.fullmatch('sha256:[a-f0-9]{64}', info['Image']):
        raise RuntimeError('Database image must be immutable')
    with (stage / 'roles.sql').open('xb') as out:
        run(['docker', 'exec', 'supabase-db', 'pg_dumpall', '-U', 'supabase_admin', '--roles-only'], output=out)
    for db in DATABASES:
        with snapshot(db) as token:
            with (stage / (db + '.dump')).open('xb') as out:
                run(['docker', 'exec', 'supabase-db', 'pg_dump', '-U', 'supabase_admin', '-d', db,
                     '-Fc', '--compress=6', '--snapshot=' + token], output=out)
            with (stage / (db + '.dump')).open('rb') as source:
                listing = subprocess.run(['docker', 'exec', '-i', 'supabase-db', 'pg_restore', '--list'],
                    stdin=source, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=60)
                if listing.returncode:
                    raise RuntimeError('Invalid database archive')
            manifest['databases'][db] = fingerprint('supabase-db', db, token=token)
    run(['docker', 'cp', 'supabase-db:/etc/postgresql-custom', str(stage / 'db-custom')])
    for file in (stage / 'db-custom').rglob('*'):
        if file.is_symlink():
            raise RuntimeError('Unexpected symlink in database config')
    paths = list(STACK.glob('docker-compose*.yml')) + list((STACK / 'volumes/db').glob('*.sql')) + [STACK / '.env', STACK / '.supabase-version',
        STACK / 'volumes/api', STACK / 'volumes/pooler', STACK / 'volumes/functions/main',
        Path('/etc/lpmview-backend-tls'), Path('/etc/systemd/system/lpmview-backend-tls.service')]
    with tarfile.open(stage / 'config.tgz', 'x:gz') as archive:
        for path in paths:
            archive.add(path, arcname=str(path).lstrip('/'))
    for file in sorted(stage.rglob('*')):
        if file.is_file():
            manifest['files'][str(file.relative_to(stage))] = {'bytes': file.stat().st_size, 'sha256': sha256(file)}
    if sum(v['bytes'] for v in manifest['files'].values()) > 2 * 1024 ** 3:
        raise RuntimeError('Database/config backup exceeds the reviewed 2 GiB limit')
    (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    final = ROOT / ('backup-' + stamp)
    stage.rename(final)
    return final


def main():
    os.umask(0o077)
    if os.getuid() != 0 or run(['hostname']).decode().strip() != 'viewer-backend-01':
        raise RuntimeError('This backup is only for the reviewed Cloud.ru backend')
    ROOT.mkdir(mode=0o700, exist_ok=True)
    if ROOT.is_symlink() or ROOT.stat().st_uid != 0 or ROOT.stat().st_mode & 0o077:
        raise RuntimeError('Backup directory must be private and root-owned')
    with open(LOCK, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = create_backup()
        print(json.dumps({'ok': True, 'backup': str(result), 'modelBytesIncluded': False}))


if __name__ == '__main__':
    main()
