"""Root-only private staging acceptance; never run against production."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

assert os.geteuid() == 0 and os.environ.get('LPM_STAGING_PROBE') == '1'
os.umask(0o077)
lock = open('/run/lock/lpm-cloudru-migration.lock', 'a')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
root = Path('/var/backups/lpmview-migration')
run = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
name = 'lpm-voice-revocation-probe-' + run.lower()
control = Path('/var/lib/lpmview-migration') / name
control.mkdir(mode=0o755, exist_ok=False)
control.chmod(0o755)
api = 'lpmview-voice-staging-voice-api-1'
livekit = 'lpmview-voice-staging-livekit-1'
config_path = Path('/etc/lpmview-voice/livekit.json')
probe = Path('/opt/lpmview/staging/infra/voice-cloudru/probe-voice-revocation.mjs')


def command(args, timeout=30):
    return subprocess.check_output(args, stderr=subprocess.STDOUT, timeout=timeout)


def ready():
    for _ in range(60):
        result = subprocess.run(['docker', 'exec', api, 'node', '-e',
            "fetch('http://127.0.0.1:8080/healthz').then(async r=>{if(!r.ok || !(await r.json()).voiceGuard.ready)process.exit(1)}).catch(()=>process.exit(1))"],
            capture_output=True, timeout=10)
        if result.returncode == 0:
            return
        time.sleep(0.5)
    raise RuntimeError('Guard did not recover')


def records(log):
    result = []
    for line in log.splitlines():
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                result.append(value)
        except ValueError:
            pass
    return result


info = json.loads(command(['docker', 'inspect', api]))[0]
networks = list(info['NetworkSettings']['Networks'])
assert len(networks) == 1 and info['State']['Health']['Status'] == 'healthy'
assert all(b['HostIp'] == '127.0.0.1' for bindings in info['HostConfig']['PortBindings'].values() for b in bindings)
command(['docker', 'exec', api, 'node', '--input-type=module', '-e',
    "import {RoomServiceClient} from 'livekit-server-sdk';if(process.env.SUPABASE_URL!=='https://10.0.0.5:8443')process.exit(1);const c=new RoomServiceClient('http://livekit:7880',process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET);if((await c.listRooms()).length)process.exit(1)"])
original = config_path.read_bytes()
backup = root / (name + '-livekit-before.json')
with backup.open('xb') as target:
    target.write(original)
started = False
finished = False
restarted = False
result = None
try:
    config = json.loads(original)
    config['logging'] = {'level': 'info', 'json': True}
    config_path.write_text(json.dumps(config) + '\n')
    command(['docker', 'restart', livekit], timeout=45)
    ready()
    command(['docker', 'run', '-d', '--name', name, '--network', networks[0],
        '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        '--memory', '256m', '--cpus', '0.5', '--pids-limit', '64',
        '--env-file', '/etc/lpmview-voice/voice-api.env', '-e', 'LPM_STAGING_PROBE=1',
        '-e', 'NODE_EXTRA_CA_CERTS=/etc/lpmview-ca/backend-root.crt',
        '-v', str(probe) + ':/probe.mjs:ro', '-v', str(control) + ':/probe-control:ro',
        '-v', '/etc/lpmview-ca/backend-root.crt:/etc/lpmview-ca/backend-root.crt:ro',
        '--entrypoint', 'node', info['Image'], '/probe.mjs'])
    started = True
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        log = command(['docker', 'logs', name])
        events = records(log)
        room_ids = {r['fixtureRoom'] for r in events if 'fixtureRoom' in r}
        server_log = command(['docker', 'logs', '--since', '5m', livekit])
        evictions = [{k: r[k] for k in ('room', 'participant', 'reason')}
            for r in records(server_log) if r.get('msg') == 'participant closing'
            and r.get('room', '').removeprefix('room:') in room_ids
            and r.get('reason') == 'SERVICE_REQUEST_REMOVE_PARTICIPANT']
        evidence = control / 'evictions.json'
        temp = control / 'evictions.tmp'
        temp.write_text(json.dumps(evictions))
        temp.chmod(0o644)
        temp.replace(evidence)
        if not restarted and any(r.get('phase') == 'restart-api-now' for r in events):
            command(['docker', 'restart', api], timeout=45)
            ready()
            (control / 'restarted').write_text('ready\n')
            (control / 'restarted').chmod(0o644)
            restarted = True
        state = json.loads(command(['docker', 'inspect', name]))[0]['State']
        if not state['Running']:
            finished = True
            result = next((r for r in reversed(events) if 'cleanupErrors' in r), None)
            assert result is not None
            result.update(apiRestarted=restarted, containerExitCode=state['ExitCode'],
                recordedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                image=info['Image'], probeSha256=hashlib.sha256(probe.read_bytes()).hexdigest(),
                serverEvictions=evictions)
            (root / (name + '.json')).write_text(json.dumps(result, indent=2) + '\n')
            print(json.dumps(result))
            assert result['ok'] and state['ExitCode'] == 0
            break
        time.sleep(0.5)
    assert finished, 'Probe deadline exceeded; retain the container and inspect cleanup'
finally:
    try:
        if started:
            (root / (name + '.log')).write_bytes(command(['docker', 'logs', name]))
        (root / (name + '-livekit.log')).write_bytes(command(['docker', 'logs', '--since', '5m', livekit]))
    finally:
        config_path.write_bytes(original)
        command(['docker', 'restart', livekit], timeout=45)
        ready()
        if finished:
            command(['docker', 'rm', name])
