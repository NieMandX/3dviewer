"""Run before the single worker starts, after its previous process group exited."""
import json
from pathlib import Path
import shutil
import subprocess

WORK = Path('/var/lib/lpmview-checker/work')
info = json.loads(subprocess.check_output(['docker', 'info', '--format', '{{json .}}'], text=True, timeout=20))
if 'name=rootless' not in info.get('SecurityOptions', []):
    raise RuntimeError('Cleanup requires the dedicated rootless daemon')
containers = subprocess.check_output(['docker', 'ps', '-aq', '--filter', 'label=lpmview.model-checker=true'], text=True, timeout=20).split()
if containers:
    subprocess.run(['docker', 'rm', '-f', *containers], check=True, timeout=40)
for folder, prefix in ((WORK/'jobs', 'check-'), (WORK/'tmp', 'lpmview-checker-input-')):
    for path in folder.glob(prefix+'*'):
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.is_dir():
            shutil.rmtree(path)
print('checker_startup_cleanup_ok')
