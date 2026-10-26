"""First-time private Checker configuration; stdin contains target anon key only.

Run as root on Cloud.ru voice under the migration lock. Does not start services,
register an engine, change ingress, or modify the staging reverse proxy.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

assert os.geteuid() == 0
assert subprocess.check_output(['hostname'], text=True).strip() == 'viewer-voice-01'
assert Path('/etc/lpmview-ca/backend-root.crt').is_file()
for unit in ('lpmview-checker-api.service', 'lpmview-checker-worker.service'):
    assert subprocess.run(['systemctl', 'is-active', '--quiet', unit]).returncode != 0

root = Path('/etc/lpmview-checker')
assert not (root / 'api.env').exists() and not (root / 'worker.env').exists()
root.mkdir(mode=0o700, exist_ok=True)
os.chmod(root, 0o700)
voice = dict(line.split('=', 1) for line in Path('/etc/lpmview-voice/voice-api.env').read_text().splitlines()
             if '=' in line and not line.startswith('#'))
assert voice['SUPABASE_URL'] == 'https://10.0.0.5:8443'
anon = json.load(sys.stdin)['anonKey']
service = voice['SUPABASE_SERVICE_ROLE_KEY']
assert isinstance(anon, str) and len(anon) > 100 and anon != service
assert not any(c in anon + service for c in '\r\n\x00"\\')
wrapper = Path('/opt/lpmview/checker/service/container-runner.py')
assert wrapper.stat().st_uid == 0 and wrapper.stat().st_mode & 0o022 == 0
assert hashlib.sha256(wrapper.read_bytes()).hexdigest() == 'fb882509386e3c66843dc5a8b3d17c51126c0573a88c1262f4185fce2d6a1a43'

def save(name, values):
    with (root / name).open('x') as stream:
        os.fchmod(stream.fileno(), 0o600)
        for key, value in values.items():
            stream.write(f'{key}={value}\n')

save('api.env', {
    'SUPABASE_URL': voice['SUPABASE_URL'], 'SUPABASE_ANON_KEY': anon,
    'MODEL_CHECK_ALLOWED_ORIGINS': 'http://127.0.0.1:8090',
    'MODEL_CHECK_TRUST_PROXY': '0', 'HOST': '127.0.0.1', 'PORT': '8081',
})
save('worker.env', {
    'SUPABASE_URL': voice['SUPABASE_URL'], 'SUPABASE_SERVICE_ROLE_KEY': service,
    'MODEL_CHECK_ENGINE_REVISION': 'agr161-20261026-cloudru-rootless2cpu4g',
    'MODEL_CHECK_WRAPPER': str(wrapper), 'MODEL_CHECK_PYTHON': '/usr/bin/python3',
    'MODEL_CHECK_WORK_DIR': '/var/lib/lpmview-checker/work/jobs',
})
print(json.dumps({'ok': True, 'host': '127.0.0.1', 'port': 8081,
                  'apiHasServiceKey': False, 'servicesStarted': False}))
