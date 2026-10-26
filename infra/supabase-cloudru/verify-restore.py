#!/usr/bin/env python3
"""Restore a trusted Cloud.ru backup into a disposable, networkless cluster."""
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

import backup


def roles_for_restore(roles):
    # PG17 GRANTED BY requires the original bootstrap superuser. It already
    # exists after initdb; retain every ALTER/GRANT from the original dump.
    declaration = b'CREATE ROLE supabase_admin;\n'
    if roles.count(declaration) != 1:
        raise ValueError('Unexpected bootstrap declaration in trusted role dump')
    return roles.replace(declaration, b'')


def verify(path):
    path = path.resolve(strict=True)
    if path.parent != backup.ROOT or not path.name.startswith('backup-'):
        raise ValueError('Expected a completed local Cloud.ru backup')
    manifest = json.loads((path / 'manifest.json').read_text())
    if manifest['format'] != 1 or manifest.get('bootstrapRole') != 'supabase_admin' or set(manifest['databases']) != set(backup.DATABASES):
        raise ValueError('Unsupported backup')
    if not re.fullmatch('sha256:[a-f0-9]{64}', manifest['postgresImage']):
        raise ValueError('Restore requires an immutable local image')
    backup.run(['docker', 'image', 'inspect', manifest['postgresImage']])
    for name, expected in manifest['files'].items():
        file = (path / name).resolve(strict=True)
        if not file.is_relative_to(path) or file.stat().st_size != expected['bytes'] or backup.sha256(file) != expected['sha256']:
            raise ValueError('Backup integrity check failed')
    name = 'lpm-restore-' + uuid.uuid4().hex[:12]
    stage = Path(tempfile.mkdtemp(prefix='.restore-', dir=backup.ROOT))
    logpath = path / (name + '.log')
    report = {'ok': False, 'container': name, 'backup': str(path), 'modelBytesRestored': False,
              'network': 'none', 'sourceDatabaseChanged': False, 'databases': {}, 'phase': 'initialization'}
    created = False
    started = time.monotonic()
    try:
        shutil.copytree(path / 'db-custom', stage / 'db-custom')
        for file in [stage / 'db-custom', *(stage / 'db-custom').rglob('*')]:
            os.chown(file, 100, 101)
        entry = Path(__file__).with_name('restore-entrypoint.sh').resolve()
        backup.run(['docker', 'create', '--name', name, '--label', 'lpmview.restore-probe=true', '--network', 'none',
            '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '100:101',
            '--memory', '2g', '--memory-swap', '2g', '--cpus', '1', '--pids-limit', '128',
            '--tmpfs', '/restore-data:rw,uid=100,gid=101,mode=0700,size=1073741824',
            '--tmpfs', '/tmp:rw,uid=100,gid=101,mode=1777,size=67108864',
            '--tmpfs', '/var/lib/postgresql/data:rw,uid=100,gid=101,mode=0700,size=16777216',
            '--mount', 'type=bind,src=' + str(entry) + ',dst=/restore-entrypoint.sh,readonly',
            '--mount', 'type=bind,src=' + str(stage / 'db-custom') + ',dst=/etc/postgresql-custom,readonly',
            '--entrypoint', '/bin/sh', manifest['postgresImage'], '/restore-entrypoint.sh'])
        created = True
        backup.run(['docker', 'start', name])
        with logpath.open('xb') as log:
            for _ in range(60):
                ready = subprocess.run(['docker', 'exec', name, 'pg_isready', '-h', '/tmp', '-U', 'supabase_admin', '-d', 'template1'],
                    stdout=log, stderr=log, timeout=10)
                if ready.returncode == 0:
                    break
                time.sleep(1)
            else:
                subprocess.run(['docker', 'logs', name], stdout=log, stderr=log, timeout=10)
                raise RuntimeError('Isolated PostgreSQL did not start')
            report['phase'] = 'roles'
            roles = roles_for_restore((path / 'roles.sql').read_bytes())
            p = subprocess.run(['docker', 'exec', '-i', name, 'psql', '-h', '/tmp', '-Xq', '-U', 'supabase_admin',
                                '-d', 'template1', '-v', 'ON_ERROR_STOP=1'], input=roles, stdout=log, stderr=log, timeout=60)
            if p.returncode:
                raise RuntimeError('Role restore failed; protected evidence retained')
            # pg_net may connect to the freshly initialized empty postgres DB.
            # This container is disposable; no application/source connection exists.
            p = subprocess.run(['docker', 'exec', name, 'dropdb', '--force', '-h', '/tmp', '-U', 'supabase_admin', 'postgres'],
                               stdout=log, stderr=log, timeout=30)
            if p.returncode:
                raise RuntimeError('Could not replace the isolated empty database')
            for db in backup.DATABASES:
                report['phase'] = 'restore:' + db
                with (path / (db + '.dump')).open('rb') as dump:
                    p = subprocess.run(['docker', 'exec', '-i', name, 'pg_restore', '-h', '/tmp', '-U', 'supabase_admin',
                        '--exit-on-error', '--create', '-d', 'template1'], stdin=dump, stdout=log, stderr=log, timeout=300)
                    if p.returncode:
                        raise RuntimeError('Database restore failed; protected evidence retained')
                report['phase'] = 'compare:' + db
                actual = backup.fingerprint(name, db, user='supabase_admin', socket='/tmp')
                if actual != manifest['databases'][db]:
                    (path / (name + '-' + db + '-actual.json')).write_text(json.dumps(actual, indent=2) + '\n')
                    raise RuntimeError('Restored table data or RLS differs')
                report['databases'][db] = {'tableHashesMatch': True, 'tableCount': len(actual['tables']),
                    'policiesMatch': True, 'policyCount': len(actual['policies']), 'rlsFlagsMatch': True}
            report['ok'] = True
            report['phase'] = 'complete'
    finally:
        if created:
            info = json.loads(backup.run(['docker', 'inspect', name]))[0]
            report['oomKilled'] = info['State']['OOMKilled']
            report['network'] = info['HostConfig']['NetworkMode']
            if info['Config']['Labels'].get('lpmview.restore-probe') != 'true':
                raise RuntimeError('Refusing to remove an unrelated container')
            backup.run(['docker', 'rm', '-fv', name])
        shutil.rmtree(stage)
        report['containerRemoved'] = created
        report['seconds'] = round(time.monotonic() - started, 3)
        reportpath = path / (name + '.json')
        reportpath.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({'ok': report['ok'], 'phase': report['phase'], 'report': str(reportpath), 'seconds': report['seconds']}))


if __name__ == '__main__':
    os.umask(0o077)
    if os.getuid() != 0 or backup.run(['hostname']).decode().strip() != 'viewer-backend-01':
        raise RuntimeError('This probe only runs on the reviewed Cloud.ru backend')
    with open(backup.LOCK, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        verify(Path(sys.argv[1]))
