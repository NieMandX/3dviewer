"""Local status probe; systemd records failures without printing credentials."""
from pathlib import Path
import shutil
import subprocess
import urllib.request

for unit in ('lpmview-checker-worker.service', 'lpmview-checker-api.service', 'user@1001.service'):
    subprocess.run(['systemctl', 'is-active', '--quiet', unit], check=True)
if shutil.disk_usage('/var/lib/lpmview-checker/work').free < 8*1024**3:
    raise RuntimeError('Checker workspace has less than 8 GiB free')
with urllib.request.urlopen('http://172.18.0.1:8081/health', timeout=10) as response:
    if response.status != 200:
        raise RuntimeError('Checker API is not healthy')
print('checker_health_ok')
