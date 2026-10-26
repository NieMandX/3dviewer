"""Encrypted off-VM database backups in the owner's private Cloud.ru bucket."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

import backup

CONFIG = Path('/etc/lpmview-backup/restic.json')
TAG = 'lpmview-cloudru-db'
HOST = 'viewer-backend-01'


def environment():
    if CONFIG.is_symlink() or CONFIG.stat().st_uid != 0 or CONFIG.stat().st_mode & 0o077:
        raise RuntimeError('Restic configuration must be root-only')
    values = json.loads(CONFIG.read_text())
    if values['RESTIC_REPOSITORY'] != 's3:https://s3.cloud.ru/agr-viewer-models/_backups/backend':
        raise ValueError('Unreviewed backup destination')
    key = Path(values['RESTIC_PASSWORD_FILE'])
    if key != Path('/etc/lpmview-backup/restic-password') or key.is_symlink() or key.stat().st_uid != 0 or key.stat().st_mode & 0o077:
        raise ValueError('Recovery key must be root-only')
    allowed = {'RESTIC_REPOSITORY', 'RESTIC_PASSWORD_FILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_DEFAULT_REGION'}
    if set(values) != allowed or any(not isinstance(v, str) or not v for v in values.values()):
        raise ValueError('Invalid backup credentials configuration')
    return {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/root', 'RESTIC_CACHE_DIR': '/var/cache/lpmview-restic', **values}


def restic(args, log, *, timeout=1800):
    result = subprocess.run(['/usr/local/bin/lpmview-restic', *args], env=environment(),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    with Path(log).open('ab') as evidence:
        evidence.write(result.stdout)
        evidence.write(result.stderr)
    if result.returncode:
        raise RuntimeError('Encrypted backup command failed; protected log retained')
    return result.stdout


def upload(path):
    path = path.resolve(strict=True)
    if path.parent != backup.ROOT or not re.fullmatch(r'backup-\d{8}T\d{6}Z', path.name):
        raise ValueError('Not a completed generated backup')
    log = backup.ROOT / (path.name + '-offsite.log')
    records = restic(['backup', '--json', '--host', HOST, '--tag', TAG, '--limit-upload', '10240', str(path)], log)
    summary = next(json.loads(line) for line in records.splitlines() if json.loads(line).get('message_type') == 'summary')
    snapshot = summary['snapshot_id']
    if not re.fullmatch(r'[a-f0-9]{8,64}', snapshot):
        raise RuntimeError('Missing encrypted snapshot identity')
    restic(['check', '--read-data'], log)
    report = {'ok': True, 'snapshot': snapshot, 'bytesProcessed': summary['total_bytes_processed'],
              'repositoryDataChecked': True, 'modelBytesIncluded': False, 'independentProvider': False}
    (backup.ROOT / (path.name + '-offsite.json')).write_text(json.dumps(report, indent=2) + '\n')
    return report


def retain(log):
    restic(['forget', '--host', HOST, '--tag', TAG, '--group-by', 'host,tags',
            '--keep-daily', '7', '--keep-weekly', '4', '--keep-monthly', '3', '--prune'], log)
    restic(['check'], log)
    completed = sorted(p for p in backup.ROOT.iterdir() if re.fullmatch(r'backup-\d{8}T\d{6}Z', p.name)
                       and p.is_dir() and not p.is_symlink())
    # Only retire our completed copies with a recorded successful encrypted upload.
    for path in completed[:-7]:
        proof = backup.ROOT / (path.name + '-offsite.json')
        if proof.is_file() and json.loads(proof.read_text()).get('ok') is True:
            shutil.rmtree(path)


def recover(snapshot, original):
    if not re.fullmatch(r'[a-f0-9]{8,64}', snapshot) or not re.fullmatch(r'backup-\d{8}T\d{6}Z', original):
        raise ValueError('Invalid snapshot or source name')
    target = Path(tempfile.mkdtemp(prefix='.offsite-recovery-', dir=backup.ROOT))
    log = backup.ROOT / ('offsite-recovery-' + snapshot + '.log')
    restic(['restore', snapshot, '--target', str(target), '--verify'], log)
    restored = target / str(backup.ROOT).lstrip('/') / original
    if not restored.is_dir() or restored.is_symlink():
        raise RuntimeError('Restored snapshot did not contain the expected backup')
    destination = backup.ROOT / ('backup-recovered-' + snapshot)
    if destination.exists():
        raise RuntimeError('Recovery evidence already exists')
    restored.rename(destination)
    shutil.rmtree(target)
    return destination
