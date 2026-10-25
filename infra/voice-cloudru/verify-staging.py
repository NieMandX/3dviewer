"""Validate effective private staging configuration without printing secrets."""
import json
import os
from pathlib import Path
import stat
import subprocess

os.chdir(Path(__file__).resolve().parent)
config = json.loads(subprocess.check_output(
    ['docker', 'compose', 'config', '--format', 'json'], text=True))
assert set(config['services']) == {'voice-api', 'livekit', 'proxy'}
checks = {}
for name, service in config['services'].items():
    assert service.get('network_mode') != 'host'
    assert service['read_only'] is True
    assert service.get('privileged', False) is False
    assert 'ALL' in service['cap_drop']
    assert service['mem_limit']
    assert service['pids_limit'] == 128
    assert all(port['host_ip'] == '127.0.0.1' for port in service['ports'])
    ids = subprocess.check_output(['docker', 'compose', 'ps', '-q', name], text=True).split()
    assert len(ids) == 1, name + ' is not running'
    container = json.loads(subprocess.check_output(['docker', 'inspect', ids[0]], text=True))[0]
    assert container['State']['Running'] is True
    assert container['State'].get('Health', {}).get('Status', 'healthy') == 'healthy'
    assert container['HostConfig']['ReadonlyRootfs'] is True
    assert container['HostConfig']['Memory'] > 0
    assert container['HostConfig']['NanoCpus'] > 0
    for bindings in container['HostConfig']['PortBindings'].values():
        assert all(binding['HostIp'] == '127.0.0.1' for binding in bindings)
    checks[name] = {'running': True, 'imageId': container['Image'],
                    'loopbackOnly': True, 'readOnly': True}
for name in ['livekit-keys.json', 'livekit.json', 'voice-api.env']:
    info = (Path('/etc/lpmview-voice') / name).stat()
    assert stat.S_IMODE(info.st_mode) == 0o600 and info.st_uid == 0
print(json.dumps({'containers': checks, 'rootOnlySecrets': True}, indent=2))
