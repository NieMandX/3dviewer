#!/usr/bin/env python3
import fcntl
import importlib.util
import json
import os
from pathlib import Path

import backup
import offsite

spec = importlib.util.spec_from_file_location('restore_probe', Path(__file__).with_name('verify-restore.py'))
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)


def main():
    os.umask(0o077)
    if os.getuid() != 0 or backup.run(['hostname']).decode().strip() != 'viewer-backend-01':
        raise RuntimeError('Unreviewed backup host')
    backup.ROOT.mkdir(mode=0o700, exist_ok=True)
    if backup.ROOT.is_symlink() or backup.ROOT.stat().st_uid != 0 or backup.ROOT.stat().st_mode & 0o077:
        raise RuntimeError('Backup root must be private')
    with open(backup.LOCK, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        path = backup.create_backup()
        restore.verify(path)
        result = offsite.upload(path)
        offsite.retain(backup.ROOT / (path.name + '-offsite.log'))
        print(json.dumps({'backupOk': True, 'backup': str(path), 'snapshot': result['snapshot'], 'modelBytesIncluded': False}))


if __name__ == '__main__':
    main()
